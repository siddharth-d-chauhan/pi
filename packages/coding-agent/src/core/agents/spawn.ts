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
import type { AgentSession, SessionStats } from "../agent-session.ts";
import { getBackgroundProcessRegistry } from "../background-process-registry.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { formatThinkingSummary, formatToolCallSummary } from "../tool-call-summary.ts";
import { removeAgentIndexEntry, saveAgentIndexEntry } from "./agent-index.ts";
import type { AgentDefinition, AgentPermissionMode, AgentSpawnPolicy, AgentToolList } from "./definitions.ts";
import { canOmitProjectContext, isReadOnlyToolSet } from "./definitions.ts";
import { type AgentReturn, capReturn } from "./handles.ts";
import { markAgentIdle, registerRunningAgent, releaseAgent } from "./lifecycle.ts";
import { agentMemoryFilePath, formatMemorySection, loadAgentMemory } from "./memory.ts";
import { resolveAgentModel } from "./model-roles.ts";
import { deliverAgentNotification } from "./notifications.ts";
import { enforceAgentRunBudget } from "./run-budget.ts";
import { applyTeamToRouting, getActiveTeam } from "./teams.ts";
import { type AgentWorktree, createAgentWorktree, finalizeAgentWorktree, isGitRepo } from "./worktree.ts";

function backgroundMetrics(stats: SessionStats): {
	tokens: number;
	freshTokens: number;
	cacheReadTokens: number;
	costUsd: number;
	requests: number;
} {
	return {
		tokens: stats.tokens.total,
		freshTokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
		cacheReadTokens: stats.tokens.cacheRead,
		costUsd: stats.cost,
		requests: stats.assistantMessages,
	};
}

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
	/** UI grouping key (e.g. the chain name for chain-stage spawns). */
	group?: string;
	/**
	 * One-shot helper (judges, foreach items): never adopted into the idle
	 * lifecycle and never persisted to the agent index.
	 */
	ephemeral?: boolean;
	/** Per-spawn isolation override (wins over the definition's isolation). */
	isolationOverride?: "worktree" | "none";
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
	freshTokens?: number;
	cacheReadTokens?: number;
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
	/** Reopen this session file instead of creating a new session (lifecycle revive). */
	resumeSessionFile?: string;
	/** The spawner's session — children use it for agent_message("main"). */
	parentSession?: AgentSession;
	/** This child's registry id (sender identity for A2A). */
	selfRegistryId?: string;
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
/** Count of in-flight agents that can write the shared workspace. */
let mutatingInFlight = 0;

/** Tools that only delegate to other agents and never write the workspace. */
const DELEGATION_ONLY_TOOLS = new Set(["agent", "agent_message", "chain"]);

/** Hard deadline for the optional external spawn-context provider. */
const SPAWN_CONTEXT_TIMEOUT_MS = 2_000;

interface Reservation {
	agentType: string;
	/** Counts toward the shared-workspace conflict pool. */
	mutating: boolean;
	released: boolean;
}

function tryReserveSpawn(agentType: string, mutating: boolean): Reservation {
	const next = (inFlightByType.get(agentType) ?? 0) + 1;
	inFlightByType.set(agentType, next);
	if (mutating) mutatingInFlight += 1;
	return { agentType, mutating, released: false };
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
	if (reservation.mutating) mutatingInFlight = Math.max(0, mutatingInFlight - 1);
}

function hasConcurrentActiveSpawn(_settings: SettingsManager, agentType: string, self: Reservation): boolean {
	// The current spawn is already in the counters; only flag OTHER in-flight
	// spawns — same-type runs, or anything else that writes the workspace.
	if ((inFlightByType.get(agentType) ?? 0) > 1) return true;
	return mutatingInFlight > (self.mutating ? 1 : 0);
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

	// Workspace-mutation classification happens BEFORE the reservation so the
	// reservation can carry it. Delegation tools don't touch the workspace
	// themselves — the agents they spawn re-enter the gate with their own
	// tool sets — and worktree-isolated agents write only their own checkout.
	const mutatesWorkspace = !isReadOnlyToolSet(
		Array.isArray(definition.tools)
			? definition.tools.filter((tool) => !DELEGATION_ONLY_TOOLS.has(tool.toLowerCase()))
			: definition.tools,
		definition.disallowedTools,
	);
	const effectiveIsolation = opts.isolationOverride ?? definition.isolation;

	// Reserve the in-flight slot synchronously so parallel Promise.all
	// spawns see a coherent concurrent count for the isolation gate.
	const reservation = tryReserveSpawn(definition.name, mutatesWorkspace && effectiveIsolation !== "worktree");

	// ----- Guards (rollback on throw) -------------------------------------
	const effectiveDisabled = applyTeamToRouting({
		modelOverrides: {},
		roles: {},
		disabled: agentSettings.disabled ?? [],
	}).disabled;
	if (effectiveDisabled.includes(definition.name)) {
		releaseReservation(reservation);
		throw new Error(`Agent type "${definition.name}" is disabled (settings or active team).`);
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
		throw new Error(
			`Agent "${opts.parentType ?? "parent"}" has spawns: none and cannot delegate. Remove "spawns": "none" from its definition to allow delegation.`,
		);
	}
	if (Array.isArray(opts.spawns) && !opts.spawns.includes(definition.name)) {
		releaseReservation(reservation);
		throw new Error(
			`Agent "${definition.name}" is not in the parent's spawns allowlist ` + `(${opts.spawns.join(", ")}).`,
		);
	}
	if (opts.parentType && opts.spawns === undefined) {
		releaseReservation(reservation);
		throw new Error(
			`Agent "${opts.parentType}" has no spawn policy and cannot delegate. Add a "spawns" list (or "*") to its definition to declare what it may spawn.`,
		);
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

	// Isolation gate (race-free: reservation is already held). Worktree
	// isolation exempts the spawn — the worktree IS the isolation. Only
	// OTHER write-capable agents count as conflicts: read-only scouts and
	// delegation-only coordinators running alongside never gate a writer.
	const concurrent = background || hasConcurrentActiveSpawn(settings, definition.name, reservation);
	if (
		effectiveIsolation !== "worktree" &&
		mutatesWorkspace &&
		concurrent &&
		agentSettings.allowSharedWorkspaceWrites !== true
	) {
		releaseReservation(reservation);
		throw new Error(
			`Agent "${definition.name}" would mutate shared workspace state in parallel. ` +
				`Pass isolation: "worktree" on the task, use a worktree-isolated agent definition, or set "agents.allowSharedWorkspaceWrites": true.`,
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
	let customPrompt = composeChildSystemPrompt(definition, context, permissionMode);
	{
		// Per-agent-type persistent memory (project scope wins over user).
		const canWrite =
			!effective.readOnly &&
			(effective.tools === undefined
				? !(effective.excludeTools ?? []).some((tool) => tool === "write" || tool === "edit")
				: effective.tools.some((tool) => tool === "write" || tool === "edit"));
		const parentCwdForMemory = parent.session.sessionManager.getCwd();
		const memory =
			loadAgentMemory({
				agentType: definition.name,
				scope: "project",
				cwd: parentCwdForMemory,
				agentDir: parent.session.agentDir,
			}) ??
			loadAgentMemory({
				agentType: definition.name,
				scope: "user",
				cwd: parentCwdForMemory,
				agentDir: parent.session.agentDir,
			});
		if (memory) {
			// Worktree agents write back to the REAL checkout — keep memory
			// read-only for them so nothing lands outside their sandbox.
			customPrompt += `\n\n${formatMemorySection(memory, canWrite && effectiveIsolation !== "worktree")}`;
		}

		// Team memory: one shared file the lead and every member see. The
		// roster shares the parent workspace, so shared knowledge lives with
		// the project (user scope as fallback).
		const team = getActiveTeam();
		if (team && (definition.name === "lead" || team.members[definition.name] !== undefined)) {
			const teamType = `team-${team.name}`;
			const teamCanWrite = canWrite && effectiveIsolation !== "worktree";
			const canRead =
				effective.tools === undefined
					? !(effective.excludeTools ?? []).includes("read")
					: effective.tools.includes("read");
			const teamMemoryPath = agentMemoryFilePath({
				agentType: teamType,
				scope: "project",
				cwd: parentCwdForMemory,
				agentDir: parent.session.agentDir,
			});
			const teamMemory =
				loadAgentMemory({
					agentType: teamType,
					scope: "project",
					cwd: parentCwdForMemory,
					agentDir: parent.session.agentDir,
				}) ??
				loadAgentMemory({
					agentType: teamType,
					scope: "user",
					cwd: parentCwdForMemory,
					agentDir: parent.session.agentDir,
				});
			if (teamMemory) {
				customPrompt += `\n\n${formatMemorySection(teamMemory, teamCanWrite, {
					title: "## TEAM MEMORY (shared)",
					tag: "team-memory",
					intro: `Shared notes for team "${team.name}" — visible to the lead and every member.`,
				})}`;
				// The snapshot above goes stale while you work: teammates may
				// append. Any reader can poll the live file.
				if (canRead) {
					customPrompt +=
						`\nTeam memory file: ${teamMemory.filePath} — teammates may add findings while you work; ` +
						`re-read it with your read tool before finishing long tasks.`;
				}
			} else if (teamCanWrite || canRead) {
				customPrompt +=
					`\n\nTeam memory: no shared notes yet. The team's shared file is ${teamMemoryPath}` +
					(teamCanWrite
						? ` — record durable, team-relevant findings there so the lead and every member of team "${team.name}" see them.`
						: ` — check it (read tool) during long tasks; teammates may create it while you work.`);
			}

			// Teammate introductions: live roster agents this one can message
			// directly (agent_message <id>) when a quick exchange beats
			// relaying through the lead.
			const rosterNames = new Set(["lead", ...Object.keys(team.members)]);
			const teammates = getBackgroundProcessRegistry()
				.list()
				.filter(
					(snap) =>
						(snap.kind === "subagent" || snap.kind === "delegation") &&
						snap.agentType !== undefined &&
						rosterNames.has(snap.agentType) &&
						snap.agentType !== definition.name &&
						(snap.status === "running" || snap.status === "idle" || snap.status === "parked"),
				);
			if (teammates.length > 0) {
				const rows = teammates.map((snap) => `- ${snap.agentType} — id ${snap.id} (${snap.status})`);
				customPrompt +=
					`\n\n## TEAMMATES (live)\n` +
					`Team agents you can message directly with agent_message (send to the id) when a quick ` +
					`question or handoff beats relaying through the lead:\n${rows.join("\n")}`;
			}
		}
	}

	// Optional external spawn-context provider (e.g. a knowledge/context
	// broker published by an extension via globalThis). Strictly additive and
	// fail-open: errors and slow providers never delay or fail the spawn.
	// Ephemeral helpers (gate judges, foreach items) are skipped — judges must
	// stay fresh-eyes.
	if (!opts.ephemeral) {
		const provider = (globalThis as Record<string, unknown>).__pi_spawn_context__;
		if (typeof provider === "function") {
			try {
				const extra = await Promise.race([
					Promise.resolve(
						(provider as (input: { childType: string; brief: string; cwd: string }) => Promise<unknown>)({
							childType: definition.name,
							brief: prompt.slice(0, 500),
							cwd: parent.session.sessionManager.getCwd(),
						}),
					),
					new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SPAWN_CONTEXT_TIMEOUT_MS)),
				]);
				if (typeof extra === "string" && extra.trim().length > 0) {
					customPrompt += `\n\n${extra.trim()}`;
				}
			} catch {
				// fail-open: broker trouble must never block a spawn
			}
		}
	}

	const omitProjectContext = canOmitProjectContext(definition, {
		allowUserProject: agentSettings.allowOmitProjectContext === true,
	});

	// ----- Persistence decision (factory contract) -------------------------
	// Default "always": the lifecycle keeps every finished agent addressable
	// (idle → parked → revive), and revival needs a session file. "never"
	// opts out entirely; "background" persists only detached spawns.
	const persist =
		opts.persistOverride ??
		(agentSettings.persistSessions === "never"
			? false
			: agentSettings.persistSessions === "background"
				? background
				: true);

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
		group: opts.group,
		onKill: () => {
			runAbortController.abort();
			childForControl?.session.abort();
			releaseAgent(registryId);
			removeAgentIndexEntry(parent.session.agentDir, registryId);
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

		// Worktree isolation: the child works in a disposable git worktree.
		let worktree: AgentWorktree | undefined;
		let worktreeFinalized = false;
		if (effectiveIsolation === "worktree") {
			try {
				if (!(await isGitRepo(parentCwd))) {
					throw new Error(`isolation: "worktree" requires a git repository (cwd: ${parentCwd})`);
				}
				worktree = await createAgentWorktree(parentCwd, registryId);
				registry.appendLog(registryId, `worktree: ${worktree.path}`);
			} catch (err) {
				releaseReservation(reservation);
				registry.setStatus(registryId, "failed");
				if (acquiredSemaphore) sem.release();
				signal?.removeEventListener("abort", abortFromParent);
				throw err;
			}
		}

		const childInput: CreateChildSessionInput = {
			cwd: worktree?.path ?? parentCwd,
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
			parentSession: parent.session,
			selfRegistryId: registryId,
			subagentDepth: parent.depth + 1,
			subagentType: definition.name,
			subagentSpawns: definition.spawns,
		};
		let child: CreateChildSessionResult;
		try {
			child = await (opts.createChildSession ?? deps.createChildSession)(childInput);
			childForControl = child;
			registry.update(registryId, { sessionFile: child.sessionFile });
			const factory = opts.createChildSession ?? deps.createChildSession;
			registerRunningAgent({
				registryId,
				agentType: definition.name,
				session: child.session,
				dispose: child.dispose,
				sessionFile: child.sessionFile,
				revive:
					child.sessionFile && !worktree
						? async () => {
								const revived = await factory({ ...childInput, resumeSessionFile: child.sessionFile });
								return { session: revived.session, dispose: revived.dispose };
							}
						: undefined,
				idleTtlMs: settings.getAgentSettings().idleTtlMs,
			});
		} catch (err) {
			releaseReservation(reservation);
			registry.setStatus(registryId, "failed");
			if (acquiredSemaphore) sem.release();
			signal?.removeEventListener("abort", abortFromParent);
			if (worktree) {
				try {
					await finalizeAgentWorktree(parentCwd, worktree);
				} catch {
					// Best-effort cleanup of the never-used checkout.
				}
			}
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
			} else if (event.type === "message_update") {
				const update = event.assistantMessageEvent;
				if (update.type === "thinking_end") {
					const thinking = formatThinkingSummary(update.content);
					if (thinking) registry.appendLog(registryId, `thinking: ${thinking}`);
				}
			} else if (event.type === "tool_execution_start") {
				registry.appendLog(registryId, `↳ ${formatToolCallSummary(event.toolName, event.args, childInput.cwd)}`);
			} else if (event.type === "agent_end") {
				const stats = child.session.getSessionStats();
				registry.update(registryId, {
					metrics: backgroundMetrics(stats),
				});
			}
		});

		const maxTurns = definition.maxTurns ?? 40;
		const disposeRunBudget = enforceAgentRunBudget(child.session, { maxTurns });

		let adopted = false;
		try {
			await child.session.prompt(prompt);

			if (runAbortController.signal.aborted) {
				registry.setStatus(registryId, "cancelled");
				return finalizeCancelled(child, registryId, startedAt);
			}

			const lastText = child.session.getLastAssistantText()?.trim() ?? "";
			let inline = lastText.length > 0 ? lastText : "(Subagent completed but returned no output.)";
			if (worktree) {
				try {
					const outcome = await finalizeAgentWorktree(parentCwd, worktree);
					worktreeFinalized = true;
					if (outcome.kept) {
						inline += `\n\n[worktree kept: ${outcome.path} — branch ${outcome.branch}, ${outcome.changedFiles} file(s) changed. Merge with \`git merge ${outcome.branch}\` or cherry-pick.]`;
						registry.update(registryId, {
							summary: `changes kept in ${outcome.path} (branch ${outcome.branch})`,
						});
						registry.appendLog(registryId, `worktree kept: ${outcome.path}`);
					} else {
						inline += "\n\n[worktree removed — the agent made no changes]";
						registry.appendLog(registryId, "worktree removed (no changes)");
					}
				} catch (err) {
					registry.appendLog(registryId, `[worktree finalize error: ${(err as Error).message}]`);
				}
			}

			const artifactId = `${registryId}-${Date.now().toString(36)}`;
			const capped: AgentReturn = capReturn(artifactId, inline, {
				artifactDir: deps.artifactDir,
				inlineCapChars: deps.inlineCapChars,
			});

			const stats = child.session.getSessionStats();
			registry.update(registryId, {
				metrics: backgroundMetrics(stats),
				resultHandle: capped.handle,
				sessionFile: child.sessionFile,
			});
			// Worktree children are never adopted (a clean finalize removes
			// their checkout); ephemeral helpers (judges, foreach items) are
			// one-shots that must not pile up as idle agents.
			adopted = worktree || opts.ephemeral ? false : markAgentIdle(registryId);
			if (!adopted) registry.setStatus(registryId, "completed");
			if (adopted && child.sessionFile) {
				// Persist for cold revival after a pi restart.
				saveAgentIndexEntry(parent.session.agentDir, {
					registryId,
					agentType: definition.name,
					label,
					sessionFile: child.sessionFile,
					parentSessionFile: parent.sessionFile,
					subagentDepth: parent.depth + 1,
					tools: effective.tools,
					excludeTools: effective.excludeTools,
					customPrompt,
					omitProjectContext,
					spawns: definition.spawns,
					thinkingLevel: definition.thinkingLevel,
					modelProvider: resolved.model.provider,
					modelId: resolved.model.id,
					savedAt: Date.now(),
				});
			}

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
					freshTokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
					cacheReadTokens: stats.tokens.cacheRead,
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
				metrics: backgroundMetrics(stats),
				sessionFile: child.sessionFile,
			});
			return {
				status: "failed",
				inline: partial
					? `${partial}\n\n[spawn failed: ${(err as Error).message}]`
					: `[spawn failed: ${(err as Error).message}]`,
				usage: {
					tokens: stats.tokens.total,
					freshTokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
					cacheReadTokens: stats.tokens.cacheRead,
					costUsd: stats.cost,
					requests: countAssistantRequests(child.session),
					durationMs: Date.now() - startedAt,
				},
				sessionFile: child.sessionFile,
				registryId,
			};
		} finally {
			unsubscribe();
			disposeRunBudget();
			if (!adopted) {
				child.dispose();
				releaseAgent(registryId);
			}
			if (worktree && !worktreeFinalized) {
				try {
					const outcome = await finalizeAgentWorktree(parentCwd, worktree);
					registry.appendLog(
						registryId,
						outcome.kept
							? `worktree kept: ${outcome.path} (branch ${outcome.branch}, ${outcome.changedFiles} changed)`
							: "worktree removed (no changes)",
					);
				} catch {
					// Worktree cleanup is best-effort; never mask the run result.
				}
			}
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
	deliverAgentNotification(parent, {
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
	}).catch((err) => {
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
			freshTokens: stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
			cacheReadTokens: stats.tokens.cacheRead,
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
	const parts: string[] = [
		definition.systemPrompt.trim(),
		"## DELEGATION BOUNDARY\n" +
			"The user message for this run is your complete goal. Work only inside that goal and its stated scope. " +
			"Do not expand into adjacent cleanup, architecture, or unrelated defects. Prefer the smallest evidence set and change set that can verify the requested outcome. " +
			"Conclude as soon as the goal's success criteria are satisfied or a concrete blocker is proven; report out-of-scope observations without investigating them.",
	];
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
