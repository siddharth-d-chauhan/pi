/**
 * spawnAgent — the heart of the subagent system.
 *
 * Resolves a child AgentSession from a definition + prompt, applies depth /
 * tool / spawn-policy guards, runs the child to completion, and finalizes
 * the result through the handle store (`agent://<id>`).
 *
 * All spawn policy, depth, and tool-stripping logic lives here. Child
 * sessions never inherit policy through environment variables.
 */

import { mkdirSync } from "node:fs";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import { getBackgroundProcessRegistry } from "../background-process-registry.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { AgentDefinition, AgentPermissionMode, AgentSpawnPolicy, AgentToolList } from "./definitions.ts";
import { canOmitProjectContext, isReadOnlyToolSet } from "./definitions.ts";
import { type AgentReturn, capReturn } from "./handles.ts";
import { resolveAgentModel } from "./model-roles.ts";

/** Effective per-spawn tool set after applying allowlist + denylist + spawn policy. */
export interface EffectiveToolSet {
	tools?: string[];
	excludeTools?: string[];
	readOnly: boolean;
}

export interface SpawnOptions {
	definition: AgentDefinition;
	/** Prompt to send to the child as its first user message. */
	prompt: string;
	/** Optional context block injected into the child system prompt under `## CONTEXT`. */
	context?: string;
	/** Parent session + lineage. */
	parent: {
		session: AgentSession;
		depth: number;
		sessionFile?: string;
	};
	/** Resolved parent agent type (for self-spawn ban). */
	parentType?: string;
	/** Parent's spawns allowlist (forwarded by the caller / tool). */
	spawns?: AgentSpawnPolicy;
	/** Model override (e.g. role alias, provider/model, or plain id). */
	modelOverride?: string;
	/** Run async and return a registry id instead of awaiting. */
	background: boolean;
	/** Display name for the registry. */
	name?: string;
	/** Caller-supplied abort signal. */
	signal?: AbortSignal;
	/**
	 * Called with the registry id as soon as the spawn is registered, before
	 * any awaiting. Lets the caller (the agent tool) track live progress for
	 * its streaming UI.
	 */
	onRegistered?: (registryId: string) => void;
	/**
	 * Optional seam for callers that want to drive the child themselves
	 * (e.g. tests, alternative runtimes). When provided, `spawnAgent`
	 * does NOT create a child session — the caller must implement the
	 * contract documented on {@link SpawnDeps.createChildSession}.
	 */
	createChildSession?: SpawnDeps["createChildSession"];
	/** Override the persist decision (factory contract). */
	persistOverride?: boolean;
}

export interface SpawnUsage {
	tokens: number;
	costUsd: number;
	requests: number;
	durationMs: number;
}

export interface SpawnResult {
	status: "completed" | "failed" | "cancelled";
	inline: string;
	handle?: string;
	usage: SpawnUsage;
	sessionFile?: string;
	registryId: string;
	artifactId?: string;
}

/**
 * Dependency bag. In production the default factory wraps
 * `createAgentSession` from `core/sdk.ts` and is injected by the tool.
 * Tests pass a custom factory to avoid the full session bootstrap.
 */
export interface SpawnDeps {
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	artifactDir: string;
	inlineCapChars?: number;
	/**
	 * Construct the child AgentSession. Implementations MUST:
	 *   - apply the provided `tools` as the allowlist,
	 *   - apply `excludeTools` as a denylist,
	 *   - use the parent-derived `customPrompt` and `omitProjectContext`,
	 *   - persist when `persist` is true and write a `parentSession` header
	 *     pointing at `parentSessionFile`,
	 *   - return the session and a way to retrieve its session file path.
	 */
	createChildSession: (input: CreateChildSessionInput) => Promise<CreateChildSessionResult>;
}

export interface CreateChildSessionInput {
	cwd: string;
	agentDir: string;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	customPrompt?: string;
	omitProjectContext?: boolean;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	signal?: AbortSignal;
	persist?: boolean;
	parentSessionFile?: string;
	subagentDepth: number;
	subagentType: string;
	subagentSpawns?: AgentSpawnPolicy;
}

export interface CreateChildSessionResult {
	session: AgentSession;
	sessionFile?: string;
	dispose: () => void;
}

/** Per-settings-manager concurrency semaphore. Re-read each spawn. */
class Semaphore {
	#active = 0;
	#waiters: Array<() => void> = [];
	readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	async acquire(signal?: AbortSignal): Promise<void> {
		if (this.#active < this.max) {
			this.#active++;
			return;
		}
		return new Promise<void>((resolve, reject) => {
			const advance = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				const idx = this.#waiters.indexOf(advance);
				if (idx !== -1) this.#waiters.splice(idx, 1);
				reject(new Error("Spawn aborted while waiting on concurrency semaphore"));
			};
			this.#waiters.push(advance);
			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}
		});
	}

	release(): void {
		this.#active = Math.max(0, this.#active - 1);
		const next = this.#waiters.shift();
		if (next) {
			this.#active++;
			next();
		}
	}
}

const semaphores = new WeakMap<SettingsManager, Semaphore>();
function getSemaphore(settings: SettingsManager): Semaphore {
	const max = Math.max(1, settings.getAgentSettings().maxConcurrency ?? 8);
	const cached = semaphores.get(settings);
	if (cached && cached.max === max) return cached;
	const fresh = new Semaphore(max);
	semaphores.set(settings, fresh);
	return fresh;
}

/** Tracks in-flight spawns per agent type. The reservation is held for the
 *  lifetime of the spawn and is what makes the isolation gate race-free. */
const inFlightByType = new Map<string, number>();

interface Reservation {
	agentType: string;
	released: boolean;
}

function tryReserveSpawn(agentType: string): Reservation {
	const next = (inFlightByType.get(agentType) ?? 0) + 1;
	inFlightByType.set(agentType, next);
	return { agentType, released: false };
}

function releaseReservation(reservation: Reservation): void {
	if (reservation.released) return;
	reservation.released = true;
	const current = inFlightByType.get(reservation.agentType) ?? 0;
	if (current <= 1) {
		inFlightByType.delete(reservation.agentType);
	} else {
		inFlightByType.set(reservation.agentType, current - 1);
	}
}

function hasConcurrentActiveSpawn(_settings: SettingsManager, agentType: string): boolean {
	// The current spawn is already in the counter; only flag other in-flight
	// spawns of the same type as concurrent.
	if ((inFlightByType.get(agentType) ?? 0) > 1) return true;
	const reg = getBackgroundProcessRegistry();
	return reg.list().some((entry) => entry.kind === "subagent" && entry.status === "running");
}

/**
 * Spawn a subagent. Always returns a SpawnResult; the actual child run
 * may still be in flight when `background: true`.
 */
export async function spawnAgent(opts: SpawnOptions, deps: SpawnDeps): Promise<SpawnResult> {
	const { definition, parent, background, name, signal, modelOverride, prompt, context } = opts;
	const settings = deps.settingsManager;
	const agentSettings = settings.getAgentSettings();
	const runAbortController = new AbortController();
	const abortFromParent = () => runAbortController.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) {
			abortFromParent();
		} else {
			signal.addEventListener("abort", abortFromParent, { once: true });
		}
	}

	// Reserve the in-flight slot synchronously so parallel Promise.all
	// spawns see a coherent concurrent count for the isolation gate.
	const reservation = tryReserveSpawn(definition.name);

	// ----- Guards (rollback on throw) -------------------------------------
	if (agentSettings.disabled?.includes(definition.name)) {
		releaseReservation(reservation);
		throw new Error(`Agent type "${definition.name}" is disabled in settings.`);
	}
	if (parent.depth + 1 > (agentSettings.maxDepth ?? 2)) {
		releaseReservation(reservation);
		throw new Error(`Agent spawn depth exceeded (max ${agentSettings.maxDepth ?? 2}).`);
	}
	if (opts.parentType && opts.parentType === definition.name) {
		releaseReservation(reservation);
		throw new Error(`Agent "${definition.name}" cannot spawn itself (self-spawn is disallowed).`);
	}
	if (opts.spawns === "none") {
		releaseReservation(reservation);
		throw new Error(`Agent "${opts.parentType ?? "parent"}" has spawns: none and cannot delegate.`);
	}
	if (Array.isArray(opts.spawns) && !opts.spawns.includes(definition.name)) {
		releaseReservation(reservation);
		throw new Error(
			`Agent "${definition.name}" is not in the parent's spawns allowlist ` + `(${opts.spawns.join(", ")}).`,
		);
	}
	if (opts.parentType && opts.spawns === undefined) {
		releaseReservation(reservation);
		throw new Error(`Agent "${opts.parentType}" has no spawn policy and cannot delegate.`);
	}

	// ----- Effective tools -------------------------------------------------
	const effective = computeEffectiveTools(definition, parent.session);

	// Permission mode fail-closed for non-read-only children.
	const requestedMode = definition.permissionMode ?? "bubble";
	const permissionMode: AgentPermissionMode = effective.readOnly
		? "read-only"
		: requestedMode === "auto"
			? "bubble" // fail closed: non-read-only "auto" demotes to "bubble" (Phase 1)
			: requestedMode;
	void permissionMode; // Surfaced through customPrompt; enforcement is the runtime's job.

	// Isolation gate (race-free: reservation is already held).
	const concurrent = background || hasConcurrentActiveSpawn(settings, definition.name);
	const mutatesWorkspace = !effective.readOnly;
	if (mutatesWorkspace && concurrent && agentSettings.allowSharedWorkspaceWrites !== true) {
		releaseReservation(reservation);
		throw new Error(
			`Agent "${definition.name}" would mutate shared workspace state in parallel. ` +
				`Set "agents.allowSharedWorkspaceWrites": true or use isolation: "worktree".`,
		);
	}

	// ----- Model resolution ------------------------------------------------
	const parentModel = parent.session.agent.state.model as Model<any> | undefined;
	if (!parentModel) {
		releaseReservation(reservation);
		throw new Error("Parent session has no model selected; cannot spawn agent.");
	}
	const resolved = resolveAgentModel({
		spec: modelOverride ?? definition.model,
		agentType: definition.name,
		parent: parentModel,
		registry: deps.modelRegistry,
		settings,
	});

	// ----- System prompt composition ---------------------------------------
	const customPrompt = composeChildSystemPrompt(definition, context, permissionMode);

	const omitProjectContext = canOmitProjectContext(definition, {
		allowUserProject: agentSettings.allowOmitProjectContext === true,
	});

	// ----- Persistence decision (factory contract) -------------------------
	const persist =
		opts.persistOverride ??
		(background ? agentSettings.persistSessions !== "never" : agentSettings.persistSessions === "always");

	const parentCwd = parent.session.sessionManager.getCwd();
	const parentAgentDir = parent.session.agentDir;

	// ----- Background registry bridge --------------------------------------
	const registry = getBackgroundProcessRegistry();
	const label = name ?? `${definition.name} · ${truncateForLabel(prompt)}`;
	let childForControl: CreateChildSessionResult | undefined;
	const registryId = registry.register({
		kind: "subagent",
		label,
		summary: truncateForLabel(prompt, 200),
		agentType: definition.name,
		parentId: parent.session.sessionId,
		onKill: () => {
			runAbortController.abort();
			childForControl?.session.abort();
			registry.setStatus(registryId, "cancelled");
		},
		onSteer: (text) => {
			void childForControl?.session.steer(text);
		},
	});
	opts.onRegistered?.(registryId);

	const sem = getSemaphore(settings);

	const runPromise = (async (): Promise<SpawnResult> => {
		let acquiredSemaphore = false;
		try {
			await sem.acquire(runAbortController.signal);
			acquiredSemaphore = true;
		} catch (err) {
			releaseReservation(reservation);
			registry.setStatus(registryId, "cancelled");
			signal?.removeEventListener("abort", abortFromParent);
			throw err;
		}

		mkdirSync(deps.artifactDir, { recursive: true });

		const startedAt = Date.now();

		const childInput: CreateChildSessionInput = {
			cwd: parentCwd,
			agentDir: parentAgentDir,
			model: resolved.model,
			thinkingLevel: definition.thinkingLevel,
			tools: effective.tools,
			excludeTools: effective.excludeTools,
			customPrompt,
			omitProjectContext,
			settingsManager: settings,
			modelRegistry: deps.modelRegistry,
			signal: runAbortController.signal,
			persist,
			parentSessionFile: parent.sessionFile,
			subagentDepth: parent.depth + 1,
			subagentType: definition.name,
			subagentSpawns: definition.spawns,
		};
		let child: CreateChildSessionResult;
		try {
			child = await (opts.createChildSession ?? deps.createChildSession)(childInput);
			childForControl = child;
			registry.update(registryId, { sessionFile: child.sessionFile });
		} catch (err) {
			releaseReservation(reservation);
			registry.setStatus(registryId, "failed");
			if (acquiredSemaphore) sem.release();
			signal?.removeEventListener("abort", abortFromParent);
			throw err;
		}

		// Stream child events to the registry. Text deltas are NOT logged
		// per-delta (that floods the bounded log ring and fires a registry
		// event per token); instead the assistant's text lands once per
		// message via message_end.
		const unsubscribe = child.session.subscribe((event) => {
			if (event.type === "message_end") {
				const end = event as unknown as { message?: { role?: string; content?: unknown } };
				if (end.message?.role === "assistant") {
					const text = extractTextSnippet(end.message.content, 160);
					if (text) registry.appendLog(registryId, text);
				}
			} else if (event.type === "tool_execution_start") {
				const start = event as unknown as { toolName?: string };
				if (start.toolName) registry.appendLog(registryId, `↳ ${start.toolName}`);
			} else if (event.type === "agent_end") {
				const stats = child.session.getSessionStats();
				registry.update(registryId, {
					metrics: {
						tokens: stats.tokens.total,
						costUsd: stats.cost,
						requests: countAssistantRequests(child.session),
					},
				});
			}
		});

		// Turn-cap steering/abort.
		const turnCount = { value: 0 };
		const maxTurns = definition.maxTurns ?? 40;
		const turnUnsub = child.session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			turnCount.value += 1;
			if (turnCount.value === maxTurns) {
				void child.session.steer("Budget notice: wrap up now and return your final answer.");
			} else if (turnCount.value > maxTurns) {
				child.session.abort();
			}
		});

		try {
			await child.session.prompt(prompt);

			if (runAbortController.signal.aborted) {
				registry.setStatus(registryId, "cancelled");
				return finalizeCancelled(child, registryId, startedAt);
			}

			const lastText = child.session.getLastAssistantText()?.trim() ?? "";
			const inline = lastText.length > 0 ? lastText : "(Subagent completed but returned no output.)";

			const artifactId = `${registryId}-${Date.now().toString(36)}`;
			const capped: AgentReturn = capReturn(artifactId, inline, {
				artifactDir: deps.artifactDir,
				inlineCapChars: deps.inlineCapChars,
			});

			const stats = child.session.getSessionStats();
			registry.update(registryId, {
				metrics: {
					tokens: stats.tokens.total,
					costUsd: stats.cost,
					requests: countAssistantRequests(child.session),
				},
				resultHandle: capped.handle,
				sessionFile: child.sessionFile,
			});
			registry.setStatus(registryId, "completed");

			return {
				status: "completed",
				inline: appendUsageTrailer(
					capped.inline,
					registryId,
					stats.tokens.total,
					stats.cost,
					Date.now() - startedAt,
				),
				handle: capped.handle,
				usage: {
					tokens: stats.tokens.total,
					costUsd: stats.cost,
					requests: countAssistantRequests(child.session),
					durationMs: Date.now() - startedAt,
				},
				sessionFile: child.sessionFile,
				registryId,
				artifactId: capped.artifact ? artifactId : undefined,
			};
		} catch (err) {
			registry.setStatus(registryId, "failed");
			const partial = child.session.getLastAssistantText()?.trim();
			const stats = child.session.getSessionStats();
			registry.update(registryId, {
				metrics: {
					tokens: stats.tokens.total,
					costUsd: stats.cost,
					requests: countAssistantRequests(child.session),
				},
				sessionFile: child.sessionFile,
			});
			return {
				status: "failed",
				inline: partial
					? `${partial}\n\n[spawn failed: ${(err as Error).message}]`
					: `[spawn failed: ${(err as Error).message}]`,
				usage: {
					tokens: stats.tokens.total,
					costUsd: stats.cost,
					requests: countAssistantRequests(child.session),
					durationMs: Date.now() - startedAt,
				},
				sessionFile: child.sessionFile,
				registryId,
			};
		} finally {
			unsubscribe();
			turnUnsub();
			child.dispose();
			childForControl = undefined;
			if (acquiredSemaphore) sem.release();
			releaseReservation(reservation);
			signal?.removeEventListener("abort", abortFromParent);
		}
	})();

	if (background) {
		runPromise
			.then((result) => {
				queueBackgroundNotification(parent.session, definition.name, result);
			})
			.catch((err) => {
				const result: SpawnResult = {
					status: "failed",
					inline: `[spawn failed: ${(err as Error).message}]`,
					usage: { tokens: 0, costUsd: 0, requests: 0, durationMs: 0 },
					registryId,
				};
				registry.appendLog(registryId, `[background error: ${(err as Error).message}]`);
				registry.setStatus(registryId, "failed");
				queueBackgroundNotification(parent.session, definition.name, result);
			});
		return {
			status: "completed",
			inline: `Background agent launched: ${registryId}`,
			usage: { tokens: 0, costUsd: 0, requests: 0, durationMs: 0 },
			registryId,
		};
	}

	return runPromise;
}

function queueBackgroundNotification(parent: AgentSession, agentType: string, result: SpawnResult): void {
	const handleLine = result.handle ? `\nhandle: ${result.handle}` : "";
	const text =
		`<task-notification id="${result.registryId}" agent="${agentType}" status="${result.status}">\n` +
		`${result.inline}${handleLine}\n` +
		"</task-notification>\n\n" +
		"Do not poll for this task or duplicate its work. Use this result directly; call `agent_pull` only if the handle is needed.";
	parent
		.sendCustomMessage(
			{
				customType: "task-notification",
				content: text,
				display: true,
				details: {
					registryId: result.registryId,
					agent: agentType,
					status: result.status,
					handle: result.handle,
					usage: result.usage,
					sessionFile: result.sessionFile,
				},
			},
			{ deliverAs: "nextTurn" },
		)
		.catch((err) => {
			getBackgroundProcessRegistry().appendLog(result.registryId, `[notification error: ${(err as Error).message}]`);
		});
}

function finalizeCancelled(child: CreateChildSessionResult, registryId: string, startedAt: number): SpawnResult {
	const stats = child.session.getSessionStats();
	return {
		status: "cancelled",
		inline: "[spawn cancelled]",
		usage: {
			tokens: stats.tokens.total,
			costUsd: stats.cost,
			requests: countAssistantRequests(child.session),
			durationMs: Date.now() - startedAt,
		},
		sessionFile: child.sessionFile,
		registryId,
	};
}

function countAssistantRequests(session: AgentSession): number {
	return session.messages.filter((m) => m.role === "assistant").length;
}

function truncateForLabel(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Flatten assistant message content to a short single-line snippet for the registry log. */
function extractTextSnippet(content: unknown, max: number): string | undefined {
	if (typeof content === "string") return truncateForLabel(content, max) || undefined;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text;
			if (text) parts.push(text);
		}
	}
	const joined = parts.join(" ").trim();
	return joined ? truncateForLabel(joined, max) : undefined;
}

function appendUsageTrailer(
	inline: string,
	registryId: string,
	tokens: number,
	cost: number,
	durationMs: number,
): string {
	const seconds = (durationMs / 1000).toFixed(1);
	return `${inline}\n\n_agentId: ${registryId} — ${tokens} tok · $${cost.toFixed(4)} · ${seconds}s_`;
}

function computeEffectiveTools(definition: AgentDefinition, parent: AgentSession): EffectiveToolSet {
	const parentAllowed = parent.getActiveToolNames();
	const parentAll = new Set(parentAllowed);
	const defTools = definition.tools;
	let allow: Set<string> | undefined;
	if (defTools === "*") {
		allow = parentAll;
	} else if (Array.isArray(defTools)) {
		allow = new Set(defTools.filter((name) => parentAll.has(name)));
	}
	const deny = new Set(definition.disallowedTools ?? []);
	if (allow) {
		for (const name of [...allow]) {
			if (deny.has(name)) allow.delete(name);
		}
	}
	const readOnly = isReadOnlyToolSet(definition.tools as AgentToolList, definition.disallowedTools);

	// Read-only children cannot fan out further.
	if (readOnly && allow) {
		allow.delete("agent");
	}

	return {
		tools: allow ? [...allow] : undefined,
		excludeTools: allow ? undefined : [...deny],
		readOnly,
	};
}

function composeChildSystemPrompt(
	definition: AgentDefinition,
	context?: string,
	permissionMode?: AgentPermissionMode,
): string {
	const parts: string[] = [definition.systemPrompt.trim()];
	if (context && context.trim().length > 0) {
		parts.push(`## CONTEXT\n${context.trim()}`);
	}
	if (definition.output) {
		parts.push(
			"## OUTPUT CONTRACT\n" +
				"You MUST return a JSON object that matches the provided schema. " +
				"Call the `finish` tool (if available) or emit a final assistant message " +
				"whose content is a single JSON object matching the schema.",
		);
	}
	if (permissionMode) {
		parts.push(
			`## PERMISSION MODE\n` +
				`Your permission mode is "${permissionMode}". ` +
				(permissionMode === "read-only"
					? "You may only call read-only tools; any mutation must be requested by the parent."
					: permissionMode === "bubble"
						? "Do not perform write, execute, or network-sensitive actions unless your exposed tools allow them. If additional approval is needed, stop and ask the parent session in your final answer."
						: "Apply the parent's policy without prompting for individual actions."),
		);
	}
	return parts.join("\n\n");
}
