import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../agent-session.ts";
import type { AgentDefinition } from "../agents/definitions.ts";
import { formatAgentDefinitionsForPrompt, loadAgentDefinitions, spawnAgent } from "../agents/index.ts";
import type { CreateChildSessionInput, CreateChildSessionResult, SpawnDeps } from "../agents/spawn.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { getDefaultSessionDir, SessionManager } from "../session-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const agentTaskSchema = Type.Object({
	/** Agent type to invoke (case-insensitive; matches the agent `name`). */
	agent: Type.String({ description: "Name of the agent type to spawn." }),
	/** Prompt to send to the child. */
	prompt: Type.String({ description: "Goal or question to delegate to the agent." }),
	/** Optional model override (role alias, provider/model, or plain model id). */
	model: Type.Optional(Type.String({ description: "Optional model override." })),
	/** Optional context block injected under `## CONTEXT` in the child system prompt. */
	context: Type.Optional(Type.String({ description: "Structured context block." })),
	/** When true, run the agent in the background and return a registry id. */
	background: Type.Optional(Type.Boolean({ description: "Detach and return registry id." })),
	/** Display name for the registry entry. */
	name: Type.Optional(Type.String({ description: "Optional registry label." })),
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
	status: "completed" | "failed" | "cancelled";
	inline: string;
	handle?: string;
	registryId: string;
	usage: { tokens: number; costUsd: number; requests: number; durationMs: number };
	sessionFile?: string;
}

export interface AgentToolDetails {
	tasks: AgentTaskResult[];
	background: string[];
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

		const sessionManager = input.persist
			? SessionManager.create(input.cwd, getDefaultSessionDir(input.cwd, input.agentDir), {
					parentSession: input.parentSessionFile,
				})
			: SessionManager.inMemory(input.cwd);

		const { session } = await createAgentSession({
			cwd: input.cwd,
			agentDir: input.agentDir,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			tools: input.tools,
			excludeTools: input.excludeTools,
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

interface ResolvedAgentTask {
	task: Static<typeof agentTaskSchema>;
	definition: AgentDefinition;
	background: boolean;
}

export function createAgentToolDefinition(
	cwd: string,
	agentDir: string,
	packageAgentDirs: string[] | undefined,
	ctx: Pick<AgentToolContext, "settingsManager" | "modelRegistry" | "parentSession">,
): ToolDefinition<typeof agentToolSchema, AgentToolDetails> {
	const deps: SpawnDeps = {
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
	const initialAgentSettings = ctx.settingsManager.getAgentSettings();
	const initialDisabled = new Set(initialAgentSettings.disabled ?? []);
	const initialRegistry = loadAgentDefinitions({ cwd, agentDir, packageAgentDirs });
	const initialMaxInline = initialAgentSettings.maxInlineDefinitions ?? 12;
	const initialRoster = describeRoster(
		initialRegistry.list().filter((def) => !initialDisabled.has(def.name)),
		initialMaxInline,
	);

	return {
		name: "agent",
		label: "agent",
		description:
			"Spawn one or more subagents (sync fan-out or background). " +
			"Returns inline results for sync tasks and a registry id for background tasks. " +
			"Use `agent_pull` to recover full output via agent://<id> when inline was truncated.\n\n" +
			initialRoster,
		promptSnippet: "Delegate work to a subagent (read-only, worker, plan, reviewer, or user-defined).",
		parameters: agentToolSchema,
		async execute(_toolCallId, args: AgentToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const settings = ctx.settingsManager;
			const agentSettings = settings.getAgentSettings();
			const registry = loadAgentDefinitions({ cwd, agentDir, packageAgentDirs });
			const disabled = new Set(agentSettings.disabled ?? []);
			const maxInline = agentSettings.maxInlineDefinitions ?? 12;
			const allowed = registry.list().filter((def) => !disabled.has(def.name));
			const roster = describeRoster(allowed, maxInline);

			const resolvedTasks: ResolvedAgentTask[] = args.tasks.map((task) => {
				const definition = registry.get(task.agent);
				if (!definition) {
					throw new Error(`Unknown agent type "${task.agent}". Available agents:\n${roster}`);
				}
				if (disabled.has(definition.name)) {
					throw new Error(`Agent "${definition.name}" is disabled in settings.`);
				}
				return {
					task,
					definition,
					background: task.background ?? definition.background === true,
				};
			});

			const runOne = async ({ task, definition, background }: ResolvedAgentTask): Promise<AgentTaskResult> => {
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
						signal,
					},
					deps,
				);
				return {
					agent: definition.name,
					status: result.status,
					inline: result.inline,
					handle: result.handle,
					registryId: result.registryId,
					usage: result.usage,
					sessionFile: result.sessionFile,
				};
			};

			const backgroundIds: string[] = [];
			const results: AgentTaskResult[] = [];
			const syncTasks = resolvedTasks.filter((task) => !task.background);
			const asyncTasks = resolvedTasks.filter((task) => task.background);

			if (syncTasks.length > 0) {
				const settled = await Promise.all(syncTasks.map(runOne));
				results.push(...settled);
			}
			for (const task of asyncTasks) {
				const result = await runOne(task);
				backgroundIds.push(result.registryId);
				results.push(result);
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
		},
		renderCall(args, theme) {
			const text = new Text("", 0, 0);
			const summary = args.tasks.map((task) => `${task.agent}(${task.background ? "bg" : "sync"})`).join(", ");
			text.setText(`${theme.bold("agent")} ${summary}`);
			return text;
		},
		renderResult(result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as AgentToolDetails | undefined;
			const output = details
				? details.tasks.map((task) => `### ${task.agent} (${task.status})\n${task.inline}`).join("\n\n")
				: result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
			text.setText(output);
			return text;
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
