import { join } from "node:path";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { AgentSession } from "../agent-session.ts";
import { coldAgentsForParent, removeAgentIndexEntry } from "../agents/agent-index.ts";
import type { AgentDefinition, AgentSpawnPolicy } from "../agents/definitions.ts";
import {
	applyTeamToDefinitions,
	formatAgentDefinitionsForPrompt,
	loadAgentDefinitions,
	spawnAgent,
} from "../agents/index.ts";
import { deliverToAgent, registerParkedAgent, releaseAgent } from "../agents/lifecycle.ts";
import type { CreateChildSessionInput, CreateChildSessionResult, SpawnDeps } from "../agents/spawn.ts";
import { getBackgroundProcessRegistry, sanitizeLogLine } from "../background-process-registry.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { getDefaultSessionDir, SessionManager } from "../session-manager.ts";
import { createAgentMessageToolDefinition } from "./agent-message.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const agentTaskSchema = Type.Object({
	/** Agent type to invoke (case-insensitive; matches the agent `name`). */
	agent: Type.String({ description: "Name of the agent type to spawn." }),
	/** Prompt to send to the child. */
	prompt: Type.String({
		description: "One bounded goal to delegate, including its success criteria and relevant scope limits.",
	}),
	/** Optional model override (role alias, provider/model, or plain model id). */
	model: Type.Optional(Type.String({ description: "Optional model override." })),
	/** Optional reasoning-effort (thinking level) override for this task.
	 *  Compact enum form — this schema ships in every request. */
	effort: Type.Optional(
		Type.Unsafe<ThinkingLevel>({
			type: "string",
			enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
			description: "Reasoning effort override.",
		}),
	),
	/** Optional context block injected under `## CONTEXT` in the child system prompt. */
	context: Type.Optional(Type.String({ description: "Structured context block." })),
	/** When true, run the agent in the background and return a registry id. */
	background: Type.Optional(Type.Boolean({ description: "Detach and return registry id." })),
	/** Display name for the registry entry. */
	name: Type.Optional(Type.String({ description: "Optional registry label." })),
	/** Run this task in a disposable git worktree (safe parallel writes). */
	isolation: Type.Optional(
		Type.Literal("worktree", {
			description: "Isolate in a disposable git worktree — required for parallel write-capable tasks.",
		}),
	),
});

const agentToolSchema = Type.Object({
	tasks: Type.Array(agentTaskSchema, {
		minItems: 1,
		description: "One or more subagent tasks to run (parallel for sync, mixed for background).",
	}),
});

export type AgentToolInput = Static<typeof agentToolSchema>;

export interface AgentTaskResult {
	agent: string;
	status: "running" | "completed" | "failed" | "cancelled";
	inline: string;
	handle?: string;
	registryId: string;
	usage: {
		tokens: number;
		freshTokens?: number;
		cacheReadTokens?: number;
		costUsd: number;
		requests: number;
		durationMs: number;
	};
	sessionFile?: string;
	/** Latest activity line (tool name / text snippet) while running. */
	activity?: string;
	/** UI-only: short prompt gist for the card header. */
	gist?: string;
}

export interface AgentToolDetails {
	tasks: AgentTaskResult[];
	background: string[];
	/** True on streaming partial frames (renderers show live rows). */
	live?: boolean;
}

interface AgentToolContext {
	cwd: string;
	agentDir: string;
	settingsManager: AgentSession["settingsManager"];
	modelRegistry: AgentSession["modelRegistry"];
	parentSession: AgentSession;
	packageAgentDirs?: string[];
}

function getArtifactDir(agentDir: string): string {
	return join(agentDir, "artifacts");
}

/** Default factory: builds a real child AgentSession via `createAgentSession`
 *  with a custom ResourceLoader that honors `omitProjectContext` and a custom
 *  SessionManager that writes a `parentSession` header when persistence is on. */
function defaultCreateChildSessionFactory(_ctx: AgentToolContext) {
	return async (input: CreateChildSessionInput): Promise<CreateChildSessionResult> => {
		const resourceLoader = new DefaultResourceLoader({
			cwd: input.cwd,
			agentDir: input.agentDir,
			settingsManager: input.settingsManager,
			noExtensions: true,
			noContextFiles: input.omitProjectContext === true,
		});
		await resourceLoader.reload();

		const sessionManager = input.resumeSessionFile
			? SessionManager.open(input.resumeSessionFile, getDefaultSessionDir(input.cwd, input.agentDir))
			: input.persist
				? SessionManager.create(input.cwd, getDefaultSessionDir(input.cwd, input.agentDir), {
						parentSession: input.parentSessionFile,
					})
				: SessionManager.inMemory(input.cwd);

		const customTools: ToolDefinition<any, any>[] =
			input.parentSession && input.selfRegistryId
				? [
						createAgentMessageToolDefinition({
							selfLabel: `${input.subagentType}(${input.selfRegistryId})`,
							parentSession: input.parentSession,
							selfRegistryId: input.selfRegistryId,
						}),
					]
				: [];

		const { session } = await createAgentSession({
			cwd: input.cwd,
			agentDir: input.agentDir,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			tools: input.tools ? [...input.tools, "agent_message"] : input.tools,
			excludeTools: input.excludeTools,
			customTools,
			settingsManager: input.settingsManager,
			modelRegistry: input.modelRegistry,
			customPrompt: input.customPrompt,
			subagentDepth: input.subagentDepth,
			subagentType: input.subagentType,
			subagentSpawns: input.subagentSpawns,
			resourceLoader,
			sessionManager,
		});

		return {
			session,
			sessionFile: sessionManager.getSessionFile?.() ?? undefined,
			dispose: () => session.dispose(),
		};
	};
}

function describeRoster(definitions: AgentDefinition[], limit: number): string {
	if (definitions.length === 0) {
		return "No subagents are available. Use `agent_list` to inspect definitions.";
	}
	return formatAgentDefinitionsForPrompt(definitions, limit);
}

// ---------------------------------------------------------------------------
// TUI rendering — a live card, not a wall of markdown.
// ---------------------------------------------------------------------------

/** Lines of a task body shown when collapsed; beyond this a ctrl+o hint appears. */
const CARD_COLLAPSE_LINES = 12;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function gistOf(prompt: string): string {
	const flat = prompt.replace(/\s+/g, " ").trim();
	return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	return `${(tokens / 1000).toFixed(1)}k`;
}

/** Shared elapsed formatter (also used by the chain card). */
export function formatElapsed(durationMs: number): string {
	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

/** Drop the model-facing `_agentId: …_` trailer from a task body — the card renders its own metrics row. */
function stripUsageTrailer(inline: string): string {
	return inline.replace(/\n*_agentId: [^\n]*_\s*$/, "").trim();
}

/** Exported for tests and headless render probes. */
export function formatAgentCall(args: AgentToolInput | undefined, theme: Theme): string {
	const title = theme.fg("toolTitle", theme.bold("agent"));
	// Args stream in — `tasks` may be missing/partial mid-stream.
	if (!args?.tasks || args.tasks.length === 0 || args.tasks.some((task) => !task || typeof task.agent !== "string")) {
		return title;
	}
	if (args.tasks.length === 1) {
		const task = args.tasks[0];
		const marker = task.background ? theme.fg("muted", " (background)") : "";
		const promptGist = typeof task.prompt === "string" ? gistOf(task.prompt) : "";
		return `${title} ${theme.fg("accent", task.agent)}${marker} ${theme.fg("dim", promptGist)}`;
	}
	const names = args.tasks
		.map((task) => `${theme.fg("accent", task.agent)}${task.background ? theme.fg("muted", "⁺") : ""}`)
		.join(theme.fg("dim", ", "));
	return `${title} ${theme.fg("dim", `${args.tasks.length} tasks:`)} ${names}`;
}

function statusGlyph(task: AgentTaskResult, theme: Theme): string {
	switch (task.status) {
		case "running":
			return theme.fg("accent", "▶");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("warning", "⊘");
	}
}

function formatMetrics(task: AgentTaskResult, theme: Theme): string {
	const parts: string[] = [];
	if (task.usage.freshTokens) parts.push(`${formatTokens(task.usage.freshTokens)} fresh`);
	if (task.usage.cacheReadTokens) parts.push(`${formatTokens(task.usage.cacheReadTokens)} cached`);
	if (!task.usage.freshTokens && !task.usage.cacheReadTokens && task.usage.tokens > 0) {
		parts.push(`${formatTokens(task.usage.tokens)} tok`);
	}
	if (task.usage.costUsd > 0) parts.push(`$${task.usage.costUsd.toFixed(4)}`);
	if (task.usage.durationMs > 0) parts.push(formatElapsed(task.usage.durationMs));
	return parts.length > 0 ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
}

function formatTaskHeader(task: AgentTaskResult, isBackground: boolean, theme: Theme): string {
	const glyph = statusGlyph(task, theme);
	const name = theme.fg("accent", theme.bold(task.agent));
	const gist = task.gist ? theme.fg("dim", ` ${task.gist}`) : "";
	if (isBackground) {
		const id = task.registryId ? theme.fg("muted", ` ${task.registryId}`) : "";
		return `${glyph} ${name}${gist} ${theme.fg("muted", "· background")}${id} ${theme.fg("dim", "— result arrives as a notification")}`;
	}
	if (task.status === "running") {
		// Registry tool-start lines already carry the `↳ ` prefix.
		const raw = task.activity;
		const activity = raw ? theme.fg("dim", raw.startsWith("↳") ? ` ${raw}` : ` ↳ ${raw}`) : "";
		return `${glyph} ${name}${gist}${formatMetrics(task, theme)}${activity}`;
	}
	const statusText = task.status === "completed" ? "" : theme.fg("error", ` · ${task.status}`);
	return `${glyph} ${name}${statusText}${formatMetrics(task, theme)}`;
}

function formatTaskBody(task: AgentTaskResult, options: ToolRenderResultOptions, theme: Theme): string[] {
	const body = stripUsageTrailer(task.inline);
	if (!body) return [];
	let lines = body.split("\n");
	let hint: string | undefined;
	if (!options.expanded && lines.length > CARD_COLLAPSE_LINES) {
		const hidden = lines.length - CARD_COLLAPSE_LINES;
		lines = lines.slice(0, CARD_COLLAPSE_LINES);
		hint = theme.fg(
			"muted",
			`… ${hidden} more line${hidden === 1 ? "" : "s"} (${theme.fg("accent", "ctrl+o")} to expand)`,
		);
	}
	const color = task.status === "failed" ? "error" : "toolOutput";
	const out = lines.map((line) => `  ${theme.fg(color, line)}`);
	if (hint) out.push(`  ${hint}`);
	if (task.handle) {
		out.push(`  ${theme.fg("dim", `⤷ full output: ${task.handle} (agent_pull)`)}`);
	}
	return out;
}

/** Exported for tests and headless render probes. */
export function formatAgentCard(details: AgentToolDetails, options: ToolRenderResultOptions, theme: Theme): string {
	const backgroundIds = new Set(details.background);
	const blocks: string[] = [];
	for (const task of details.tasks) {
		const isBackground = task.registryId !== "" && backgroundIds.has(task.registryId);
		const lines = [formatTaskHeader(task, isBackground, theme)];
		if (!isBackground && task.status !== "running") {
			lines.push(...formatTaskBody(task, options, theme));
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n");
}

/**
 * Width-aware card component: a rounded-border box (omp-style) instead of
 * the default background-block shell (the tool sets `renderShell: "self"`).
 * One instance per tool call, shared between renderCall and renderResult
 * through the render context's `state`.
 */
export class AgentToolCard implements Component {
	private theme: Theme;
	private args: AgentToolInput | undefined;
	private details: AgentToolDetails | undefined;
	private options: ToolRenderResultOptions = { expanded: false, isPartial: true };
	private isError = false;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	setArgs(args: AgentToolInput): void {
		this.args = args;
	}

	setResult(details: AgentToolDetails | undefined, options: ToolRenderResultOptions, isError: boolean): void {
		this.details = details;
		this.options = options;
		this.isError = isError;
	}

	invalidate(): void {}

	render(width: number): string[] {
		try {
			return this.renderCard(width);
		} catch {
			// A render throw here would crash the TUI (renderShell: "self"
			// runs outside the renderer try/catch). Fall back to a title row.
			return [truncateToWidth(this.theme.fg("toolTitle", this.theme.bold("agent")), Math.max(1, width), "…")];
		}
	}

	private renderCard(width: number): string[] {
		const theme = this.theme;
		let title = formatAgentCall(this.args, theme);
		if (this.options.isPartial) {
			// Time-derived spinner: advances on the re-renders streaming
			// already causes (live task updates arrive ~150ms apart), no timer.
			title = `${theme.fg("accent", SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length])} ${title}`;
		}
		const body = this.details ? formatAgentCard(this.details, this.options, theme).split("\n") : [];
		if (width < 24) {
			return [truncateToWidth(title, width, "…"), ...body.map((line) => truncateToWidth(line, width, "…"))];
		}

		const pulse = this.options.isPartial && Math.floor(Date.now() / 500) % 2 === 1;
		const borderColor = this.isError ? "error" : this.options.isPartial ? (pulse ? "dim" : "accent") : "dim";
		const edge = (text: string) => theme.fg(borderColor, text);
		const inner = width - 4;
		const lines: string[] = [];

		const titleClipped = truncateToWidth(title, inner - 2, "…");
		const fill = Math.max(0, inner - visibleWidth(titleClipped) - 1);
		lines.push(`${edge("╭─")} ${titleClipped} ${edge("─".repeat(fill))}${edge("╮")}`);
		for (const raw of body) {
			const clipped = truncateToWidth(raw, inner, "…");
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
			lines.push(`${edge("│")} ${clipped}${pad} ${edge("│")}`);
		}
		lines.push(edge(`╰${"─".repeat(width - 2)}╯`));
		return lines;
	}
}

/** Zero-height component: renderResult mutates the shared card instead of adding output. */
const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate() {},
};

interface ResolvedAgentTask {
	task: Static<typeof agentTaskSchema>;
	definition: AgentDefinition;
	background: boolean;
}

/** Build the production SpawnDeps bag (shared by the agent and chain tools). */
export function createDefaultSpawnDeps(
	cwd: string,
	agentDir: string,
	packageAgentDirs: string[] | undefined,
	ctx: Pick<AgentToolContext, "settingsManager" | "modelRegistry" | "parentSession">,
): SpawnDeps {
	return {
		settingsManager: ctx.settingsManager,
		modelRegistry: ctx.modelRegistry,
		artifactDir: getArtifactDir(agentDir),
		inlineCapChars: 4_000,
		createChildSession: defaultCreateChildSessionFactory({
			cwd,
			agentDir,
			settingsManager: ctx.settingsManager,
			modelRegistry: ctx.modelRegistry,
			parentSession: ctx.parentSession,
			packageAgentDirs,
		}),
	};
}

export function createAgentToolDefinition(
	cwd: string,
	agentDir: string,
	packageAgentDirs: string[] | undefined,
	ctx: Pick<AgentToolContext, "settingsManager" | "modelRegistry" | "parentSession">,
): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	const deps: SpawnDeps = createDefaultSpawnDeps(cwd, agentDir, packageAgentDirs, ctx);
	const initialAgentSettings = ctx.settingsManager.getAgentSettings();
	const initialDisabled = new Set(initialAgentSettings.disabled ?? []);
	const initialRegistry = applyTeamToDefinitions(loadAgentDefinitions({ cwd, agentDir, packageAgentDirs }));
	const initialMaxInline = initialAgentSettings.maxInlineDefinitions ?? 12;
	const initialRoster = describeRoster(
		initialRegistry.list().filter((def) => !initialDisabled.has(def.name)),
		initialMaxInline,
	);

	return {
		name: "agent",
		label: "agent",
		description:
			"Spawn one or more subagents (sync fan-out or background). Each task may set its own " +
			"`model` (any provider/model or role alias) and `effort` (off|minimal|low|medium|high|xhigh|max) — " +
			"e.g. a cheap fast model at low effort for scouting, a strong model at high effort for hard work. " +
			"Returns inline results for sync tasks and a registry id for background tasks. " +
			"Use `agent_pull` to recover full output via agent://<id> when inline was truncated.\n\n" +
			initialRoster,
		promptSnippet: "Delegate work to a subagent (read-only, worker, plan, reviewer, or user-defined).",
		parameters: agentToolSchema,
		async execute(_toolCallId, args: AgentToolInput, signal?: AbortSignal, onUpdate?) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const settings = ctx.settingsManager;
			const agentSettings = settings.getAgentSettings();
			const registry = applyTeamToDefinitions(loadAgentDefinitions({ cwd, agentDir, packageAgentDirs }));
			const disabled = new Set(agentSettings.disabled ?? []);
			const maxInline = agentSettings.maxInlineDefinitions ?? 12;
			const allowed = registry.list().filter((def) => !disabled.has(def.name));
			const roster = describeRoster(allowed, maxInline);

			const resolvedTasks: ResolvedAgentTask[] = args.tasks.map((task) => {
				const baseDefinition = registry.get(task.agent);
				if (!baseDefinition) {
					throw new Error(`Unknown agent type "${task.agent}". Available agents:\n${roster}`);
				}
				if (disabled.has(baseDefinition.name)) {
					throw new Error(
						`Agent "${baseDefinition.name}" is disabled (settings "agents.disabled" or the active team — check /team, or pick another agent from the roster).`,
					);
				}
				// Per-task effort clones the definition's thinking level (model is
				// applied separately via modelOverride). Same pattern as chain stages.
				const definition = task.effort
					? { ...baseDefinition, thinkingLevel: task.effort as ThinkingLevel }
					: baseDefinition;
				return {
					task,
					definition,
					background: task.background ?? definition.background === true,
				};
			});

			// ---- Live progress: one row per task, streamed to the tool card ----
			const startedAt = resolvedTasks.map(() => Date.now());
			const live: AgentTaskResult[] = resolvedTasks.map(({ task, definition }) => ({
				agent: definition.name,
				status: "running",
				inline: "",
				registryId: "",
				usage: { tokens: 0, costUsd: 0, requests: 0, durationMs: 0 },
				gist: gistOf(task.prompt),
			}));
			const backgroundIds: string[] = [];
			const trackedIds = new Map<string, number>();
			const processRegistry = getBackgroundProcessRegistry();
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let updateDirty = false;
			const pushUpdate = (): void => {
				onUpdate?.({
					content: [{ type: "text", text: "subagents running…" }],
					details: {
						tasks: live.map((task) => ({ ...task, usage: { ...task.usage } })),
						background: [...backgroundIds],
						live: true,
					},
				});
			};
			const scheduleUpdate = (): void => {
				if (!onUpdate) return;
				updateDirty = true;
				if (updateTimer) return;
				updateTimer = setTimeout(() => {
					updateTimer = undefined;
					if (updateDirty) {
						updateDirty = false;
						pushUpdate();
					}
				}, 150);
			};
			const unsubscribe = onUpdate
				? processRegistry.subscribe((event) => {
						if (!("id" in event)) return;
						const index = trackedIds.get(event.id);
						if (index === undefined) return;
						const entry = processRegistry.get(event.id);
						const row = live[index];
						if (entry) {
							const tail = entry.log.at(-1);
							if (tail) row.activity = sanitizeLogLine(tail);
							if (entry.metrics) {
								row.usage.tokens = entry.metrics.tokens ?? row.usage.tokens;
								row.usage.freshTokens = entry.metrics.freshTokens ?? row.usage.freshTokens;
								row.usage.cacheReadTokens = entry.metrics.cacheReadTokens ?? row.usage.cacheReadTokens;
								row.usage.costUsd = entry.metrics.costUsd ?? row.usage.costUsd;
								row.usage.requests = entry.metrics.requests ?? row.usage.requests;
							}
						}
						row.usage.durationMs = Date.now() - startedAt[index];
						scheduleUpdate();
					})
				: undefined;

			const runOne = async (index: number): Promise<AgentTaskResult> => {
				const { task, definition, background } = resolvedTasks[index];
				const result = await spawnAgent(
					{
						definition,
						prompt: task.prompt,
						context: task.context,
						parent: {
							session: ctx.parentSession,
							depth: ctx.parentSession.subagentDepth,
							sessionFile: ctx.parentSession.sessionFile,
						},
						parentType: ctx.parentSession.subagentType,
						spawns: ctx.parentSession.subagentSpawns,
						modelOverride: task.model,
						background,
						name: task.name,
						isolationOverride: task.isolation,
						signal,
						onRegistered: (registryId) => {
							live[index].registryId = registryId;
							trackedIds.set(registryId, index);
							scheduleUpdate();
						},
					},
					deps,
				);
				const settled: AgentTaskResult = {
					agent: definition.name,
					status: result.status,
					inline: result.inline,
					handle: result.handle,
					registryId: result.registryId,
					usage: result.usage,
					sessionFile: result.sessionFile,
					gist: live[index].gist,
				};
				live[index] = settled;
				scheduleUpdate();
				return settled;
			};

			try {
				const results: AgentTaskResult[] = new Array(live.length);
				const syncIndices = resolvedTasks.flatMap((task, index) => (task.background ? [] : [index]));
				const asyncIndices = resolvedTasks.flatMap((task, index) => (task.background ? [index] : []));

				if (syncIndices.length > 0) {
					const settled = await Promise.all(syncIndices.map(runOne));
					syncIndices.forEach((taskIndex, i) => {
						results[taskIndex] = settled[i];
					});
				}
				for (const taskIndex of asyncIndices) {
					const result = await runOne(taskIndex);
					backgroundIds.push(result.registryId);
					results[taskIndex] = result;
				}

				return {
					content: [
						{
							type: "text",
							text: results.map((r) => `### ${r.agent} (${r.status})\n${r.inline}`).join("\n\n"),
						},
					],
					details: { tasks: results, background: backgroundIds },
				};
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
				unsubscribe?.();
			}
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as { card?: AgentToolCard };
			state.card ??= new AgentToolCard(theme);
			state.card.setArgs(args);
			return state.card;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as { card?: AgentToolCard };
			const details = result.details as AgentToolDetails | undefined;
			if (!state.card) {
				const fallback = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				return new Text(theme.fg("toolOutput", fallback), 0, 0);
			}
			state.card.setResult(details, options, context.isError);
			return EMPTY_COMPONENT;
		},
	};
}

export function createUnavailableAgentToolDefinition(): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	return {
		name: "agent",
		label: "agent",
		description: "Subagent spawning is unavailable in this tool context.",
		promptSnippet: "Subagent spawning is unavailable in this context",
		parameters: agentToolSchema,
		async execute() {
			throw new Error("agent tool requires an AgentSession context");
		},
	};
}

export interface CreateAgentToolOptions {
	cwd: string;
	agentDir?: string;
	packageAgentDirs?: string[];
	parentSession: AgentSession;
}

/**
 * Cold-revival scan: re-register this session's parked child agents from a
 * previous pi run so they show up in /agents and can be messaged (revive
 * reopens their session files). Call whenever the active session changes.
 */
export function registerColdAgents(options: CreateAgentToolOptions): number {
	const agentDir = options.agentDir ?? getAgentDir();
	const parentSessionFile = options.parentSession.sessionFile;
	const entries = coldAgentsForParent(agentDir, parentSessionFile);
	if (entries.length === 0) return 0;
	const registry = getBackgroundProcessRegistry();
	const factory = defaultCreateChildSessionFactory({
		cwd: options.cwd,
		agentDir,
		settingsManager: options.parentSession.settingsManager,
		modelRegistry: options.parentSession.modelRegistry,
		parentSession: options.parentSession,
		packageAgentDirs: options.packageAgentDirs,
	});
	let registered = 0;
	for (const entry of entries) {
		if (registry.get(entry.registryId)) continue;
		const model =
			options.parentSession.modelRegistry.find(entry.modelProvider, entry.modelId) ?? options.parentSession.model;
		if (!model) {
			removeAgentIndexEntry(agentDir, entry.registryId);
			continue;
		}
		registry.register({
			id: entry.registryId,
			kind: "subagent",
			label: entry.label,
			agentType: entry.agentType,
			parentId: options.parentSession.sessionId,
			sessionFile: entry.sessionFile,
			status: "parked",
			onKill: () => {
				releaseAgent(entry.registryId);
				removeAgentIndexEntry(agentDir, entry.registryId);
				registry.setStatus(entry.registryId, "cancelled");
			},
			onSteer: (text) => {
				void deliverToAgent(entry.registryId, text, { from: "user" });
			},
		});
		registerParkedAgent({
			registryId: entry.registryId,
			agentType: entry.agentType,
			sessionFile: entry.sessionFile,
			idleTtlMs: options.parentSession.settingsManager.getAgentSettings().idleTtlMs,
			revive: async () => {
				const revived = await factory({
					cwd: options.cwd,
					agentDir,
					model,
					tools: entry.tools,
					excludeTools: entry.excludeTools,
					customPrompt: entry.customPrompt,
					omitProjectContext: entry.omitProjectContext,
					settingsManager: options.parentSession.settingsManager,
					modelRegistry: options.parentSession.modelRegistry,
					persist: true,
					parentSessionFile: entry.parentSessionFile,
					parentSession: options.parentSession,
					selfRegistryId: entry.registryId,
					subagentDepth: entry.subagentDepth,
					subagentType: entry.agentType,
					subagentSpawns: entry.spawns as AgentSpawnPolicy | undefined,
					thinkingLevel: entry.thinkingLevel as ThinkingLevel | undefined,
					resumeSessionFile: entry.sessionFile,
				});
				return { session: revived.session, dispose: revived.dispose };
			},
		});
		registered += 1;
	}
	return registered;
}

export function createAgentTool(options: CreateAgentToolOptions): AgentTool<typeof agentToolSchema> {
	const agentDir = options.agentDir ?? getAgentDir();
	return wrapToolDefinition(
		createAgentToolDefinition(options.cwd, agentDir, options.packageAgentDirs, {
			settingsManager: options.parentSession.settingsManager,
			modelRegistry: options.parentSession.modelRegistry,
			parentSession: options.parentSession,
		}),
	);
}
