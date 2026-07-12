/**
 * context-eviction.ts — typed, dependency-linked compaction steering (working).
 *
 * pi's built-in compaction summarizes the oldest turns blindly — a stale file
 * read the model already acted on is treated like an unresolved error. This
 * makes compaction TYPED instead: it steers the summarizer to keep high-value
 * content (errors, decisions, task state, file ops) and drop low-value content
 * (stale reads superseded by a later write, resolved steps, dead logs).
 *
 * WHY IT'S BUILT THIS WAY (this bit is subtle): a `session_before_compact`
 * handler CANNOT steer the summary by mutating `event.customInstructions` — the
 * result type is only {cancel, compaction}, and pi's compact() uses its own
 * instruction parameter, ignoring the event. The one supported seam is
 * `ctx.compact({customInstructions})`, which pi DOES honor. So when pi is about
 * to compact blindly, we CANCEL it and immediately re-trigger the same
 * compaction with our typed instructions. pi still decides WHEN to compact; we
 * decide HOW. A one-shot guard flag lets our own re-triggered compaction through.
 *
 * Dependency analysis: a file READ made STALE by a later WRITE to the same path
 * is named to the summarizer as safe-to-drop.
 *
 * Fail-open: any error, or a user's explicit /compact instructions, leaves pi's
 * compaction untouched. Runs only at the compaction boundary (no per-turn cost).
 *
 * OFF by default (value not yet measured for capable models). KP_EVICTION=1 to enable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ_TOOLS = /^(read|hread)$/i;
const WRITE_TOOLS = /^(write|edit|hedit|hedit_block|multiedit|apply_patch|str_replace|create_file)$/i;

interface ContentBlock {
	type?: string;
	name?: string;
	toolName?: string;
	input?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
}
interface Message {
	role?: string;
	content?: ContentBlock[] | string;
}

function toolCallOf(block: ContentBlock): { tool: string; path: string } | null {
	if (block?.type !== "toolCall") return null;
	const tool = String(block.toolName ?? block.name ?? "");
	if (!tool) return null;
	const args = (block.input ?? block.arguments ?? {}) as Record<string, unknown>;
	const path = String(args.path ?? args.file_path ?? args.filepath ?? "");
	return { tool, path };
}

/** Which file reads are superseded by a LATER write to the same path (stale). */
export function analyzeForEviction(messages: Message[]): {
	staleReads: string[];
	census: { reads: number; writes: number; toolCalls: number };
} {
	const readsByPath = new Map<string, number>();
	const writesByPath = new Map<string, number>();
	let reads = 0;
	let writes = 0;
	let toolCalls = 0;
	let i = 0;
	for (const msg of messages) {
		const blocks = Array.isArray(msg?.content) ? msg.content : [];
		for (const b of blocks) {
			const tc = toolCallOf(b);
			if (!tc) continue;
			toolCalls++;
			if (tc.path && READ_TOOLS.test(tc.tool)) {
				reads++;
				if (!readsByPath.has(tc.path)) readsByPath.set(tc.path, i);
			} else if (tc.path && WRITE_TOOLS.test(tc.tool)) {
				writes++;
				writesByPath.set(tc.path, i);
			}
		}
		i++;
	}
	const staleReads: string[] = [];
	for (const [path, readIdx] of readsByPath) {
		const writeIdx = writesByPath.get(path);
		if (writeIdx != null && writeIdx > readIdx) staleReads.push(path);
	}
	return { staleReads, census: { reads, writes, toolCalls } };
}

export function buildInstructions(staleReads: string[]): string {
	const lines = [
		"TYPED EVICTION — retain by value, do not summarize blindly by age:",
		"KEEP: unresolved errors and their context; decisions and constraints; the current task goal and its acceptance state; file operations and their outcomes; anything the user explicitly asked to remember.",
		"DROP hardest: superseded or duplicate command outputs; resolved intermediate steps; verbose logs already acted on; older snapshots when a newer state of the same file/entity exists.",
		"Prefer the NEWEST state of any file or entity over earlier snapshots of it.",
	];
	if (staleReads.length) {
		const shown = staleReads.slice(0, 12).join(", ");
		lines.push(
			`These files were EDITED after being read, so their earlier read contents are stale and safe to drop: ${shown}.`,
		);
	}
	return lines.join("\n");
}

export default function (pi: ExtensionAPI): void {
	// Read the gate at registration time (opt-in; off unless KP_EVICTION=1).
	if (process.env.KP_EVICTION !== "1") return;

	const metrics = { steered: 0, lastStale: [] as string[] };
	// One-shot guard: true while OUR re-triggered compaction is being prepared, so
	// its own session_before_compact fires through instead of being re-steered.
	let steering = false;

	pi.on("session_before_compact", async (event, ctx) => {
		const e = event as {
			preparation?: { messagesToSummarize?: Message[] };
			customInstructions?: string;
		};
		// Our own re-triggered compaction — let it proceed (instructions already set).
		if (steering) {
			steering = false;
			return;
		}
		try {
			// Don't clobber a user's explicit /compact instructions.
			if (e.customInstructions) return;
			const messages = e.preparation?.messagesToSummarize ?? [];
			if (!messages.length) return; // nothing to steer; let pi compact
			const { staleReads } = analyzeForEviction(messages);
			const instructions = buildInstructions(staleReads);
			// Re-run the SAME compaction with our typed instructions (pi honors this
			// parameter), and cancel pi's blind one. Deferred to avoid re-entering
			// compaction from inside its own before-hook.
			steering = true;
			setTimeout(() => {
				try {
					ctx.compact({ customInstructions: instructions });
				} catch {
					steering = false; // re-trigger failed; reset so we're not wedged
				}
			}, 0);
			metrics.steered++;
			metrics.lastStale = staleReads;
			return { cancel: true };
		} catch {
			steering = false;
			return; // fail-open: let pi compact normally
		}
	});

	pi.registerCommand("eviction", {
		description: "Typed context-eviction status (steers compaction to drop stale reads)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Context-eviction: ENABLED\n` +
					`compactions steered=${metrics.steered}\n` +
					(metrics.lastStale.length
						? `last stale reads: ${metrics.lastStale.slice(0, 8).join(", ")}`
						: "last: none"),
				"info",
			);
		},
	});
}
