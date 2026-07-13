/**
 * kp-offload.ts — two-tier, lossless offload+retrieve compaction backed by the
 * knowledge platform (write / select / compress / isolate). Best-of-both:
 *
 *   TIER 1 (in-window)  a DETERMINISTIC digest of high-value spans copied
 *     VERBATIM — user intent, each assistant turn's conclusion, error lines,
 *     a typed activity line. Answers common follow-ups with NO recall call.
 *   TIER 2 (in KP)      the FULL evicted region, byte-for-byte, one
 *     context_recall away for any detail the digest doesn't hold.
 *
 * Unlike pi's blind LLM summary (lossy) this loses nothing; unlike omp's
 * snapcompact it needs no vision model. And the compaction event costs ZERO
 * model tokens: the handler returns `{compaction}` directly (pi uses it
 * verbatim, skipping the summarizer) — the digest is EXTRACTED, not generated.
 *
 *   write     knowledge.ingest(evicted transcript) → blob_ref   (per-session group)
 *   compress  return {compaction:{summary: digest + pointer}}   (no LLM)
 *   select    context_recall({id}) → knowledge.fetch_blob(blob_ref) → exact text
 *   isolate   each session archives into its own KP group partition
 *
 * AUTO-RECALL ON SHIFT: measurement showed the model itself under/over-triggers
 * context_recall. So on a WorkFrame direction change (pi_context_shift), the
 * HARNESS — not the model — matches the new direction against each block's
 * keywords and injects the relevant block's head verbatim. Deterministic,
 * deduped, fail-open. Disable with KP_OFFLOAD_AUTORECALL=0.
 *
 * The ref→id map is kept IN the extension so the model only needs a short id
 * ("A1"), or can call context_recall with no args to list what's archived.
 *
 * Reuses knowledge.ts's shared KP MCP client (globalThis.__pi_kp__); fail-open:
 * if KP is unreachable or anything throws, pi runs its normal compaction (no
 * data risk). Runs only at the compaction boundary — no per-turn cost.
 *
 * OFF by default. KP_OFFLOAD=1 to enable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type Static, Type } from "typebox";
import { analyzeForEviction } from "./context-eviction.ts";

interface KpShared {
	connect: () => Promise<Client>;
	timeoutMs: number;
}

interface Message {
	role?: string;
	content?: Array<Record<string, unknown>> | string;
}

// Per-session archive: short id → the KP blob it points at.
interface ArchiveEntry {
	id: string;
	blobRef: string;
	descriptor: string;
	chars: number;
	keywords: Set<string>; // salient terms, for auto-recall relevance matching
}

const MAX_ARCHIVE_CHARS = 200_000; // cap a single ingest; head+tail beyond this
const HEAD_RATIO = 0.6;
const TOOL_RESULT_CAP = 4_000; // per tool-result truncation, head+tail
const AUTO_RECALL_MIN_OVERLAP = 3; // min direction↔block term overlap to auto-inject
const AUTO_RECALL_INJECT_CHARS = 8_000; // bound the auto-injected head (full block via recall)

const recallSchema = Type.Object({
	id: Type.Optional(Type.String({ description: 'archived block id (e.g. "A1"); omit to LIST all archived blocks' })),
	offset: Type.Optional(Type.Number({ description: "char offset for paging large blocks (default 0)" })),
});
type RecallInput = Static<typeof recallSchema>;

function kpShared(): KpShared | undefined {
	return (globalThis as Record<string, unknown>).__pi_kp__ as KpShared | undefined;
}

/** Extract text from an MCP tool result's content blocks. */
function textOf(result: { content?: unknown; isError?: boolean }): string {
	const blocks = Array.isArray(result.content) ? (result.content as Array<{ type?: string; text?: string }>) : [];
	return blocks
		.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
		.join("\n")
		.trim();
}

async function kpCall(name: string, args: Record<string, unknown>): Promise<string> {
	const shared = kpShared();
	if (!shared) throw new Error("KP client unavailable (knowledge.ts not loaded)");
	const client = await shared.connect();
	const result = (await client.callTool({ name, arguments: args }, undefined, {
		timeout: shared.timeoutMs,
	})) as { content?: unknown; isError?: boolean };
	if (result.isError) throw new Error(textOf(result) || `${name} failed`);
	return textOf(result);
}

/** Truncate a long string head+tail so the archive stays conversation-dense. */
export function clip(s: string, cap: number): string {
	if (s.length <= cap) return s;
	const head = Math.floor(cap * HEAD_RATIO);
	const tail = cap - head;
	return `${s.slice(0, head)}\n…[${s.length - cap} chars elided]…\n${s.slice(s.length - tail)}`;
}

/** Serialize the evicted messages to a compact but faithful verbatim transcript. */
export function serialize(messages: Message[]): string {
	const out: string[] = [];
	for (const msg of messages) {
		const role = msg.role ?? "?";
		if (typeof msg.content === "string") {
			out.push(`### ${role}\n${msg.content}`);
			continue;
		}
		const parts: string[] = [];
		for (const block of msg.content ?? []) {
			const type = String(block.type ?? "");
			if (type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			} else if (type === "toolCall") {
				const tool = String(block.toolName ?? block.name ?? "tool");
				const args = JSON.stringify(block.input ?? block.arguments ?? {});
				parts.push(`→ ${tool}(${clip(args, 1_000)})`);
			} else if (type === "toolResult" || type === "toolResponse") {
				const body =
					typeof block.text === "string" ? block.text : JSON.stringify(block.content ?? block.output ?? "");
				parts.push(`← ${clip(body, TOOL_RESULT_CAP)}`);
			}
		}
		if (parts.length) out.push(`### ${role}\n${parts.join("\n")}`);
	}
	return out.join("\n\n");
}

const ERROR_RE = /\b(error|failed|failure|exception|traceback|denied|refused|not found|cannot|exit code [1-9])\b/i;

/**
 * The in-window DIGEST (tier 1): high-value spans copied VERBATIM — user intent,
 * each assistant turn's conclusion, and error lines — plus a typed activity line.
 * Extraction, NOT summarization: no LLM call, and the facts it keeps are exact,
 * so common follow-ups are answered without a recall. Everything else lives in
 * the KP archive (tier 2), one context_recall away.
 */
export function buildDigest(messages: Message[]): string {
	const points: string[] = [];
	const errors: string[] = [];
	for (const msg of messages) {
		const role = msg.role ?? "";
		const texts: string[] = [];
		if (typeof msg.content === "string") {
			texts.push(msg.content);
		} else {
			for (const b of msg.content ?? []) {
				if (b.type === "text" && typeof b.text === "string") {
					texts.push(b.text);
				} else if (b.type === "toolResult" || b.type === "toolResponse") {
					const body = typeof b.text === "string" ? b.text : "";
					for (const line of body.split("\n")) {
						if (ERROR_RE.test(line) && line.trim()) errors.push(clip(line.trim(), 200));
					}
				}
			}
		}
		const joined = texts.join(" ").trim();
		if (!joined) continue;
		if (role === "user") points.push(`user: ${clip(joined, 400)}`);
		else if (role === "assistant") points.push(`did: ${clip(texts[texts.length - 1].trim(), 300)}`);
	}
	const out: string[] = [];
	if (points.length) out.push(points.slice(0, 30).join("\n"));
	if (errors.length)
		out.push(
			`errors:\n${[...new Set(errors)]
				.slice(0, 12)
				.map((e) => `• ${e}`)
				.join("\n")}`,
		);
	out.push(`activity: ${describe(messages)}`);
	return out.join("\n\n");
}

const STOPWORDS = new Set(
	(
		"the and for that with this from have will your you are was were his her they them then than into over " +
		"about which what when where would could should their there here also been being does done each more most " +
		"some such only very just like into onto upon while these those able across after again against because " +
		"before between during through under above below same other another every any all can may might must not"
	).split(" "),
);

/** Extract up to `max` salient lowercase terms (content words, by frequency). */
export function keywordsOf(text: string, max = 40): Set<string> {
	const freq = new Map<string, number>();
	for (const w of text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []) {
		if (STOPWORDS.has(w)) continue;
		freq.set(w, (freq.get(w) ?? 0) + 1);
	}
	return new Set(
		[...freq.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, max)
			.map(([w]) => w),
	);
}

/** Pull display text out of a tool result (content blocks or a raw value). */
export function extractResultText(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown })?.content;
	if (Array.isArray(content)) {
		return (content as Array<{ type?: string; text?: string }>)
			.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
			.join(" ");
	}
	try {
		return JSON.stringify(result ?? "");
	} catch {
		return "";
	}
}

/** Overlap count between a direction's words and an archived block's keywords. */
export function relevance(directionWords: Set<string>, blockKeywords: Set<string>): number {
	let n = 0;
	for (const k of blockKeywords) if (directionWords.has(k)) n++;
	return n;
}

/** fetch_blob → decoded verbatim text (parses the JSON envelope). */
async function fetchBlobText(blobRef: string, offset = 0, maxChars = 20_000): Promise<string> {
	const envelope = await kpCall("knowledge.fetch_blob", {
		locator: blobRef,
		offset: Math.max(0, offset),
		max_chars: maxChars,
	});
	try {
		const parsed = JSON.parse(envelope) as {
			text?: string;
			truncated?: boolean;
			offset?: number;
			returned_chars?: number;
		};
		if (typeof parsed.text === "string") {
			let text = parsed.text;
			if (parsed.truncated) {
				const next = (parsed.offset ?? 0) + (parsed.returned_chars ?? text.length);
				text += `\n…[truncated — recall {"offset":${next}} for more]`;
			}
			return text;
		}
	} catch {
		// non-JSON (shouldn't happen) — fall through to raw
	}
	return envelope;
}

/** A one-line typed table-of-contents for the archived region. */
export function describe(messages: Message[]): string {
	const { staleReads, census } = analyzeForEviction(messages as never);
	const bits = [
		`${messages.length} msgs`,
		census.reads ? `${census.reads} reads` : "",
		census.writes ? `${census.writes} writes` : "",
		census.toolCalls ? `${census.toolCalls} tool calls` : "",
	].filter(Boolean);
	let d = bits.join(", ");
	if (staleReads.length) d += ` · superseded: ${staleReads.slice(0, 6).join(", ")}`;
	return d;
}

export default function (pi: ExtensionAPI): void {
	if (process.env.KP_OFFLOAD !== "1") return;

	// One archive group per pi process run (shared across this session's
	// compactions). Survives within the session; resume starts a fresh map.
	const group = `pi-archive-${Date.now().toString(36)}`;
	const archive = new Map<string, ArchiveEntry>();
	let counter = 0;

	pi.on("session_before_compact", async (event) => {
		const e = event as {
			preparation?: { messagesToSummarize?: Message[]; firstKeptEntryId?: string; tokensBefore?: number };
			customInstructions?: string;
		};
		try {
			if (e.customInstructions) return; // respect explicit /compact
			const prep = e.preparation;
			const messages = prep?.messagesToSummarize ?? [];
			if (!prep?.firstKeptEntryId || !messages.length) return; // nothing to archive

			const transcript = clip(serialize(messages), MAX_ARCHIVE_CHARS);
			if (!transcript.trim()) return;

			// WRITE (tier 2): archive verbatim → KP, get a durable blob_ref.
			const ingest = await kpCall("knowledge.ingest", {
				text: transcript,
				source: "pi-session-archive",
				group,
			});
			const blobRef = (ingest.match(/blob:\/\/[a-z0-9]+/i) ?? [])[0];
			if (!blobRef) return; // couldn't get a handle → fail open, pi compacts normally

			const id = `A${++counter}`;
			const descriptor = describe(messages);
			archive.set(id, { id, blobRef, descriptor, chars: transcript.length, keywords: keywordsOf(transcript) });

			// COMPRESS (tier 1): return a DETERMINISTIC compaction — the digest +
			// pointer, with NO LLM summarization pass (pi uses result.compaction
			// verbatim). Common questions are answered from the digest; anything
			// deeper is one context_recall away.
			const digest = buildDigest(messages);
			const summary =
				`${digest}\n\n↳ full earlier detail archived (${id}: ${descriptor}). The digest above covers the ` +
				`essentials — call context_recall({"id":"${id}"}) ONLY for a detail it does not contain.`;
			return {
				compaction: {
					summary,
					firstKeptEntryId: prep.firstKeptEntryId,
					tokensBefore: prep.tokensBefore ?? 0,
				},
			};
		} catch {
			return; // fail-open: let pi run its normal LLM compaction
		}
	});

	// SELECT: the model pulls exact archived content back, just-in-time.
	pi.registerTool({
		name: "context_recall",
		label: "recall",
		description:
			"Retrieve exact earlier conversation that was archived verbatim during compaction. " +
			"Call with no arguments to LIST archived blocks (id + what each contains); call with {id} to " +
			"fetch that block's exact text (paginate large blocks with offset). Use when a summarized " +
			"earlier detail — a decision, an error, a file's prior state — would change your next step.",
		parameters: recallSchema,
		async execute(_id: string, input: RecallInput) {
			if (!input.id) {
				if (archive.size === 0) {
					return { content: [{ type: "text" as const, text: "no archived blocks yet" }], details: undefined };
				}
				const list = [...archive.values()].map((a) => `${a.id} — ${a.descriptor} (${a.chars} chars)`).join("\n");
				return { content: [{ type: "text" as const, text: `archived blocks:\n${list}` }], details: undefined };
			}
			const entry = archive.get(input.id);
			if (!entry) {
				const ids = [...archive.keys()].join(", ") || "none";
				return {
					content: [{ type: "text" as const, text: `unknown block "${input.id}". available: ${ids}` }],
					details: undefined,
				};
			}
			try {
				const text = await fetchBlobText(entry.blobRef, input.offset ?? 0);
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (err) {
				return {
					content: [
						{ type: "text" as const, text: `recall failed: ${err instanceof Error ? err.message : String(err)}` },
					],
					details: undefined,
				};
			}
		},
	});

	// AUTO-RECALL ON SHIFT: the measured weakness is that the model itself
	// under/over-triggers context_recall. So on a WorkFrame direction change
	// (pi_context_shift — the broker's phase signal), the HARNESS decides: match
	// the new direction against each archived block's keywords and, if one is
	// clearly relevant and not already surfaced, inject its head verbatim so the
	// model just HAS it — no retrieval gamble. Deterministic, deduped, fail-open.
	// Disable with KP_OFFLOAD_AUTORECALL=0.
	const autoRecall = process.env.KP_OFFLOAD_AUTORECALL !== "0";
	const injected = new Set<string>();
	pi.on("tool_execution_end", async (event) => {
		if (!autoRecall) return;
		const e = event as { toolName?: string; result?: unknown };
		if (e.toolName !== "pi_context_shift" || archive.size === 0) return;
		try {
			const direction = extractResultText(e.result).toLowerCase();
			const words = new Set(direction.match(/[a-z][a-z0-9_]{3,}/g) ?? []);
			if (words.size === 0) return;
			let best: ArchiveEntry | undefined;
			let bestScore = 0;
			for (const entry of archive.values()) {
				if (injected.has(entry.id)) continue;
				const score = relevance(words, entry.keywords);
				if (score > bestScore) {
					bestScore = score;
					best = entry;
				}
			}
			if (!best || bestScore < AUTO_RECALL_MIN_OVERLAP) return; // no clear match → inject nothing
			const head = await fetchBlobText(best.blobRef, 0, AUTO_RECALL_INJECT_CHARS);
			injected.add(best.id);
			await pi.sendMessage(
				{
					customType: "kp-auto-recall",
					content:
						`[auto-recalled archive ${best.id} — relevant to the new direction (${bestScore} term match). ` +
						`Full block via context_recall({"id":"${best.id}"}).]\n${head}`,
					display: true,
					details: { id: best.id, score: bestScore },
				},
				{ triggerTurn: false },
			);
		} catch {
			// fail-open: auto-recall is a best-effort assist, never blocks the turn
		}
	});

	pi.registerCommand("kpoffload", {
		description: "KP offload+retrieve compaction status (archived blocks this session)",
		handler: async (_args, ctx) => {
			const lines =
				archive.size === 0
					? "no blocks archived yet"
					: [...archive.values()]
							.map(
								(a) =>
									`${a.id} · ${a.descriptor} · ${a.chars} chars${injected.has(a.id) ? " · auto-recalled" : ""}`,
							)
							.join("\n");
			ctx.ui.notify(
				`KP offload: ENABLED · group ${group} · auto-recall ${autoRecall ? "on" : "off"}\n${lines}`,
				"info",
			);
		},
	});
}
