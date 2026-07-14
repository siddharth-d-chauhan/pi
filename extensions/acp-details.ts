/**
 * ACP Details Extension — fill the observability gaps between Pi's rich TUI
 * and ACP clients that render only tool names or hide thought blocks.
 *
 * RPC-only: TUI/print/json behavior remains exactly upstream-compatible.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatThinkingSummary, formatToolCallSummary } from "../packages/coding-agent/src/core/tool-call-summary.ts";

interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	startedAt: number;
}

function freshUsage(): RunUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, startedAt: Date.now() };
}

function compactNumber(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatRunSummary(usage: RunUsage): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const cachePct = prompt > 0 ? (usage.cacheRead / prompt) * 100 : 0;
	const seconds = (Date.now() - usage.startedAt) / 1000;
	return (
		`run complete: ${usage.turns} model turn${usage.turns === 1 ? "" : "s"}` +
		` | in ${compactNumber(usage.input)} | out ${compactNumber(usage.output)}` +
		` | cache ${cachePct.toFixed(1)}% | $${usage.cost.toFixed(4)} | ${seconds.toFixed(1)}s`
	);
}

export default function (pi: ExtensionAPI) {
	let run = freshUsage();

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode === "rpc") run = freshUsage();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.mode !== "rpc") return;
		ctx.ui.notify(formatToolCallSummary(event.toolName, event.args, ctx.cwd));
	});

	pi.on("message_update", async (event, ctx) => {
		if (ctx.mode !== "rpc" || process.env.PI_ACP_MIRROR_THINKING === "0") return;
		const update = event.assistantMessageEvent;
		if (update.type !== "thinking_end") return;
		const summary = formatThinkingSummary(update.content, 4_000);
		if (summary) ctx.ui.notify(`thinking: ${summary}`);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (ctx.mode !== "rpc" || event.message.role !== "assistant") return;
		const usage = event.message.usage;
		run.input += usage.input;
		run.output += usage.output;
		run.cacheRead += usage.cacheRead;
		run.cacheWrite += usage.cacheWrite;
		run.cost += usage.cost.total;
		run.turns += 1;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.mode === "rpc" && run.turns > 0) ctx.ui.notify(formatRunSummary(run));
	});
}
