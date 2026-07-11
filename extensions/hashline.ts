/**
 * hashline.ts — hash-anchored edits (production).
 *
 * The edit format, not the model, drives edit reliability: content-hash line
 * anchors let the model reference lines by a short hash instead of re-quoting
 * them, and a stale anchor is REJECTED before applying — killing the
 * "string not found" / whitespace retry loops that wreck weak-model edit runs.
 * (omp's own benchmark of this format moved Grok Code Fast 1 6.7% -> 68.3%.)
 *
 * Tools (all NEW names — builtin read/edit stay available and unaffected):
 *  - hread(path)  -> each line as `HASH│content` (HASH = 3-char content hash).
 *  - hedit(path, changes)  -> replace line RANGES by {from,to} hash anchors;
 *      the old text is never re-sent (the token win). Stale/unseen/overlapping
 *      anchors are rejected with a typed error so the model self-corrects.
 *  - hedit_block(path, from, lines)  -> replace/delete a whole enclosing block
 *      (function/class/if/loop) by its START anchor; the tool finds the end.
 *      Uses the native tree-sitter resolver (78 langs, incl. indent langs like
 *      Python) when @oh-my-pi/pi-natives is installed, else a brace scanner.
 *
 * Safety: three independent guards before any write —
 *   1. staleness: a changed line has a changed hash, so a stale anchor 404s;
 *   2. seen-lines: an anchor hread never actually SHOWED is rejected (blocks
 *      edits to lines the model summarized/hallucinated instead of reading);
 *   3. overlap: two ranges touching the same lines in one call are rejected.
 * hedit writes through the normal fs path, so guardrails/edit-lock still gate it.
 *
 * OFF by default. hashline's only real win is edit RELIABILITY on weak models
 * that thrash on string-match edits; a capable model doesn't need it, and the
 * Wave-0 agent lane measured it costing ~18% MORE total tokens on MiniMax-M3
 * (the forced hread re-read dwarfs the payload saving) plus per-turn tool-schema
 * overhead. So it is opt-in — enable only for a genuinely weak model or a
 * large-edit workload. See bench/RESULTS.md.
 *
 * Config: KP_HASHLINE_ENABLED=1 enable (off by default). KP_NATIVES=0 force the JS block scanner.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadNatives } from "./lib/natives.ts";

const ENABLED = process.env.KP_HASHLINE_ENABLED === "1";
const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HASH_LEN = 3;
const SEP = "│";

function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** Some harness input pre-processors wrap a string array as [{item:"…"}, …].
 *  Unwrap defensively so hedit works with either shape. */
function unwrapLines(arr: unknown): string[] {
	if (!Array.isArray(arr)) return [];
	return arr.map((x: unknown) => {
		if (typeof x === "string") return x;
		if (x && typeof x === "object") {
			const o = x as Record<string, unknown>;
			if (typeof o.item === "string") return o.item;
			if (typeof o.text === "string") return o.text;
			if (typeof o.value === "string") return o.value;
		}
		return String(x ?? "");
	});
}

function toBase(n: number): string {
	let out = "";
	for (let j = 0; j < HASH_LEN; j++) {
		out = ALPH[n & 63] + out;
		n = Math.floor(n / 64);
	}
	return out;
}

const canon = (line: string) => line.replace(/\r/g, "").replace(/\s+$/, "");

/** Unique 3-char content hash per line (collision-retry within one file). */
function lineHashes(lines: string[]): string[] {
	const hashes: string[] = [];
	const seen = new Set<string>();
	for (const line of lines) {
		const c = canon(line);
		let h = toBase(fnv1a(c));
		let retry = 0;
		while (seen.has(h)) {
			retry++;
			h = toBase(fnv1a(`${c}:R${retry}`));
		}
		seen.add(h);
		hashes.push(h);
	}
	return hashes;
}

function readLines(path: string, cwd: string): { lines: string[]; hashes: string[] } {
	const abs = resolve(cwd, path);
	const content = readFileSync(abs, "utf-8");
	const lines = content.split("\n");
	return { lines, hashes: lineHashes(lines) };
}

const langFromPath = (path: string): string | undefined => {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "javascript",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		rb: "ruby",
	};
	return map[ext];
};

/**
 * Native-accelerated block-end resolver (tree-sitter, 78 languages). Returns
 * the 0-indexed end line of the block STARTING at `startIdx`, or -1 if
 * unavailable/not found. Falls through to the brace scanner when the native
 * addon is not installed.
 */
function resolveBlockEndNative(lines: string[], startIdx: number, path: string): number | null {
	const nat = loadNatives();
	if (!nat) return null;
	try {
		const r = nat.blockRangeAt({
			code: lines.join("\n"),
			lang: langFromPath(path),
			path,
			line: startIdx + 1, // native API is 1-indexed
		});
		if (r && typeof r.endLine === "number") return r.endLine - 1;
		return -1;
	} catch {
		return null; // fall back to JS scanner
	}
}

/**
 * Brace-matching block-end resolver (fallback). String/comment/char-literal
 * aware so braces inside literals don't miscount. Returns 0-indexed end line,
 * or -1 for non-brace languages (Python/indent) or when no block is found.
 */
function resolveBlockEndBraces(lines: string[], startIdx: number): number {
	let depth = 0;
	let started = false;
	let inStr = "";
	let inLineComment = false;
	let inBlockComment = false;
	let esc = false;
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		inLineComment = false;
		for (let j = 0; j < line.length; j++) {
			const ch = line[j];
			const nx = line[j + 1];
			if (inLineComment) break;
			if (inBlockComment) {
				if (ch === "*" && nx === "/") {
					inBlockComment = false;
					j++;
				}
				continue;
			}
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === inStr) inStr = "";
				continue;
			}
			if (ch === "/" && nx === "/") {
				inLineComment = true;
				break;
			}
			if (ch === "/" && nx === "*") {
				inBlockComment = true;
				j++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				inStr = ch;
				continue;
			}
			if (ch === "{") {
				depth++;
				started = true;
			} else if (ch === "}") {
				depth--;
				if (started && depth === 0) return i;
			}
		}
	}
	return -1;
}

/** Resolve a block end using the native resolver when present, else braces. */
function resolveBlockEnd(lines: string[], startIdx: number, path: string): number {
	const native = resolveBlockEndNative(lines, startIdx, path);
	if (native !== null) return native;
	return resolveBlockEndBraces(lines, startIdx);
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: { error?: boolean } | undefined };
const err = (text: string): ToolResult => ({ content: [{ type: "text" as const, text }], details: { error: true } });
const ok = (text: string): ToolResult => ({ content: [{ type: "text" as const, text }], details: undefined });

export default function (pi: ExtensionAPI): void {
	if (!ENABLED) return;

	// Seen-lines guard: track which hashes hread actually SHOWED per file, so
	// hedit can reject an anchor the model never read (partial read / summarized
	// / hallucinated from memory) rather than editing a line it didn't look at.
	const seen = new Map<string, Set<string>>();
	const markSeen = (abs: string, hs: string[]) => {
		let s = seen.get(abs);
		if (!s) {
			s = new Set();
			seen.set(abs, s);
		}
		for (const h of hs) s.add(h);
	};

	// Once-per-session nudge toward the hash-anchored flow (KV-cache safe:
	// before_agent_start fires once and the text is byte-stable).
	pi.on("before_agent_start", async (event: { systemPrompt?: string }) => ({
		systemPrompt:
			(event.systemPrompt ?? "") +
			"\n\n## Efficient edits\nFor editing existing files, prefer hread (returns lines as HASH│content) then hedit " +
			"(replace a line range by its start/end HASH — never re-quote the old text). This is cheaper and staleness-safe " +
			"than re-sending old_string. Use the builtin edit only for tiny one-off string swaps.",
	}));

	pi.registerTool({
		name: "hread",
		label: "hread",
		description:
			"Read a text file with hash anchors: each line is returned as `HASH│content` (HASH = 3-char content hash). " +
			"Use the hashes with hedit to replace line ranges without re-quoting the old text. Supports offset/limit.",
		promptSnippet: "hread(path) — read with HASH│line anchors (pair with hedit)",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				offset: { type: "number", description: "1-indexed start line" },
				limit: { type: "number", description: "max lines" },
			},
			required: ["path"],
		},
		async execute(_id: string, params: { path?: unknown; offset?: unknown; limit?: unknown }): Promise<ToolResult> {
			const path = String(params.path ?? "");
			const offset = params.offset != null ? Number(params.offset) : undefined;
			const limit = params.limit != null ? Number(params.limit) : undefined;
			try {
				const { lines, hashes } = readLines(path, process.cwd());
				const start = Math.max(0, (offset ?? 1) - 1);
				const end = limit ? Math.min(lines.length, start + limit) : lines.length;
				markSeen(resolve(process.cwd(), path), hashes.slice(start, end));
				const body = lines
					.slice(start, end)
					.map((l, i) => `${hashes[start + i]}${SEP}${l}`)
					.join("\n");
				return ok(body || "(empty file — use hedit with from/to omitted to insert)");
			} catch (e) {
				return err(`hread error: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "hedit",
		label: "hedit",
		description:
			"Replace line ranges in a file by HASH anchors (from hread) — no need to re-quote old text. " +
			"changes: [{from:'<startHash>', to:'<endHash>', lines:[...new lines...]}]. from/to inclusive; " +
			"lines replaces that range (empty lines[] deletes it). Stale anchors are rejected — re-run hread.",
		promptSnippet: "hedit(path, changes) — replace line ranges by HASH (cheap, staleness-safe)",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				changes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							from: { type: "string", description: "start hash (3-char)" },
							to: { type: "string", description: "end hash (3-char, inclusive)" },
							lines: {
								type: "array",
								items: { type: "string" },
								description: "replacement lines (empty = delete range)",
							},
						},
						required: ["from", "to", "lines"],
					},
				},
			},
			required: ["path", "changes"],
		},
		async execute(
			_id: string,
			params: { path?: unknown; changes?: Array<{ from?: unknown; to?: unknown; lines?: unknown[] }> },
		): Promise<ToolResult> {
			const path = String(params.path ?? "");
			const changes = (params.changes as Array<{ from: string; to: string; lines: unknown }>) ?? [];
			const cwd = process.cwd();
			const abs = resolve(cwd, path);
			let lines: string[];
			let hashes: string[];
			try {
				({ lines, hashes } = readLines(path, cwd));
			} catch (e) {
				return err(`hedit error: ${(e as Error).message}`);
			}

			const idxOf = (h: string) => hashes.indexOf(h);
			const shown = seen.get(abs);
			const resolved: Array<{ s: number; e: number; lines: string[] }> = [];
			for (const ch of changes) {
				if (shown && (!shown.has(ch.from) || !shown.has(ch.to)))
					return err(
						`[E_UNSEEN] anchor '${!shown.has(ch.from) ? ch.from : ch.to}' was never shown by hread on this file — ` +
							"you can't edit a line you didn't read. Run hread (covering the target range) first.",
					);
				const s = idxOf(ch.from);
				const e = idxOf(ch.to);
				if (s < 0)
					return err(
						`[E_STALE] anchor '${ch.from}' not found — file changed since hread. Re-run hread for fresh anchors.`,
					);
				if (e < 0) return err(`[E_STALE] anchor '${ch.to}' not found — re-run hread.`);
				if (e < s) return err(`[E_RANGE] end '${ch.to}' is before start '${ch.from}'.`);
				resolved.push({ s, e, lines: unwrapLines(ch.lines) });
			}
			// Apply back-to-front so indices stay valid; reject overlaps.
			resolved.sort((a, b) => b.s - a.s);
			for (let i = 1; i < resolved.length; i++)
				if (resolved[i].e >= resolved[i - 1].s)
					return err("[E_OVERLAP] overlapping ranges in one hedit — split them.");

			let changed = 0;
			for (const r of resolved) {
				lines.splice(r.s, r.e - r.s + 1, ...r.lines);
				changed += r.e - r.s + 1;
			}
			try {
				writeFileSync(abs, lines.join("\n"));
			} catch (e) {
				return err(`hedit write failed: ${(e as Error).message}`);
			}
			return ok(
				`Applied ${resolved.length} change(s) to ${path} (${changed} lines replaced). ` +
					`New line count: ${lines.length}.`,
			);
		},
	});

	pi.registerTool({
		name: "hedit_block",
		label: "hedit block",
		description:
			"Replace or delete a whole enclosing block (function/class/method/if/loop) by its START hash anchor — " +
			"you don't count the closing brace, the tool finds it (tree-sitter when available, else a brace scanner). " +
			"{from:'<startHash>', lines:[...new block...]} replaces the construct starting at that line through its end; " +
			"empty lines[] deletes it. Use hedit for line-range or non-block edits.",
		promptSnippet: "hedit_block(path, from, lines) — replace a whole block by its start hash (no counting braces)",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				from: { type: "string", description: "hash of the construct's FIRST line (from hread)" },
				lines: {
					type: "array",
					items: { type: "string" },
					description: "replacement block lines (empty = delete)",
				},
			},
			required: ["path", "from", "lines"],
		},
		async execute(_id: string, params: { path?: unknown; from?: unknown; lines?: unknown[] }): Promise<ToolResult> {
			const path = String(params.path ?? "");
			const from = String(params.from ?? "");
			const cwd = process.cwd();
			const abs = resolve(cwd, path);
			let lines: string[];
			let hashes: string[];
			try {
				({ lines, hashes } = readLines(path, cwd));
			} catch (e) {
				return err(`hedit_block error: ${(e as Error).message}`);
			}
			const shown = seen.get(abs);
			if (shown && !shown.has(from))
				return err(`[E_UNSEEN] anchor '${from}' was never shown by hread — run hread first.`);
			const s = hashes.indexOf(from);
			if (s < 0) return err(`[E_STALE] anchor '${from}' not found — re-run hread.`);
			const e = resolveBlockEnd(lines, s, path);
			if (e < 0)
				return err(`[E_NO_BLOCK] no block found from '${from}'. Use hedit with an explicit line range instead.`);
			const newLines = unwrapLines(params.lines);
			const removed = e - s + 1;
			lines.splice(s, removed, ...newLines);
			try {
				writeFileSync(abs, lines.join("\n"));
			} catch (e2) {
				return err(`hedit_block write failed: ${(e2 as Error).message}`);
			}
			return ok(
				`Replaced block (lines ${s + 1}–${e + 1}, ${removed} lines) in ${path} ` +
					`with ${newLines.length}. New line count: ${lines.length}.`,
			);
		},
	});
}
