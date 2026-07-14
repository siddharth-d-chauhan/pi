export {
	type AgentTaskResult,
	type AgentToolDetails,
	type AgentToolInput,
	type CreateAgentToolOptions,
	createAgentTool,
	createAgentToolDefinition,
} from "./agent.ts";
export {
	type AgentListItem,
	type AgentListToolDetails,
	type AgentListToolInput,
	createAgentListTool,
	createAgentListToolDefinition,
} from "./agent-list.ts";
export {
	type AgentPullToolDetails,
	type AgentPullToolInput,
	createAgentPullTool,
	createAgentPullToolDefinition,
} from "./agent-pull.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	createAgentTool,
	createAgentToolDefinition,
	createDefaultSpawnDeps,
	createUnavailableAgentToolDefinition,
} from "./agent.ts";
import { createAgentListTool, createAgentListToolDefinition } from "./agent-list.ts";
import { createAgentMessageTool, createAgentMessageToolDefinition } from "./agent-message.ts";
import { createAgentPullTool, createAgentPullToolDefinition } from "./agent-pull.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createChainTool, createChainToolDefinition, createUnavailableChainToolDefinition } from "./chain.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "agent"
	| "agent_message"
	| "chain"
	| "agent_list"
	| "agent_pull";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"agent",
	"agent_message",
	"chain",
	"agent_list",
	"agent_pull",
]);
export interface ToolsOptions {
	agentList?: {
		agentDir: string;
		packageAgentDirs?: string[];
	};
	agentToolContext?: {
		cwd: string;
		agentDir?: string;
		packageAgentDirs?: string[];
		parentSession: AgentSession;
	};
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

/**
 * Merge the parent session (from agentToolContext) into bash options as the
 * background-completion host, so `run_in_background` commands can notify the
 * model when they finish. No-op when no session context is available.
 */
function bashOpts(options?: ToolsOptions): BashToolOptions | undefined {
	const host = options?.agentToolContext?.parentSession;
	if (!options?.bash && !host) return undefined;
	return { ...options?.bash, backgroundHost: options?.bash?.backgroundHost ?? host };
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, bashOpts(options));
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "agent": {
			const ctx = options?.agentToolContext;
			if (!ctx) return createUnavailableAgentToolDefinition();
			return createAgentToolDefinition(ctx.cwd, ctx.agentDir ?? getAgentDir(), ctx.packageAgentDirs, {
				settingsManager: ctx.parentSession.settingsManager,
				modelRegistry: ctx.parentSession.modelRegistry,
				parentSession: ctx.parentSession,
			});
		}
		case "chain": {
			const ctx = options?.agentToolContext;
			if (!ctx) return createUnavailableChainToolDefinition();
			const agentDir = ctx.agentDir ?? getAgentDir();
			return createChainToolDefinition({
				cwd: ctx.cwd,
				agentDir,
				packageAgentDirs: ctx.packageAgentDirs,
				parentSession: ctx.parentSession,
				spawnDeps: createDefaultSpawnDeps(ctx.cwd, agentDir, ctx.packageAgentDirs, {
					settingsManager: ctx.parentSession.settingsManager,
					modelRegistry: ctx.parentSession.modelRegistry,
					parentSession: ctx.parentSession,
				}),
			});
		}
		case "agent_message": {
			const ctx = options?.agentToolContext;
			return createAgentMessageToolDefinition({
				selfLabel: "main",
				senderSession: ctx?.parentSession,
			});
		}
		case "agent_list":
			return createAgentListToolDefinition(
				cwd,
				options?.agentList?.agentDir ??
					options?.agentToolContext?.agentDir ??
					(options?.agentToolContext ? getAgentDir() : cwd),
				options?.agentList?.packageAgentDirs ?? options?.agentToolContext?.packageAgentDirs,
			);
		case "agent_pull":
			return createAgentPullToolDefinition(cwd, options?.agentList?.agentDir ?? cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, bashOpts(options));
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "agent": {
			const ctx = options?.agentToolContext;
			return ctx ? createAgentTool(ctx) : wrapToolDefinition(createUnavailableAgentToolDefinition());
		}
		case "chain": {
			const ctx = options?.agentToolContext;
			if (!ctx) return wrapToolDefinition(createUnavailableChainToolDefinition());
			const agentDir = ctx.agentDir ?? getAgentDir();
			return createChainTool({
				cwd: ctx.cwd,
				agentDir,
				packageAgentDirs: ctx.packageAgentDirs,
				parentSession: ctx.parentSession,
				spawnDeps: createDefaultSpawnDeps(ctx.cwd, agentDir, ctx.packageAgentDirs, {
					settingsManager: ctx.parentSession.settingsManager,
					modelRegistry: ctx.parentSession.modelRegistry,
					parentSession: ctx.parentSession,
				}),
			});
		}
		case "agent_message":
			return createAgentMessageTool({
				selfLabel: "main",
				senderSession: options?.agentToolContext?.parentSession,
			});
		case "agent_list":
			return createAgentListTool(
				cwd,
				options?.agentList?.agentDir ??
					options?.agentToolContext?.agentDir ??
					(options?.agentToolContext ? getAgentDir() : cwd),
				options?.agentList?.packageAgentDirs ?? options?.agentToolContext?.packageAgentDirs,
			);
		case "agent_pull":
			return createAgentPullTool(cwd, options?.agentList?.agentDir ?? cwd);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, bashOpts(options)),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const ctx = options?.agentToolContext;
	return {
		agent_message: createAgentMessageToolDefinition({ selfLabel: "main", senderSession: ctx?.parentSession }),
		chain: createToolDefinition("chain", cwd, options),
		agent: ctx
			? createAgentToolDefinition(ctx.cwd, ctx.agentDir ?? getAgentDir(), ctx.packageAgentDirs, {
					settingsManager: ctx.parentSession.settingsManager,
					modelRegistry: ctx.parentSession.modelRegistry,
					parentSession: ctx.parentSession,
				})
			: createUnavailableAgentToolDefinition(),
		agent_list: createAgentListToolDefinition(
			cwd,
			options?.agentList?.agentDir ??
				options?.agentToolContext?.agentDir ??
				(options?.agentToolContext ? getAgentDir() : cwd),
			options?.agentList?.packageAgentDirs ?? options?.agentToolContext?.packageAgentDirs,
		),
		agent_pull: createAgentPullToolDefinition(cwd, options?.agentList?.agentDir ?? cwd),
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, bashOpts(options)),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, bashOpts(options)),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const ctx = options?.agentToolContext;
	return {
		agent_message: createAgentMessageTool({ selfLabel: "main", senderSession: ctx?.parentSession }),
		chain: createTool("chain", cwd, options),
		agent: ctx ? createAgentTool(ctx) : wrapToolDefinition(createUnavailableAgentToolDefinition()),
		agent_list: createAgentListTool(
			cwd,
			options?.agentList?.agentDir ??
				options?.agentToolContext?.agentDir ??
				(options?.agentToolContext ? getAgentDir() : cwd),
			options?.agentList?.packageAgentDirs ?? options?.agentToolContext?.packageAgentDirs,
		),
		agent_pull: createAgentPullTool(cwd, options?.agentList?.agentDir ?? cwd),
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, bashOpts(options)),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
	};
}
