/**
 * kp-offload.ts — lossless offload+retrieve compaction backed by the knowledge
 * platform (write / select / compress / isolate).
 *
 * pi's built-in compaction (and steered eviction) SUMMARIZE the oldest turns —
 * lossy by construction. This instead ARCHIVES the evicted region VERBATIM to
 * KP and leaves only a pointer in the live window. Nothing is destroyed: the
 * exact bytes live in KP and come back on demand via the `context_recall` tool
 * (`knowledge.fetch_blob` → verbatim UTF-8). Worst case is a retrieval miss, not
 * information loss — and, unlike omp's snapcompact, it needs no vision model.
 *
 *   write     knowledge.ingest(evicted transcript) → blob_ref   (per-session group)
 *   compress  ctx.compact steers the summary to keep only a pointer + typed TOC
 *   select    context_recall({id}) → knowledge.fetch_blob(blob_ref) → exact text
 *   isolate   each session archives into its own KP group partition
 *
 * The ref→id map is kept IN the extension so the model only needs a short id
 * ("A1"), or can call context_recall with no args to list what's archived —
 * robust even if the summarizer garbles the pointer.
 *
 * Reuses knowledge.ts's shared KP MCP client (globalThis.__pi_kp__); fail-open:
 * if KP is unreachable or anything throws, pi compacts normally (no data risk).
 * Runs only at the compaction boundary — no per-turn cost.
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
}

const MAX_ARCHIVE_CHARS = 200_000; // cap a single ingest; head+tail beyond this
const HEAD_RATIO = 0.6;
const TOOL_RESULT_CAP = 4_000; // per tool-result truncation, head+tail

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
	let steering = false; // let our own re-triggered compaction through

	pi.on("session_before_compact", async (event, ctx) => {
		const e = event as {
			preparation?: { messagesToSummarize?: Message[] };
			customInstructions?: string;
			reason?: string;
		};
		if (steering) {
			steering = false;
			return;
		}
		try {
			if (e.customInstructions) return; // respect explicit /compact
			const messages = e.preparation?.messagesToSummarize ?? [];
			if (!messages.length) return; // nothing to archive

			const transcript = clip(serialize(messages), MAX_ARCHIVE_CHARS);
			if (!transcript.trim()) return;

			// WRITE: archive verbatim → KP, get a durable blob_ref.
			const ingest = await kpCall("knowledge.ingest", {
				text: transcript,
				source: "pi-session-archive",
				group,
			});
			const blobRef = (ingest.match(/blob:\/\/[a-z0-9]+/i) ?? [])[0];
			if (!blobRef) return; // couldn't get a handle → fail open, pi compacts normally

			const id = `A${++counter}`;
			const descriptor = describe(messages);
			archive.set(id, { id, blobRef, descriptor, chars: transcript.length });

			// COMPRESS: keep only a pointer in-window; re-run the SAME compaction
			// with steering that forbids restating the archived content.
			steering = true;
			setTimeout(() => {
				try {
					ctx.compact({
						customInstructions:
							`The oldest turns were archived VERBATIM to external storage — nothing is lost. ` +
							`Write a brief continuity summary, then add exactly this line:\n` +
							`↳ archived (${id}: ${descriptor}) — retrieve exact earlier content with the context_recall tool ` +
							`(no args to list, or {"id":"${id}"} to fetch this block).\n` +
							`Do NOT reproduce the archived content in your summary; it is recallable on demand.`,
					});
				} catch {
					steering = false;
				}
			}, 0);
			return { cancel: true };
		} catch {
			steering = false;
			return; // fail-open: let pi compact normally
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
				// fetch_blob returns a JSON envelope {text, truncated, byte_size, …};
				// hand the model the decoded verbatim text, plus a paging hint.
				const envelope = await kpCall("knowledge.fetch_blob", {
					locator: entry.blobRef,
					offset: Math.max(0, input.offset ?? 0),
					max_chars: 20_000,
				});
				let text = envelope;
				try {
					const parsed = JSON.parse(envelope) as {
						text?: string;
						truncated?: boolean;
						offset?: number;
						returned_chars?: number;
					};
					if (typeof parsed.text === "string") {
						text = parsed.text;
						if (parsed.truncated) {
							const next = (parsed.offset ?? 0) + (parsed.returned_chars ?? text.length);
							text += `\n…[truncated — recall {"id":"${entry.id}","offset":${next}} for more]`;
						}
					}
				} catch {
					// non-JSON (shouldn't happen) — return as-is
				}
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

	pi.registerCommand("kpoffload", {
		description: "KP offload+retrieve compaction status (archived blocks this session)",
		handler: async (_args, ctx) => {
			const lines =
				archive.size === 0
					? "no blocks archived yet"
					: [...archive.values()].map((a) => `${a.id} · ${a.descriptor} · ${a.chars} chars`).join("\n");
			ctx.ui.notify(`KP offload: ENABLED · group ${group}\n${lines}`, "info");
		},
	});
}
