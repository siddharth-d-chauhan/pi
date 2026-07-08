import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentDefinition } from "../agents/index.ts";
import { createAgentDefinitionDisplayPath, loadAgentDefinitions } from "../agents/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const agentListSchema = Type.Object({
	q: Type.Optional(Type.String({ description: "Optional case-insensitive search over agent names and descriptions" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of agents to return (default: 20, max: 50)" })),
});

export type AgentListToolInput = Static<typeof agentListSchema>;

export interface AgentListItem {
	name: string;
	description: string;
	source: AgentDefinition["source"];
	tools?: string[] | "*";
	spawns?: string[] | "*" | "none";
	model?: string;
	background?: boolean;
	isolation?: string;
	path: string;
}

export interface AgentListToolDetails {
	agents: AgentListItem[];
	total: number;
	query?: string;
}

function clampLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 20;
	return Math.max(1, Math.min(50, Math.floor(value)));
}

function matchesQuery(definition: AgentDefinition, query: string | undefined): boolean {
	if (!query) return true;
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	return (
		definition.name.includes(normalized) ||
		definition.description.toLowerCase().includes(normalized) ||
		definition.source.toLowerCase().includes(normalized)
	);
}

function toItem(definition: AgentDefinition, cwd: string): AgentListItem {
	return {
		name: definition.name,
		description: definition.description,
		source: definition.source,
		tools: definition.tools,
		spawns: definition.spawns,
		model: definition.model,
		background: definition.background,
		isolation: definition.isolation,
		path: createAgentDefinitionDisplayPath(definition, cwd),
	};
}

function formatAgentListResult(details: AgentListToolDetails): string {
	const suffix = details.query ? ` matching "${details.query}"` : "";
	if (details.agents.length === 0) {
		return `No subagents found${suffix}.`;
	}
	const lines = [`${details.agents.length}/${details.total} subagents${suffix}:`];
	for (const agent of details.agents) {
		const model = agent.model ? ` model=${agent.model}` : "";
		const tools = agent.tools === "*" ? " tools=*" : agent.tools ? ` tools=${agent.tools.join(",")}` : "";
		lines.push(`- ${agent.name} [${agent.source}]${model}${tools}: ${agent.description}`);
	}
	return lines.join("\n");
}

export function createAgentListToolDefinition(
	cwd: string,
	agentDir: string,
	packageAgentDirs?: string[],
): ToolDefinition<typeof agentListSchema, AgentListToolDetails> {
	return {
		name: "agent_list",
		label: "agent list",
		description:
			"List available subagents and their routing descriptions. Use this when choosing a specialized worker or when the inline subagent roster is incomplete.",
		promptSnippet: "Discover available subagents without mutating the tool schema",
		parameters: agentListSchema,
		async execute(_toolCallId, args: AgentListToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const query = args.q?.trim() || undefined;
			const limit = clampLimit(args.limit);
			const registry = loadAgentDefinitions({ cwd, agentDir, packageAgentDirs });
			const matches = registry.list().filter((definition) => matchesQuery(definition, query));
			const agents = matches.slice(0, limit).map((definition) => toItem(definition, cwd));
			const text = formatAgentListResult({ agents, total: matches.length, query });
			return {
				content: [{ type: "text", text }],
				details: { agents, total: matches.length, query },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = args.q?.trim();
			text.setText(query ? `${theme.bold("agent_list")} ${query}` : theme.bold("agent_list"));
			return text;
		},
		renderResult(result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAgentListResult(result.details ?? { agents: [], total: 0 }));
			return text;
		},
	};
}

export function createAgentListTool(
	cwd: string,
	agentDir: string,
	packageAgentDirs?: string[],
): AgentTool<typeof agentListSchema> {
	return wrapToolDefinition(createAgentListToolDefinition(cwd, agentDir, packageAgentDirs));
}
