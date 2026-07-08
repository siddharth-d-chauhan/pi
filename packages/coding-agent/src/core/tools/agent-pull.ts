import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { pullHandle } from "../agents/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const agentPullSchema = Type.Object({
	ref: Type.String({
		description:
			"Agent artifact reference, e.g. agent://reviewer, agent://reviewer/findings.0, or agent://reviewer?q=/pattern/",
	}),
});

export type AgentPullToolInput = Static<typeof agentPullSchema>;

export interface AgentPullToolDetails {
	ref: string;
}

function getArtifactDir(agentDir: string): string {
	return join(agentDir, "artifacts");
}

export function createAgentPullToolDefinition(
	_cwd: string,
	agentDir: string,
): ToolDefinition<typeof agentPullSchema, AgentPullToolDetails> {
	return {
		name: "agent_pull",
		label: "agent pull",
		description:
			"Read a spilled subagent result by agent:// handle. Use this to pull full output, JSON subpaths, or regex windows without bloating context.",
		promptSnippet: "Recover subagent artifact output by agent:// handle",
		parameters: agentPullSchema,
		async execute(_toolCallId, args: AgentPullToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			const text = pullHandle(args.ref, { artifactDir: getArtifactDir(agentDir) });
			return {
				content: [{ type: "text", text }],
				details: { ref: args.ref },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.bold("agent_pull")} ${args.ref}`);
			return text;
		},
		renderResult(result, _options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			text.setText(output);
			return text;
		},
	};
}

export function createAgentPullTool(cwd: string, agentDir: string): AgentTool<typeof agentPullSchema> {
	return wrapToolDefinition(createAgentPullToolDefinition(cwd, agentDir));
}
