/**
 * context-eviction.ts — typed, dependency-linked compaction steering.
 *
 * pi's built-in compaction summarizes the oldest turns. Blind summarization
 * treats a stale file read the model already acted on the same as an unresolved
 * error or a hard decision — so context rot (the model's recall degrading as the
 * window fills) sets in as horizons grow. This extension makes compaction TYPED
 * and DEPENDENCY-LINKED instead: at the compaction boundary it inspects what is
 * about to be summarized, works out which content is low-value, and steers the
 * summarizer to evict by value rather than by age.
 *
 * The one piece of real dependency analysis: a file READ is made STALE by a
 * later WRITE/EDIT to the same path — the model has newer truth, so the old
 * read's contents are safe to drop. Those exact paths are named to the summarizer.
 *
 * It runs ONLY at `session_before_compact`. That matters for KV-cache
 * discipline: compaction already rewrites the prefix, so typed eviction here
 * costs no extra cache — doing the same per-turn would bust the cached prefix.
 * It never deletes messages itself (non-destructive); it augments the
 * summarizer's instructions, so it augments core compaction rather than
 * fighting it. `/eviction` reports what it steered.
 *
 * Config: KP_EVICTION=0 disable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.KP_EVICTION !== "0";

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

/** Pull (toolName, path) from an assistant toolCall block, tolerating field-name variants. */
function toolCallOf(block: ContentBlock): { tool: string; path: string } | null {
	if (block?.type !== "toolCall") return null;
	const tool = String(block.toolName ?? block.name ?? "");
	if (!tool) return null;
	const args = (block.input ?? block.arguments ?? {}) as Record<string, unknown>;
	const path = String(args.path ?? args.file_path ?? args.filepath ?? "");
	return { tool, path };
}

/**
 * Dependency analysis over the to-be-summarized messages: which file reads are
 * superseded by a LATER write to the same path (their contents are now stale),
 * plus a coarse census of what kinds of content dominate.
 */
export function analyzeForEviction(messages: Message[]): {
	staleReads: string[];
	census: { reads: number; writes: number; toolCalls: number };
} {
	const readsByPath = new Map<string, number>(); // path -> earliest read index
	const writesByPath = new Map<string, number>(); // path -> latest write index
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

	// A read is stale iff the same path was written AFTER that read.
	const staleReads: string[] = [];
	for (const [path, readIdx] of readsByPath) {
		const writeIdx = writesByPath.get(path);
		if (writeIdx != null && writeIdx > readIdx) staleReads.push(path);
	}
	return { staleReads, census: { reads, writes, toolCalls } };
}

function buildInstructions(staleReads: string[]): string {
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
	if (!ENABLED) return;

	const metrics = { compactions: 0, staleReadsSteered: 0, lastStale: [] as string[] };

	pi.on("session_before_compact", async (event) => {
		try {
			const e = event as {
				preparation?: { messagesToSummarize?: Message[] };
				customInstructions?: string;
			};
			const messages = e.preparation?.messagesToSummarize ?? [];
			if (!messages.length) return;
			const { staleReads } = analyzeForEviction(messages);
			const typed = buildInstructions(staleReads);
			// Append to the summarizer's instructions (preserve any existing steer).
			const existing = e.customInstructions ? `${e.customInstructions}\n\n` : "";
			e.customInstructions = `${existing}${typed}`;
			metrics.compactions++;
			metrics.staleReadsSteered += staleReads.length;
			metrics.lastStale = staleReads;
		} catch {
			// advisory: never let eviction steering disturb compaction
		}
		return;
	});

	pi.registerCommand("eviction", {
		description: "Show typed context-eviction steering (dependency-linked compaction)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`Context-eviction: ENABLED\n` +
					`compactions steered=${metrics.compactions} · stale reads dropped=${metrics.staleReadsSteered}\n` +
					(metrics.lastStale.length
						? `last stale reads: ${metrics.lastStale.slice(0, 8).join(", ")}`
						: "last: none"),
				"info",
			);
		},
	});
}
