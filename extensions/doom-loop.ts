/**
 * doom-loop.ts — thrash guard: stop an agent burning turns on no progress.
 *
 * opencode's naive guard blocks only exact identical repeats. This catches both:
 *   - IDENTICAL: the same operation N times in a row
 *   - ALTERNATING: cycling between the same 2 operations (A/B/A/B…)
 * and — the key improvement — it compares ARITY-NORMALIZED operations, not raw
 * strings, so `git commit -m "a"` then `git commit -m "b"` then … is recognized
 * as the same operation thrashing instead of looking like distinct calls.
 *
 * On a trip it blocks the call ONCE with an actionable reason and resets the
 * window, so a single deliberate retry isn't instantly re-blocked. Advisory and
 * self-correcting — it never wedges.
 *
 * ON by default with a conservative threshold (only genuine thrash trips it).
 * Config: KP_DOOMLOOP=<N> repeats before tripping (default 6); KP_DOOMLOOP=0 off.
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { normalizeCommand } from "./lib/arity.ts";

const N = process.env.KP_DOOMLOOP != null ? Number(process.env.KP_DOOMLOOP) : 6;
const ENABLED = Number.isFinite(N) && N > 0;

/** Arity-normalized operation signature for a tool call. */
function signature(event: ToolCallEvent): string {
	if (event.toolName === "bash") {
		const cmd = String((event.input as { command?: unknown })?.command ?? "");
		return `bash:${normalizeCommand(cmd)}`;
	}
	// non-bash: key on tool + a bounded JSON of input (paths/args identify the op)
	let body = "";
	try {
		body = JSON.stringify(event.input ?? {}).slice(0, 400);
	} catch {
		body = "";
	}
	return `${event.toolName}:${body}`;
}

export default function (pi: ExtensionAPI): void {
	if (!ENABLED) return;

	const recent: string[] = [];
	const metrics = { identical: 0, alternating: 0 };

	pi.on("tool_call", async (event) => {
		const sig = signature(event);
		recent.push(sig);
		if (recent.length > N * 2 + 2) recent.shift();

		const tailN = recent.slice(-N);
		const identical = tailN.length === N && tailN.every((s) => s === sig);

		const tail2N = recent.slice(-N * 2);
		const distinct = new Set(tail2N);
		const alternating = tail2N.length >= N * 2 && distinct.size <= 2 && distinct.has(sig);

		if (identical || alternating) {
			if (identical) metrics.identical++;
			else metrics.alternating++;
			recent.length = 0; // reset so a deliberate retry isn't instantly re-blocked
			return {
				block: true,
				reason: identical
					? `Doom-loop guard: the same operation (${event.toolName}) ran ${N}× with no progress. ` +
						`Change approach, or tell the user you're stuck.`
					: `Doom-loop guard: you're cycling between the same ${distinct.size} operations without progress. ` +
						`Change approach, or tell the user you're stuck.`,
			};
		}
		return {};
	});

	pi.registerCommand("doomloop", {
		description: "Show doom-loop thrash-guard status (identical + A/B detection, arity-normalized)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Doom-loop guard: ENABLED · threshold=${N}× · arity-normalized signatures\n` +
					`this session: ${metrics.identical} identical-loop blocks, ${metrics.alternating} alternating-loop blocks`,
				"info",
			);
		},
	});
}
