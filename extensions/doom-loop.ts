/**
 * doom-loop.ts — thrash guard: stop an agent burning turns on no progress.
 *
 * opencode's naive guard blocks only exact identical repeats. This catches both:
 *   - EXACT: the same tool and arguments 3 times in a row
 *   - IDENTICAL: the same normalized operation N times in a row
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
 * Config: KP_DOOMLOOP=<N> normalized repeats before tripping (default 6),
 * KP_DOOMLOOP_EXACT=<N> exact repeats (default 3); set both to 0 to disable.
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { normalizeCommand } from "./lib/arity.ts";

const N = process.env.KP_DOOMLOOP != null ? Number(process.env.KP_DOOMLOOP) : 6;
const EXACT_N = process.env.KP_DOOMLOOP_EXACT != null ? Number(process.env.KP_DOOMLOOP_EXACT) : 3;
const NORMALIZED_ENABLED = Number.isFinite(N) && N > 0;
const EXACT_ENABLED = Number.isFinite(EXACT_N) && EXACT_N > 0;
const ENABLED = NORMALIZED_ENABLED || EXACT_ENABLED;
const RECENT_LIMIT = Math.max(EXACT_ENABLED ? EXACT_N : 0, NORMALIZED_ENABLED ? N * 2 : 0, 1);

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableValue(entry)]),
	);
}

function exactSignature(event: ToolCallEvent): string {
	return `${event.toolName}:${JSON.stringify(stableValue(event.input ?? {}))}`;
}

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

	const recent: Array<{ exact: string; normalized: string }> = [];
	const metrics = { exact: 0, identical: 0, alternating: 0 };

	pi.on("agent_start", async () => {
		recent.length = 0;
	});

	pi.on("tool_call", async (event) => {
		const normalized = signature(event);
		const exact = exactSignature(event);
		recent.push({ exact, normalized });
		if (recent.length > RECENT_LIMIT) recent.shift();

		const exactTail = recent.slice(-EXACT_N);
		const exactRepeat =
			EXACT_ENABLED && exactTail.length === EXACT_N && exactTail.every((entry) => entry.exact === exact);
		const tailN = recent.slice(-N);
		const identical =
			NORMALIZED_ENABLED && tailN.length === N && tailN.every((entry) => entry.normalized === normalized);

		const tail2N = recent.slice(-N * 2);
		const distinct = new Set(tail2N.map((entry) => entry.normalized));
		const alternating =
			NORMALIZED_ENABLED && tail2N.length >= N * 2 && distinct.size <= 2 && distinct.has(normalized);

		if (exactRepeat || identical || alternating) {
			if (exactRepeat) metrics.exact++;
			else if (identical) metrics.identical++;
			else metrics.alternating++;
			recent.length = 0; // reset so a deliberate retry isn't instantly re-blocked
			return {
				block: true,
				reason: exactRepeat
					? `Doom-loop guard: the same ${event.toolName} call and arguments repeated ${EXACT_N}×. ` +
						`Reuse the prior result or change approach.`
					: identical
						? `Doom-loop guard: the same operation (${event.toolName}) ran ${N}× with no progress. ` +
							`Change approach, or tell the user you're stuck.`
						: `Doom-loop guard: you're cycling between the same ${distinct.size} operations without progress. ` +
							`Change approach, or tell the user you're stuck.`,
			};
		}
		return {};
	});

	pi.registerCommand("doomloop", {
		description: "Show doom-loop thrash-guard status (exact + normalized + A/B detection)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Doom-loop guard: ENABLED · exact=${EXACT_N}× · normalized=${N}×\n` +
					`this session: ${metrics.exact} exact, ${metrics.identical} normalized, ${metrics.alternating} alternating blocks`,
				"info",
			);
		},
	});
}
