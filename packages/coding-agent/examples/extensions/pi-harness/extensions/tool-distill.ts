/**
 * tool-distill.ts — shrink tool results to their high-signal core BEFORE they
 * enter context, so the lean version (not the raw dump) is what gets re-sent on
 * every subsequent turn. Directly attacks the dominant cost: re-sent context.
 *
 * Principle (Anthropic "writing tools for agents"): tool responses should be
 * high-signal — filtered/ranked/truncated at the source. This is lossless in the
 * sense that matters: the full output is externalized to a file and the excerpt
 * tells the model how to recover it (rg / bounded read), so nothing is
 * destroyed — it's just not carried in the hot context turn after turn.
 *
 * Type-aware, because different tools distill differently:
 *   - grep/find/rg      → cap to top-N ranked lines + count of the rest
 *   - file reads        → keep as-is if small; if huge, this defers to
 *                         context-economy's cap (we don't second-guess a
 *                         deliberate read)
 *   - bash              → head+tail with middle elided; structured for logs
 *   - knowledge_*       → the brain already returns compact cited bundles; pass
 *                         through unless oversized
 *   - default           → line-cap with externalized recovery
 *
 * Ordering: load BEFORE context-economy.ts so distillation runs first and the
 * 30k hard cap only catches whatever is still huge after distillation.
 *
 * Config:
 *   KP_DISTILL_ENABLED=0     disable
 *   KP_DISTILL_MAX_LINES     line cap for list-like output (default 60)
 *   KP_DISTILL_MAX_CHARS     char cap before externalizing (default 6000)
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { record as hrRecord, render as hrRender } from "./headroom-ledger.ts";

const ENABLED = process.env.KP_DISTILL_ENABLED !== "0";
const MAX_LINES = Number(process.env.KP_DISTILL_MAX_LINES || 100); // grep/find lines are cheap (1 line each) — keep a generous window
const MAX_CHARS = Number(process.env.KP_DISTILL_MAX_CHARS || 8000);
const HEAD_LINES = 40;
const TAIL_LINES = 12;
const DIR = join(tmpdir(), "pi-distill");

// Tools whose output is already compact/curated — don't touch.
// Tools whose output is left fully intact (edits/reads/session tools). knowledge_* is NOT here:
// its JSON is scrubbed for embeddings/vectors + size-capped like any other JSON tool (it used to
// pass through wholesale, which is how 1024-float embeddings rode into context).
const PASSTHROUGH = /^(edit$|write$|read$|session_search$|session_fetch$|lcm_)/;

function externalize(full: string): string {
	try {
		mkdirSync(DIR, { recursive: true });
		const path = join(DIR, `${createHash("sha1").update(full).digest("hex").slice(0, 12)}.txt`);
		writeFileSync(path, full);
		return path;
	} catch {
		return "";
	}
}

function textOf(content: any[]): { text: string; nonText: any[] } {
	const nonText = content.filter((b) => b.type !== "text");
	const text = content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	return { text, nonText };
}

/** List-like output (grep/find/ls): keep the most useful lines, count the rest. */
function distillList(text: string, tool: string): string | null {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES) return null; // already fine
	const path = externalize(text);
	const kept = lines.slice(0, MAX_LINES);
	return (
		`[distilled ${tool}: ${lines.length} lines → first ${MAX_LINES}]` +
		(path ? ` full: ${path} (rg '<pat>' ${path} | head)` : "") +
		`\n${kept.join("\n")}\n… ${lines.length - MAX_LINES} more lines omitted`
	);
}

/** Heuristic: is this bash output list-like (grep/find/ls dump) vs a log/stream?
 *  List-like = many lines, low length variance, no obvious log timestamps. */
function looksListLike(lines: string[]): boolean {
	if (lines.length < MAX_LINES) return false;
	const sample = lines.slice(0, 50).filter((l) => l.trim());
	if (!sample.length) return false;
	const lens = sample.map((l) => l.length);
	const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
	const variance = lens.reduce((a, l) => a + (l - avg) ** 2, 0) / lens.length;
	const cv = avg > 0 ? Math.sqrt(variance) / avg : 0; // coefficient of variation
	const hasTimestamps =
		sample.filter((l) => /\b\d{2}:\d{2}:\d{2}\b|\d{4}-\d{2}-\d{2}/.test(l)).length > sample.length * 0.3;
	return cv < 0.6 && !hasTimestamps; // uniform lines, not timestamped → list, not log
}

/** bash output: list-like → top-N (grep/find via bash); otherwise head+tail (logs). */
function distillBash(text: string): string | null {
	const lines = text.split("\n");
	if (text.length <= MAX_CHARS && lines.length <= MAX_LINES + TAIL_LINES) return null;
	// grep/find/ls run through bash produce list output — top-N beats head+tail
	// (matches aren't ordered by importance; an arbitrary tail wastes context).
	if (looksListLike(lines)) return distillList(text, "bash");
	const path = externalize(text);
	const head = lines.slice(0, HEAD_LINES);
	const tail = lines.slice(-TAIL_LINES);
	const omitted = lines.length - HEAD_LINES - TAIL_LINES;
	if (omitted <= 0) return null;
	return (
		`[distilled bash: ${lines.length} lines, ${text.length} chars]` +
		(path ? ` full: ${path}` : "") +
		`\n--- head ---\n${head.join("\n")}\n… ${omitted} lines elided …\n--- tail ---\n${tail.join("\n")}`
	);
}

/** Generic: char-cap with externalized recovery. */
function distillGeneric(text: string, tool: string): string | null {
	if (text.length <= MAX_CHARS) return null;
	const path = externalize(text);
	return (
		`[distilled ${tool}: ${text.length} chars → first ${MAX_CHARS}]` +
		(path ? ` full: ${path}` : "") +
		`\n${text.slice(0, MAX_CHARS)}\n… truncated`
	);
}

// Fields that are pure noise in any tool's JSON — derived indexes an agent never reads.
const NOISE_KEY = /(_embedding$|^embedding$|_vector$|^vector$)/;
const LONG_ARRAY = 32; // numeric arrays longer than this are almost certainly a vector/blob

/** SmartCrusher — LOSSLESS-TO-THE-LLM structural JSON compression. The rule: remove REDUNDANCY,
 * never INFORMATION. Every fact/value the model would read is preserved; only repeated structure
 * (schema, key names) and true noise (embeddings) are removed. Two transforms:
 *
 *  1. Noise strip: drop *_embedding/*_vector keys + collapse inline float vectors. (Never info.)
 *  2. Tabular fold: an array of objects that share a key shape repeats every key name N times
 *     ("fact"×20, "state"×20…). Fold it to columnar form: {__table:[keys], rows:[[v,v],…]} — the
 *     schema is stated ONCE and every value is kept verbatim. Reversible: the header names the
 *     columns so the model reads it exactly like the objects. This is where the real tokens are.
 *
 * NOT truncation: no value is dropped, capped, or elided (except embeddings, which carry no
 * meaning). If a fold doesn't apply, the value passes through unchanged. */
function smartCrush(v: any): any {
	if (Array.isArray(v)) {
		if (v.length > LONG_ARRAY && v.every((x) => typeof x === "number")) {
			return `⟨${v.length} floats elided⟩`; // an embedding — noise, not information
		}
		const crushed = v.map(smartCrush);
		return foldTable(crushed);
	}
	if (v && typeof v === "object") {
		const out: any = {};
		for (const [k, val] of Object.entries(v)) {
			if (NOISE_KEY.test(k)) continue; // drop embedding/vector keys entirely (noise)
			out[k] = smartCrush(val);
		}
		return out;
	}
	return v;
}

/** Fold an array of same-shape objects into columnar form — schema stated ONCE, all values kept.
 * {a,b} × N  →  {__cols:["a","b"], rows:[[v,v],…]}. Lossless: every value preserved verbatim; only
 * the repeated key names are removed. Only folds when it's a real win (≥4 objects, ≥2 shared keys,
 * uniform shape) — otherwise returns the array untouched. */
function foldTable(arr: any[]): any {
	if (arr.length < 4) return arr;
	if (!arr.every((o) => o && typeof o === "object" && !Array.isArray(o))) return arr;
	const cols = Object.keys(arr[0]);
	if (cols.length < 2) return arr;
	// every object must have EXACTLY these keys (uniform shape) — else folding would lose which
	// keys a given row had. Non-uniform → leave as objects (correctness over compression).
	const uniform = arr.every((o) => {
		const k = Object.keys(o);
		return k.length === cols.length && cols.every((c) => c in o);
	});
	if (!uniform) return arr;
	return { __cols: cols, rows: arr.map((o) => cols.map((c) => o[c])) };
}

/** SmartCrusher entry: parse tool JSON, structurally compress (noise strip + tabular fold), and
 * rewrite ONLY if it shrank. LOSSLESS TO THE LLM — every value survives; the full pre-crush text
 * is also externalized so nothing is ever unrecoverable. Never truncates a crushed result. */
function distillJson(text: string, _tool: string): string | null {
	const t = text.trimStart();
	if (t[0] !== "{" && t[0] !== "[") return null; // not JSON
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const crushed = smartCrush(parsed);
	const out = JSON.stringify(crushed);
	if (out.length >= text.length) return null; // nothing to gain
	// If the CRUSHED form is still very large, externalize the original for recovery but DO NOT
	// truncate the crushed content — the model still needs every value. A note points to the full
	// file; the crushed JSON is returned whole (folding already removed the redundancy).
	if (out.length > MAX_CHARS) {
		const path = externalize(text);
		return (path ? `[headroom: crushed ${text.length}→${out.length} chars, full source: ${path}]\n` : "") + out;
	}
	return out;
}

const est = (s: string) => Math.ceil(s.length / 4); // rough tokens

export default function (pi: any) {
	if (!ENABLED) return;

	// Coverage accounting per tool: how much entered raw vs got distilled, and how
	// many tokens were saved from entering context. Surfaces what's still bleeding.
	type Row = { calls: number; distilled: number; passthrough: number; inTok: number; savedTok: number };
	const cov = new Map<string, Row>();
	const row = (t: string): Row => {
		if (!cov.has(t)) cov.set(t, { calls: 0, distilled: 0, passthrough: 0, inTok: 0, savedTok: 0 });
		return cov.get(t)!;
	};

	pi.on("tool_result", async (event: any) => {
		if (event.isError) return; // keep errors intact — the model needs the full message
		const tool: string = event.toolName || "";
		const { text, nonText } = textOf(event.content ?? []);
		if (!text) return;

		const r = row(PASSTHROUGH.test(tool) ? `${tool} (passthrough)` : tool);
		r.calls++;
		r.inTok += est(text);

		if (PASSTHROUGH.test(tool)) {
			r.passthrough++;
			return;
		}

		let distilled: string | null = null;
		if (/^(grep|find|ls|rg|glob)$/.test(tool)) distilled = distillList(text, tool);
		else if (tool === "bash") distilled = distillBash(text);
		else distilled = distillJson(text, tool) ?? distillGeneric(text, tool); // JSON scrub first (embeddings/vectors), then char-cap

		if (!distilled) {
			r.passthrough++;
			return;
		} // under threshold — left as-is
		r.distilled++;
		r.savedTok += Math.max(0, est(text) - est(distilled));
		// Report to the unified headroom ledger. JSON tools that got the SmartCrusher fold are tagged
		// separately so /headroom shows structural-JSON savings distinctly from list/bash distillation.
		const kind = /^(grep|find|ls|rg|glob|bash)$/.test(tool)
			? `distill:${tool}`
			: distilled.trimStart().startsWith("{") || distilled.trimStart().startsWith("[")
				? "smartcrush"
				: "distill:generic";
		hrRecord(kind, est(text), est(distilled));
		return { content: [{ type: "text", text: distilled }, ...nonText] };
	});

	pi.registerCommand("headroom", {
		description:
			"Unified context-compression dashboard: tokens reclaimed across SmartCrusher + tool-distill + compress + LCM",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(hrRender(), "info");
		},
	});

	pi.registerCommand("distill-stats", {
		description: "Tool-result distillation coverage: per tool, what entered raw vs distilled + tokens saved",
		handler: async (_args: string, ctx: any) => {
			if (!cov.size) {
				ctx.ui.notify("No tool results seen this session yet.", "info");
				return;
			}
			const rows = [...cov.entries()].sort((a, b) => b[1].inTok - a[1].inTok);
			const totalSaved = rows.reduce((n, [, r]) => n + r.savedTok, 0);
			const totalIn = rows.reduce((n, [, r]) => n + r.inTok, 0);
			const lines = [
				`Distillation coverage — ${totalSaved >= 1000 ? `${(totalSaved / 1000).toFixed(1)}k` : totalSaved} tok kept out of context (of ${totalIn >= 1000 ? `${(totalIn / 1000).toFixed(1)}k` : totalIn} seen)`,
				"",
				...rows.map(([t, r]) => {
					const rate = r.calls ? Math.round((r.distilled / r.calls) * 100) : 0;
					const saved = r.savedTok >= 1000 ? `${(r.savedTok / 1000).toFixed(1)}k` : `${r.savedTok}`;
					return `  ${t.padEnd(22)} ${r.calls}× · ${r.distilled} distilled/${r.passthrough} pass (${rate}%) · saved ${saved} tok`;
				}),
				"",
				"high inTok + low distill% = something entering context raw (candidate to distill).",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
