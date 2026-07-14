import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AfterToolCallResult } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../agent-session.ts";

export const DEFAULT_AGENT_TOOL_CALL_LIMIT = 14;
export const DEFAULT_AGENT_SCOPE_CHECKPOINT = 8;
export const DEFAULT_AGENT_TOOL_RESULT_CHAR_LIMIT = 12_000;

type ToolResultContent = NonNullable<AfterToolCallResult["content"]>;

export function capAgentToolResultContent(
	content: ToolResultContent,
	maxChars: number,
	noticeText = "Subagent tool output truncated; middle omitted.",
): ToolResultContent {
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text.length <= maxChars) return content;

	const notice = `\n\n[${noticeText}]\n\n`;
	const contentBudget = Math.max(0, maxChars - notice.length);
	const headChars = Math.floor(contentBudget * 0.6);
	const tailChars = contentBudget - headChars;
	const cappedText = `${text.slice(0, headChars)}${notice}${text.slice(-tailChars)}`;
	let replacedText = false;
	const capped: ToolResultContent = [];
	for (const block of content) {
		if (block.type !== "text") {
			capped.push(block);
			continue;
		}
		if (replacedText) continue;
		replacedText = true;
		capped.push({ ...block, text: cappedText });
	}
	return capped;
}

function saveFullToolOutput(
	session: AgentSession,
	toolName: string,
	toolCallId: string,
	text: string,
): string | undefined {
	try {
		const directory = session.sessionFile
			? `${session.sessionFile}.tool-output`
			: join(tmpdir(), "pi-tool-output", session.sessionId);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
		const safeToolName = toolName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
		const safeToolCallId = toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
		const path = join(directory, `${safeToolName}-${safeToolCallId}-${digest}.txt`);
		writeFileSync(path, text, { mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

/**
 * Enforce one agent run's turn and tool budgets. At the tool limit, tools are
 * removed for the next turn and the model is steered to return its answer.
 * Disposing restores the original tool set so later lifecycle messages get a
 * fresh budget without permanently weakening the agent.
 */
export function enforceAgentRunBudget(
	session: AgentSession,
	options: { maxTurns: number; maxToolCalls?: number; scopeCheckpoint?: number; maxResultChars?: number },
): () => void {
	const activeTools = session.getActiveToolNames();
	const maxToolCalls = options.maxToolCalls ?? DEFAULT_AGENT_TOOL_CALL_LIMIT;
	const scopeCheckpoint = options.scopeCheckpoint ?? DEFAULT_AGENT_SCOPE_CHECKPOINT;
	const maxResultChars = options.maxResultChars ?? DEFAULT_AGENT_TOOL_RESULT_CHAR_LIMIT;
	const previousAfterToolCall = session.agent.afterToolCall;
	const budgetedAfterToolCall: NonNullable<typeof session.agent.afterToolCall> = async (context, signal) => {
		const previousPatch = await previousAfterToolCall?.(context, signal);
		const content = previousPatch?.content ?? context.result.content;
		const text = content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (text.length <= maxResultChars) return previousPatch;
		const fullOutputPath = saveFullToolOutput(session, context.toolCall.name, context.toolCall.id, text);
		const notice = fullOutputPath
			? `Subagent tool output truncated; middle omitted. Full output: ${fullOutputPath}. Search or read only the required range; do not rerun the tool.`
			: "Subagent tool output truncated; middle omitted. Refine the request instead of rerunning the same broad tool call.";
		const capped = capAgentToolResultContent(content, maxResultChars, notice);
		if (capped === content) return previousPatch;
		return previousPatch ? { ...previousPatch, content: capped } : { content: capped };
	};
	session.agent.afterToolCall = budgetedAfterToolCall;
	let toolCalls = 0;
	let turnCount = 0;
	let toolsRestricted = false;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			toolCalls += 1;
			if (toolCalls === scopeCheckpoint && scopeCheckpoint < maxToolCalls) {
				void session.steer(
					"Scope checkpoint: stay strictly inside the delegated goal. Stop broad discovery, synthesize what is already known, and use only the minimum remaining checks needed for a verified answer.",
				);
			}
			if (toolCalls === maxToolCalls) {
				toolsRestricted = true;
				session.setActiveToolsByName([]);
				void session.steer(
					"Tool budget reached. Do not request more tools; synthesize the evidence already collected and return your final answer now.",
				);
			}
			return;
		}
		if (event.type !== "turn_end") return;
		turnCount += 1;
		if (turnCount === options.maxTurns) {
			void session.steer("Turn budget reached. Return your final answer now without further investigation.");
		} else if (turnCount > options.maxTurns) {
			session.abort();
		}
	});
	return () => {
		unsubscribe();
		if (session.agent.afterToolCall === budgetedAfterToolCall) {
			session.agent.afterToolCall = previousAfterToolCall;
		}
		if (toolsRestricted) session.setActiveToolsByName(activeTools);
	};
}
