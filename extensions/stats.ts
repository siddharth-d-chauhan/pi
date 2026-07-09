/**
 * Stats Extension — where did the session actually go?
 *
 *   /stats   session insights card:
 *     tokens per turn sparkline, totals, cache hit rate,
 *     cost split main vs subagents, top tools by calls/time
 *
 * Data comes from live events (tool timings) + the session branch
 * (assistant usage) + the background registry (per-agent metrics), so it
 * works on resumed sessions too.
 */

import { type ExtensionAPI, getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { compactNumber, gauge, sparkline, twoColumns } from "./lib/viz.ts";

interface ToolStat {
	calls: number;
	errors: number;
	totalMs: number;
}

export default function (pi: ExtensionAPI) {
	const toolStats = new Map<string, ToolStat>();
	const inFlight = new Map<string, { name: string; startedAt: number }>();

	pi.on("tool_execution_start", async (event) => {
		inFlight.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
	});

	pi.on("tool_execution_end", async (event) => {
		const started = inFlight.get(event.toolCallId);
		inFlight.delete(event.toolCallId);
		const stat = toolStats.get(event.toolName) ?? { calls: 0, errors: 0, totalMs: 0 };
		stat.calls += 1;
		if (event.isError) stat.errors += 1;
		if (started) stat.totalMs += Date.now() - started.startedAt;
		toolStats.set(event.toolName, stat);
	});

	pi.registerCommand("stats", {
		description: "Session insights: tokens/turn, cache hit rate, agent costs, top tools",
		handler: async (_args, ctx) => {
			// ---- main-session usage from the branch --------------------------
			const branch = ctx.sessionManager.getBranch();
			const perTurnOutput: number[] = [];
			let input = 0;
			let output = 0;
			let cacheRead = 0;
			let cacheWrite = 0;
			let mainCost = 0;
			let requests = 0;
			for (const entry of branch) {
				const message = (entry as { message?: { role?: string; usage?: any } }).message;
				if (message?.role !== "assistant" || !message.usage) continue;
				const usage = message.usage as {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
				};
				requests += 1;
				input += usage.input ?? 0;
				output += usage.output ?? 0;
				cacheRead += usage.cacheRead ?? 0;
				cacheWrite += usage.cacheWrite ?? 0;
				mainCost += usage.cost?.total ?? 0;
				perTurnOutput.push(usage.output ?? 0);
			}

			// ---- subagent usage from the registry ----------------------------
			const agents = getBackgroundProcessRegistry()
				.list()
				.filter((snap) => snap.kind === "subagent" || snap.kind === "delegation");
			const agentTokens = agents.reduce((sum, snap) => sum + (snap.metrics?.tokens ?? 0), 0);
			const agentCost = agents.reduce((sum, snap) => sum + (snap.metrics?.costUsd ?? 0), 0);
			const byType = new Map<string, { tokens: number; costUsd: number; count: number }>();
			for (const snap of agents) {
				const key = snap.agentType ?? "agent";
				const row = byType.get(key) ?? { tokens: 0, costUsd: 0, count: 0 };
				row.tokens += snap.metrics?.tokens ?? 0;
				row.costUsd += snap.metrics?.costUsd ?? 0;
				row.count += 1;
				byType.set(key, row);
			}

			// ---- compose ------------------------------------------------------
			const promptTokens = input + cacheRead + cacheWrite;
			const cacheRate = promptTokens > 0 ? cacheRead / promptTokens : 0;
			const totalCost = mainCost + agentCost;
			const width = 72;

			const rows: Array<[string, string]> = [
				["tokens/turn", `${sparkline(perTurnOutput, 28)}  (${perTurnOutput.length} turns)`],
				["output", `${compactNumber(output)} tok · ${requests} requests`],
				["prompt", `${compactNumber(promptTokens)} tok (${compactNumber(cacheRead)} cached)`],
				["cache hit", `${gauge(cacheRate, 14)} ${(cacheRate * 100).toFixed(1)}%`],
				["cost", `$${totalCost.toFixed(4)} = main $${mainCost.toFixed(4)} + agents $${agentCost.toFixed(4)}`],
			];
			if (agents.length > 0) {
				rows.push(["agents", `${agents.length} spawned · ${compactNumber(agentTokens)} tok`]);
				const top = [...byType.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd).slice(0, 5);
				for (const [type, row] of top) {
					rows.push([
						`  ${type}`,
						`${row.count}× · ${compactNumber(row.tokens)} tok · $${row.costUsd.toFixed(4)}`,
					]);
				}
			}
			const tools = [...toolStats.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 6);
			if (tools.length > 0) {
				rows.push([
					"tools",
					tools
						.map(([name, stat]) => `${name}×${stat.calls}${stat.errors > 0 ? `(!${stat.errors})` : ""}`)
						.join(" "),
				]);
				const slowest = [...toolStats.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)[0];
				if (slowest && slowest[1].totalMs > 0) {
					rows.push(["  slowest", `${slowest[0]} · ${(slowest[1].totalMs / 1000).toFixed(1)}s total`]);
				}
			}

			ctx.ui.notify(twoColumns(rows, width).join("\n"), "info");
		},
	});
}
