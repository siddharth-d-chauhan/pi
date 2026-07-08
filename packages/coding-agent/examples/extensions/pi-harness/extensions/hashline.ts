/**
 * hashline.ts — hash-anchored edits: reference lines by a short content hash
 * instead of re-quoting them. The one measured edit-efficiency win the ecosystem
 * comparison surfaced (oh-my-pi / pi-hashline-edit-pro: ~50-61% token savings on
 * edits + large edit-success gains) — a lever neither Claude Code nor opencode has.
 *
 * How it works:
 *  - hread(path) returns each line prefixed `HASH│content`, where HASH is a
 *    3-char hash of the line's content (unique per file via collision-retry).
 *  - hedit(path, changes) replaces line RANGES by hash: each change is
 *    {from: "<startHash>", to: "<endHash>", lines: [...new content...]}. The OLD
 *    text is never re-sent — just two 3-char anchors. That's the token win.
 *  - Staleness safety: if a line changed since read, its hash changed, so a stale
 *    anchor is REJECTED (call hread again) — no silent wrong-line edits.
 *
 * We add these as NEW tools (hread/hedit) rather than overriding builtin read/edit,
 * so nothing breaks and the model opts in via policy. Guardrails still apply:
 * hedit routes through the same file-write path, so protected-path/secret rules in
 * guardrails.ts and gates.ts continue to gate it (it writes files like any edit).
 *
 * Zero-dependency: a small fast string hash (FNV-1a) over the line's canonical
 * form gives ample uniqueness within one file (with collision-retry) — no wasm dep.
 *
 * Config: KP_HASHLINE_ENABLED=0 disable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENABLED = process.env.KP_HASHLINE_ENABLED !== "0";
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
// FIX: the harness input pre-processor sometimes wraps large string arrays as
// [{item:"..."}, {item:"..."}] instead of ["...", "..."] (seen when a model
// sends many changes in one hedit call). Unwrap defensively so the tool
// works with either format. Falls back to String(x) for anything else.
function unwrapLines(arr: any): string[] {
	if (!Array.isArray(arr)) return [];
	return arr.map((x: any) => {
		if (typeof x === "string") return x;
		if (x && typeof x === "object") {
			if (typeof x.item === "string") return x.item;
			if (typeof x.text === "string") return x.text;
			if (typeof x.value === "string") return x.value;
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

/** Unique 3-char hash per line (collision-retry, like pi-hashline-edit-pro). */
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

/**
 * Block resolver: given a start line inside/at a brace-delimited construct, find
 * the line index of its matching close brace. String/comment/char-literal aware
 * (so braces in strings don't miscount). Returns the end line index, or -1 if the
 * language isn't brace-delimited (Python/indent) or no block is found.
 */
function resolveBlockEnd(lines: string[], startIdx: number): number {
	let depth = 0,
		started = false;
	let inStr = "",
		inLineComment = false,
		inBlockComment = false,
		esc = false;
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		inLineComment = false;
		for (let j = 0; j < line.length; j++) {
			const ch = line[j],
				nx = line[j + 1];
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

export default function (pi: any) {
	if (!ENABLED) return;

	// Seen-lines guard (oh-my-pi's real anti-corruption teeth): track which hashes
	// hread actually SHOWED per file. hedit rejects an anchor the model never saw
	// (partial read / summarized / hallucinated from memory) — prevents editing a
	// line it didn't actually look at.
	const seen = new Map<string, Set<string>>(); // absPath → set of shown hashes
	const markSeen = (abs: string, hs: string[]) => {
		let s = seen.get(abs);
		if (!s) {
			s = new Set();
			seen.set(abs, s);
		}
		for (const h of hs) s.add(h);
	};

	// Nudge the model to use the hash-anchored flow for edits (fewer tokens, safer).
	pi.on("before_agent_start", async (event: any) => ({
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
		async execute(_id: string, params: any) {
			try {
				const { lines, hashes } = readLines(params.path, process.cwd());
				const start = Math.max(0, (params.offset ?? 1) - 1);
				const end = params.limit ? Math.min(lines.length, start + params.limit) : lines.length;
				markSeen(resolve(process.cwd(), params.path), hashes.slice(start, end));
				const body = lines
					.slice(start, end)
					.map((l, i) => `${hashes[start + i]}${SEP}${l}`)
					.join("\n");
				return {
					content: [{ type: "text", text: body || "(empty file — use hedit with from/to omitted to insert)" }],
				};
			} catch (e: any) {
				return { content: [{ type: "text", text: `hread error: ${e.message}` }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "hedit",
		label: "hedit",
		description:
			"Replace line ranges in a file by HASH anchors (from hread) — no need to re-quote old text. " +
			"changes: [{from:'<startHash>', to:'<endHash>', lines:[...new lines...]}]. from/to inclusive; " +
			"lines replaces that range (empty lines[] deletes it). Stale anchors are rejected — re-run hread. " +
			"To insert without replacing, set from/to to the anchor AFTER which to insert and include the anchored line in lines.",
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
		async execute(_id: string, params: any) {
			const cwd = process.cwd();
			const abs = resolve(cwd, params.path);
			let lines: string[], hashes: string[];
			try {
				({ lines, hashes } = readLines(params.path, cwd));
			} catch (e: any) {
				return { content: [{ type: "text", text: `hedit error: ${e.message}` }], isError: true };
			}

			const idxOf = (h: string) => hashes.indexOf(h);
			const shown = seen.get(abs);
			// Resolve + validate all changes against CURRENT hashes (staleness check).
			const resolved: { s: number; e: number; lines: string[] }[] = [];
			for (const ch of params.changes ?? []) {
				// Seen-lines guard: reject anchors the model never actually saw via hread.
				if (shown && (!shown.has(ch.from) || !shown.has(ch.to)))
					return {
						content: [
							{
								type: "text",
								text: `[E_UNSEEN] anchor '${!shown.has(ch.from) ? ch.from : ch.to}' was never shown by hread on this file — you can't edit a line you didn't read. Run hread (covering the target range) first.`,
							},
						],
						isError: true,
					};
				const s = idxOf(ch.from),
					e = idxOf(ch.to);
				if (s < 0)
					return {
						content: [
							{
								type: "text",
								text: `[E_STALE] anchor '${ch.from}' not found — file changed since hread. Re-run hread for fresh anchors.`,
							},
						],
						isError: true,
					};
				if (e < 0)
					return {
						content: [{ type: "text", text: `[E_STALE] anchor '${ch.to}' not found — re-run hread.` }],
						isError: true,
					};
				if (e < s)
					return {
						content: [{ type: "text", text: `[E_RANGE] end '${ch.to}' is before start '${ch.from}'.` }],
						isError: true,
					};
				resolved.push({ s, e, lines: unwrapLines(ch.lines) });
			}
			// Apply back-to-front so indices stay valid; reject overlaps.
			resolved.sort((a, b) => b.s - a.s);
			for (let i = 1; i < resolved.length; i++)
				if (resolved[i].e >= resolved[i - 1].s)
					return {
						content: [{ type: "text", text: "[E_OVERLAP] overlapping ranges in one hedit — split them." }],
						isError: true,
					};

			let changed = 0;
			for (const r of resolved) {
				lines.splice(r.s, r.e - r.s + 1, ...r.lines);
				changed += r.e - r.s + 1;
			}
			try {
				writeFileSync(abs, lines.join("\n"));
			} catch (e: any) {
				return { content: [{ type: "text", text: `hedit write failed: ${e.message}` }], isError: true };
			}
			return {
				content: [
					{
						type: "text",
						text: `Applied ${resolved.length} change(s) to ${params.path} (${changed} lines replaced). New line count: ${lines.length}.`,
					},
				],
			};
		},
	});

	// Block edit (oh-my-pi): replace/delete a WHOLE brace-delimited construct by its
	// START anchor — no need to find/count the closing brace. Resolves the matching
	// close via a string/comment-aware scanner.
	pi.registerTool({
		name: "hedit_block",
		label: "hedit block",
		description:
			"Replace or delete a whole brace-delimited block (function/class/method/if/loop) by its START hash anchor — " +
			"you don't count the closing brace, the tool finds it. {from:'<startHash>', lines:[...new block...]} replaces " +
			"the construct starting at that line through its matching '}'; empty lines[] deletes it. For brace languages " +
			"(JS/TS/Java/Go/C/…). Use hedit for line-range or non-brace edits.",
		promptSnippet:
			"hedit_block(path, from, lines) — replace a whole {…} construct by its start hash (no counting braces)",
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
		async execute(_id: string, params: any) {
			const cwd = process.cwd();
			const abs = resolve(cwd, params.path);
			let lines: string[], hashes: string[];
			try {
				({ lines, hashes } = readLines(params.path, cwd));
			} catch (e: any) {
				return { content: [{ type: "text", text: `hedit_block error: ${e.message}` }], isError: true };
			}
			const shown = seen.get(abs);
			if (shown && !shown.has(params.from))
				return {
					content: [
						{
							type: "text",
							text: `[E_UNSEEN] anchor '${params.from}' was never shown by hread — run hread first.`,
						},
					],
					isError: true,
				};
			const s = hashes.indexOf(params.from);
			if (s < 0)
				return {
					content: [{ type: "text", text: `[E_STALE] anchor '${params.from}' not found — re-run hread.` }],
					isError: true,
				};
			const e = resolveBlockEnd(lines, s);
			if (e < 0)
				return {
					content: [
						{
							type: "text",
							text: `[E_NO_BLOCK] no brace-delimited block found from '${params.from}'. Use hedit with an explicit line range (or this file isn't a brace language).`,
						},
					],
					isError: true,
				};
			const newLines = unwrapLines(params.lines);
			const removed = e - s + 1;
			lines.splice(s, removed, ...newLines);
			try {
				writeFileSync(abs, lines.join("\n"));
			} catch (err: any) {
				return { content: [{ type: "text", text: `hedit_block write failed: ${err.message}` }], isError: true };
			}
			return {
				content: [
					{
						type: "text",
						text: `Replaced block (lines ${s + 1}–${e + 1}, ${removed} lines) in ${params.path} with ${newLines.length}. New line count: ${lines.length}.`,
					},
				],
			};
		},
	});
}

// # FIX_HEDIT_SERIALIZATION
