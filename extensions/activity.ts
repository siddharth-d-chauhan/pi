/**
 * Activity HUD Extension — you always know WHAT pi is doing, not just that
 * a spinner is spinning.
 *
 * - Working line shows the live action:  ▸ edit src/core/agents/spawn.ts
 * - Footer segment streams throughput:   ⚡ 42 tok/s · +$0.0031 · turn 12s
 *   (segment lingers dimmed after the turn with final numbers)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { icon } from "./lib/icons.ts";

const STATUS_KEY = "activity";

/** Best-effort human target from tool args (path, command, pattern, …). */
function toolTarget(toolName: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const value =
		(args.file_path as string) ??
		(args.path as string) ??
		(args.filePath as string) ??
		(args.command as string) ??
		(args.pattern as string) ??
		(args.chain as string) ??
		(args.url as string) ??
		(toolName === "agent" && Array.isArray(args.tasks)
			? (args.tasks as Array<{ agent?: string }>).map((task) => task.agent).join(", ")
			: undefined);
	if (typeof value !== "string" || !value) return "";
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

export default function (pi: ExtensionAPI) {
	let turnStartedAt = 0;
	let turnCost = 0;
	let outputTokens = 0;
	let streamStartedAt = 0;
	let lastFooterAt = 0;
	let running = false;

	pi.on("turn_start", async () => {
		turnStartedAt = Date.now();
		streamStartedAt = 0;
		outputTokens = 0;
		turnCost = 0;
		running = true;
	});

	pi.on("message_start", async (event) => {
		if ((event.message as { role?: string }).role === "assistant") {
			streamStartedAt = Date.now();
			outputTokens = 0;
		}
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; usage?: { cost?: { total?: number } } };
		if (message.role === "assistant") turnCost += message.usage?.cost?.total ?? 0;
	});

	pi.on("message_update", async (event, ctx) => {
		if (!running || !ctx.hasUI) return;
		const usage = (event.message as { usage?: { output?: number } }).usage;
		if (usage?.output) outputTokens = usage.output;
		// Throttle footer writes to ~4/s; the renderer coalesces anyway.
		const now = Date.now();
		if (now - lastFooterAt < 250) return;
		lastFooterAt = now;
		const elapsed = streamStartedAt ? (now - streamStartedAt) / 1000 : 0;
		const tps = elapsed > 0.5 && outputTokens > 0 ? Math.round(outputTokens / elapsed) : undefined;
		const turnSeconds = Math.round((now - turnStartedAt) / 1000);
		const parts = [
			tps !== undefined ? `${icon("speed")} ${tps} tok/s` : `${icon("speed")} …`,
			`turn ${turnSeconds}s`,
		];
		ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const target = toolTarget(event.toolName, event.args as Record<string, unknown>);
		ctx.ui.setWorkingMessage(target ? `${event.toolName} ${target}` : event.toolName);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(); // restore default while the model thinks
	});

	pi.on("turn_end", async (_event, ctx) => {
		running = false;
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
		const elapsed = streamStartedAt ? (Date.now() - streamStartedAt) / 1000 : 0;
		const tps = elapsed > 0.5 && outputTokens > 0 ? Math.round(outputTokens / elapsed) : undefined;
		const parts = [
			tps !== undefined ? `${icon("speed")} ${tps} tok/s` : undefined,
			turnCost > 0 ? `+$${turnCost.toFixed(4)}` : undefined,
		].filter(Boolean);
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
	});

	pi.on("agent_end", async (_event, ctx) => {
		running = false;
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}
