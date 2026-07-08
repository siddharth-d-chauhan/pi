/**
 * compress.ts — content-aware output compression (RTK + Headroom, done natively).
 *
 * tool-distill.ts caps oversized output BLUNTLY (top-N / head+tail). That's the
 * right net for unknown output, but it's wrong for two high-value cases and
 * leaves a third on the table. This adds the content-aware layer, reusing our
 * externalize-and-recover so nothing is ever destroyed:
 *
 *  1. RTK — command-aware distillers (keyed off the bash `input.command`):
 *     • test runners (pytest/jest/vitest/cargo test/go test/rspec/mocha) →
 *       FAILURES-ONLY + a counts summary. This is also a CORRECTNESS fix: a
 *       generic head+tail can truncate the middle, which is exactly where a
 *       failing assertion lives — so today the model can be told "tests ran"
 *       with the failure elided. We parse the failures out explicitly.
 *     • git status/diff --stat/log → compact structured summary.
 *     • grep/find/ls dumps → grouped-by-file with counts.
 *     • web_search → large source LISTS trimmed to a generous budget (700-char
 *       excerpt/source, ~2k tok cap); fetch_content (a page you're READING) is
 *       kept nearly whole, only head+tail'd if enormous. Full result always
 *       externalized. Deliberately GENTLE so deep research isn't crippled;
 *       KP_COMPRESS_WEB=0 turns it off entirely for a heavy-research session.
 *
 *  2. Headroom — AST-aware file compression (vendored web-tree-sitter, in-process,
 *     no Python/venv): when a large SOURCE file enters context, keep imports +
 *     signatures and COLLAPSE function/method bodies to a one-line marker. The
 *     model sees the file's shape at a fraction of the tokens; the full file is
 *     externalized and it can read the specific body on demand (Headroom's CCR).
 *
 * Ordering: load BEFORE tool-distill.ts. compress handles the cases it knows and
 * RETURNS the compact result; tool-distill then sees the already-small output and
 * passes it through. Anything compress doesn't touch falls through to distill's
 * generic cap. Everything compress emits is well under distill's thresholds.
 *
 * Recovery (never lossy in the way that matters): the full raw output / full file
 * is written to a temp file and the compact form names it + how to recover
 * (rg / bounded read / expand a body).
 *
 * Config:
 *   KP_COMPRESS_ENABLED=0     disable everything here
 *   KP_COMPRESS_AST=0         disable only the AST file layer (keep command distillers)
 *   KP_COMPRESS_MIN_LINES     min lines before a test/list distill kicks in (default 40)
 *   KP_COMPRESS_AST_MIN_CHARS min file size before AST collapse (default 4000)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.KP_COMPRESS_ENABLED !== "0";
const AST_ENABLED = process.env.KP_COMPRESS_AST !== "0";
const MIN_LINES = Number(process.env.KP_COMPRESS_MIN_LINES || 40);
// 1800 chars ≈ a real service/controller class. Java (the primary corpus) is
// verbose but body-heavy — files cluster just under 2k and their bodies are
// exactly the noise when scanning structure. Trivial POJOs stay under it.
const AST_MIN_CHARS = Number(process.env.KP_COMPRESS_AST_MIN_CHARS || 1800);

const DIR = join(tmpdir(), "pi-compress");
function externalize(text: string, tag = "out"): string | null {
	try {
		mkdirSync(DIR, { recursive: true });
		const h = createHash("sha1").update(text).digest("hex").slice(0, 12);
		const p = join(DIR, `${tag}-${h}.txt`);
		if (!existsSync(p)) writeFileSync(p, text);
		return p;
	} catch {
		return null;
	}
}

const est = (s: string) => Math.ceil(s.length / 4);
function textOf(content: any[]): { text: string; nonText: any[] } {
	const nonText = (content ?? []).filter((b) => b.type !== "text");
	const text = (content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n");
	return { text, nonText };
}

// ---------------------------------------------------------------------------
// RTK: command classification off the originating bash command
// ---------------------------------------------------------------------------
type CmdKind = "test" | "git-status" | "git-log" | "git-diff" | "list" | "other";
function classify(command: string): CmdKind {
	const c = command.trim();
	if (
		/\b(pytest|py\.test|jest|vitest|cargo\s+test|go\s+test|rspec|mocha|ava|\bphpunit|gradle(w)?\s+test|mvn\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+(run\s+)?test)\b/.test(
			c,
		)
	)
		return "test";
	if (/\bgit\s+status\b/.test(c)) return "git-status";
	if (/\bgit\s+log\b/.test(c)) return "git-log";
	if (/\bgit\s+diff\b/.test(c)) return "git-diff";
	if (/\b(grep|rg|find|ls|fd)\b/.test(c)) return "list";
	return "other";
}

// RTK-style repeated-line collapse: runs of the SAME line → one line + "(×N)".
// Attacks a common waste source (repeated log/progress/stack lines). Lossless in
// meaning (the count is kept). Applied to bash output before other distillation.
function collapseRepeats(text: string): { out: string; saved: number } {
	const lines = text.split("\n");
	if (lines.length < 8) return { out: text, saved: 0 };
	const res: string[] = [];
	let i = 0,
		collapsed = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const run = j - i;
		if (run >= 3 && lines[i].trim()) {
			res.push(`${lines[i]}   (×${run})`);
			collapsed += run - 1;
		} else for (let k = i; k < j; k++) res.push(lines[k]);
		i = j;
	}
	return { out: res.join("\n"), saved: collapsed };
}

// Pull the failing-test signal out of a runner's output, language-agnostic.
// We keep: the summary/tallies line(s), every FAIL/ERROR line, and a window of
// context around each failure (the assertion + traceback head). Passing noise is
// dropped. If we can't find any failure markers, we DON'T distill (return null)
// so a genuinely-passing run is left to the generic cap — never hide a failure.
function distillTest(text: string): string | null {
	const lines = text.split("\n");
	if (lines.length < MIN_LINES) return null;

	const FAIL =
		/\b(FAIL(ED|URE)?|ERROR|panic:|AssertionError|Traceback|✗|✖|×|not ok\b|●|expected .* (?:but|to)|thread '.*' panicked)\b/i;
	const SUMMARY =
		/\b(\d+\s+(passed|failed|error|skipped|ok)|(\d+)\s+passing|(\d+)\s+failing|Tests?:\s|test result:|Ran\s+\d+\s+test|=+\s*(FAILURES|ERRORS|short test summary|test session)|\bPASS\b|\bFAIL\b|failures=\d+|OK\b|BUILD (SUCCESS|FAILURE))/i;
	const PASS_NOISE = /\b(PASS(ED)?|ok\b|✓|✔|\.\.\.\s*ok|passing)\b/i;

	// indexes of failure lines
	const failIdx: number[] = [];
	lines.forEach((l, i) => {
		if (FAIL.test(l)) failIdx.push(i);
	});

	// If nothing looks like a failure, this is (probably) a green run — leave it.
	if (!failIdx.length) return null;

	// collect: all summary lines + a context window around each failure
	const keep = new Set<number>();
	lines.forEach((l, i) => {
		if (SUMMARY.test(l) && !PASS_NOISE.test(l.replace(SUMMARY, ""))) keep.add(i);
	});
	// always keep the last few lines (final tally usually lives there)
	for (let i = Math.max(0, lines.length - 6); i < lines.length; i++) keep.add(i);
	const CTX_BEFORE = 1,
		CTX_AFTER = 8;
	for (const fi of failIdx)
		for (let i = Math.max(0, fi - CTX_BEFORE); i <= Math.min(lines.length - 1, fi + CTX_AFTER); i++) keep.add(i);

	const idxs = [...keep].sort((a, b) => a - b);
	// render with gap markers
	const out: string[] = [];
	let prev = -1;
	for (const i of idxs) {
		if (prev >= 0 && i > prev + 1) out.push(`  … ${i - prev - 1} line(s) …`);
		out.push(lines[i]);
		prev = i;
	}
	const path = externalize(text, "test");
	const savedRatio = Math.round((1 - out.length / lines.length) * 100);
	return (
		`[compress: test output — ${failIdx.length} failure marker(s), ${lines.length}→${out.length} lines (−${savedRatio}%)` +
		(path ? `, full: ${path}` : "") +
		`]\n` +
		out.join("\n")
	);
}

function distillGitStatus(text: string): string | null {
	const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
	// porcelain-ish or human `git status`; summarize file states
	const files: Record<string, string[]> = {};
	const add = (k: string, f: string) => {
		files[k] ??= [];
		files[k].push(f);
	};
	for (const l of lines) {
		const m1 = l.match(/^\s*(modified|new file|deleted|renamed|copied|typechange):\s+(.*)$/);
		if (m1) {
			add(m1[1], m1[2]);
			continue;
		}
		const m2 = l.match(/^\s?([MADRCU?! ]{1,2})\s+(.*)$/); // porcelain
		if (m2?.[1].trim()) {
			add(m2[1].trim(), m2[2]);
		}
	}
	const total = Object.values(files).reduce((a, v) => a + v.length, 0);
	if (!total) return null; // clean tree or unrecognized — leave it
	if (text.length < 400) return null; // already tiny
	const path = externalize(text, "gitstatus");
	const summary = Object.entries(files)
		.map(([k, v]) => `${k}: ${v.length}${v.length <= 6 ? ` (${v.join(", ")})` : ""}`)
		.join("; ");
	const branch = (lines.find((l) => /^On branch |^## /.test(l)) || "").replace(/^## /, "On branch ").trim();
	return `[compress: git status → ${total} changed${path ? `, full: ${path}` : ""}]\n${branch ? `${branch}\n` : ""}${summary}`;
}

function distillGitLog(text: string): string | null {
	const lines = text.split("\n");
	if (lines.length < MIN_LINES) return null;
	// keep commit subject lines; drop bodies/diffs
	const commits = lines.filter((l) => /^commit [0-9a-f]{7,}|^[0-9a-f]{7,}\s/.test(l) || /^\s{4}\S/.test(l));
	if (commits.length < 3) return null;
	const path = externalize(text, "gitlog");
	const kept = commits.slice(0, 40);
	return `[compress: git log → ${kept.length} commit lines${path ? `, full: ${path}` : ""}]\n${kept.join("\n")}`;
}

// web result compression — DELIBERATELY GENTLE, so deep web research isn't
// crippled. Two very different cases:
//   web_search    → a LIST of source previews (title/url/snippet). Snippets are
//                   previews anyway, so a large list can be trimmed — but keep a
//                   generous budget + per-source excerpt so substance survives.
//   fetch_content → a PAGE you deliberately fetched to READ. Do NOT gut it:
//                   only cap truly enormous pages (head+tail), keep most of it.
// The FULL result is always externalized → nothing is lost; the agent can rg it.
// KP_COMPRESS_WEB=0 disables web compression entirely (raw results) for a heavy
// research session. Budgets are generous by default and env-tunable.
const WEB_OFF = process.env.KP_COMPRESS_WEB === "0";
const SEARCH_MAX = Number(process.env.KP_COMPRESS_WEB_MAX || 8000); // web_search list budget (~2k tok)
const SEARCH_SNIPPET = Number(process.env.KP_COMPRESS_WEB_SNIPPET || 700); // per-source excerpt chars
const FETCH_MAX = Number(process.env.KP_COMPRESS_FETCH_MAX || 24000); // fetch_content: only cap huge pages (~6k tok)

function distillWeb(text: string, kind: string): string | null {
	if (WEB_OFF) return null; // research mode — raw results, no compression

	// fetch_content: a page to READ. Keep it nearly whole; only head+tail if enormous.
	if (kind === "fetch_content") {
		if (text.length <= FETCH_MAX) return null; // keep the whole page
		const path = externalize(text, "web");
		const head = text.slice(0, Math.floor(FETCH_MAX * 0.75));
		const tail = text.slice(-Math.floor(FETCH_MAX * 0.2));
		return `[compress: fetched page ${est(text)}→~${est(head + tail)} tok (head+tail; full: ${path}, rg over it for specifics)]\n${head}\n\n… [middle elided — ${est(text) - est(head + tail)} tok in the full page] …\n\n${tail}`;
	}

	// web_search list: trim only when large; generous per-source excerpt.
	if (text.length <= SEARCH_MAX) return null; // reasonable list — leave it whole
	const path = externalize(text, "web");
	const blocks = text.split(/\n\s*\n/);
	const kept: string[] = [];
	let used = 0;
	for (const b of blocks) {
		const trimmed = b.length > SEARCH_SNIPPET ? `${b.slice(0, SEARCH_SNIPPET)} …` : b;
		if (used + trimmed.length > SEARCH_MAX) break;
		kept.push(trimmed);
		used += trimmed.length;
	}
	const shown = kept.join("\n\n");
	return (
		`[compress: ${kind} — ${est(text)}→${est(shown)} tok, snippets trimmed` +
		(path ? `, full: ${path} (rg '<term>' ${path})` : "") +
		`]\n${shown}` +
		(kept.length < blocks.length ? `\n… ${blocks.length - kept.length} more sources in the full result` : "")
	);
}

function distillList(text: string, kind: string): string | null {
	const lines = text.split("\n").filter((l) => l.length);
	if (lines.length < MIN_LINES) return null;
	// group by directory for path-like output; else top-N
	const looksPath = lines.slice(0, 30).filter((l) => l.includes("/")).length > 15;
	const path = externalize(text, "list");
	if (looksPath) {
		const byDir: Record<string, number> = {};
		for (const l of lines) {
			const f = l.split(":")[0];
			const d = dirname(f);
			byDir[d] = (byDir[d] || 0) + 1;
		}
		const dirs = Object.entries(byDir)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 30);
		return (
			`[compress: ${kind} → ${lines.length} lines across ${Object.keys(byDir).length} dirs${path ? `, full: ${path} (rg '<pat>' ${path})` : ""}]\n` +
			dirs.map(([d, n]) => `  ${d}/ (${n})`).join("\n") +
			`\n… ${lines.length} total matches`
		);
	}
	return `[compress: ${kind} → first 40 of ${lines.length} lines${path ? `, full: ${path}` : ""}]\n${lines.slice(0, 40).join("\n")}\n… ${lines.length - 40} more`;
}

// ---------------------------------------------------------------------------
// Headroom: AST-aware file collapse via vendored web-tree-sitter (lazy-loaded)
// ---------------------------------------------------------------------------
const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "tree-sitter");
// Languages whose function/method body is exposed as a `body` field child — the
// clean set our collapse relies on. Ruby is deliberately omitted: its `method`
// node has no `body` field (statements are direct children), so it falls through
// to the generic cap rather than risk a wrong collapse.
const GRAMMAR_BY_EXT: Record<string, string> = {
	".py": "python",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".ts": "typescript",
	".tsx": "tsx",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".h": "c",
};
// node types whose "body" child we collapse, per grammar.
const BODY_NODES: Record<string, string> = {
	python: "function_definition",
	javascript: "function_declaration|method_definition|arrow_function|function",
	typescript: "function_declaration|method_definition|arrow_function|function",
	tsx: "function_declaration|method_definition|arrow_function|function",
	go: "function_declaration|method_declaration",
	rust: "function_item",
	java: "method_declaration|constructor_declaration",
	c: "function_definition",
};

let _Parser: any = null;
let _initPromise: Promise<any> | null = null;
const _langCache = new Map<string, any>();

async function getParser(): Promise<any> {
	if (_Parser) return _Parser;
	if (!_initPromise) {
		_initPromise = (async () => {
			// web-tree-sitter 0.20.x ships CJS; require it from the vendored runtime.
			const { createRequire } = await import("node:module");
			const require = createRequire(import.meta.url);
			const P = require(join(VENDOR, "runtime", "tree-sitter.js"));
			await P.init();
			_Parser = P;
			return P;
		})();
	}
	return _initPromise;
}

async function loadLang(P: any, grammar: string): Promise<any | null> {
	if (_langCache.has(grammar)) return _langCache.get(grammar);
	const wasm = join(VENDOR, "grammars", `tree-sitter-${grammar}.wasm`);
	if (!existsSync(wasm)) {
		_langCache.set(grammar, null);
		return null;
	}
	try {
		const lang = await P.Language.load(wasm);
		_langCache.set(grammar, lang);
		return lang;
	} catch {
		_langCache.set(grammar, null);
		return null;
	}
}

// Collapse function/method bodies to a one-line marker; keep signatures + imports.
async function astCollapse(source: string, ext: string): Promise<{ out: string; collapsed: number } | null> {
	const grammar = GRAMMAR_BY_EXT[ext];
	if (!grammar) return null;
	let P: any;
	try {
		P = await getParser();
	} catch {
		return null;
	}
	const lang = await loadLang(P, grammar);
	if (!lang) return null;
	const parser = new P();
	parser.setLanguage(lang);
	let tree: any;
	try {
		tree = parser.parse(source);
	} catch {
		return null;
	}

	const bodyTypes = new Set((BODY_NODES[grammar] || "").split("|"));
	// collect (bodyStartByte, bodyEndByte) for each function-ish node's body child.
	const ranges: Array<{ s: number; e: number; lines: number }> = [];
	const walk = (n: any) => {
		if (bodyTypes.has(n.type)) {
			const body = n.childForFieldName?.("body");
			if (body && body.endIndex > body.startIndex) {
				const bLines = source.slice(body.startIndex, body.endIndex).split("\n").length;
				if (bLines > 3) ranges.push({ s: body.startIndex, e: body.endIndex, lines: bLines });
			}
		}
		for (let i = 0; i < n.childCount; i++) walk(n.child(i));
	};
	try {
		walk(tree.rootNode);
	} catch {
		return null;
	}
	if (!ranges.length) return null;

	// splice out bodies (bottom-up so indices stay valid), replacing with a marker
	ranges.sort((a, b) => b.s - a.s);
	let out = source;
	const openChar = ext === ".py" ? "" : "{"; // keep the brace/colon shape readable
	for (const r of ranges) {
		const head = out.slice(0, r.s);
		const tail = out.slice(r.e);
		const marker = ext === ".py" ? ` … ${r.lines} lines …` : `${openChar} … ${r.lines} lines … }`;
		// for brace langs the body node usually includes the braces; for python the
		// body is the suite. Replace the whole body span with the marker.
		out = head + marker + tail;
	}
	return { out, collapsed: ranges.length };
}

// Extract a file path + content from a read-tool result, if this looks like one.
function fileReadInfo(_toolName: string, input: any, text: string): { path: string; source: string } | null {
	const p = String(input?.file_path ?? input?.path ?? input?.file ?? "");
	if (!p) return null;
	const ext = extname(p).toLowerCase();
	if (!GRAMMAR_BY_EXT[ext]) return null;
	// strip a leading line-number gutter if the reader adds one ("  12\t...").
	const stripped = text.replace(/^\s*\d+\t/gm, "");
	return { path: p, source: stripped };
}

export default function (pi: any) {
	if (!ENABLED) return;

	type Row = { hits: number; inTok: number; savedTok: number };
	const cov = new Map<string, Row>();
	const row = (t: string): Row => {
		if (!cov.has(t)) cov.set(t, { hits: 0, inTok: 0, savedTok: 0 });
		return cov.get(t)!;
	};
	const record = (label: string, before: string, after: string) => {
		const r = row(label);
		r.hits++;
		r.inTok += est(before);
		r.savedTok += Math.max(0, est(before) - est(after));
	};

	pi.on("tool_result", async (event: any) => {
		if (event.isError) return; // never touch errors — the model needs them whole
		const tool: string = event.toolName || "";
		const { text, nonText } = textOf(event.content);
		if (!text || text.length < 200) return;

		// --- RTK: command-aware (bash results carry input.command) ---
		if (tool === "bash" || tool === "shell") {
			const command = String(event.input?.command ?? "");
			// First: collapse runs of identical lines (progress bars, repeated warnings,
			// duplicate log lines) → one line + (×N). Lossless; feeds the distillers.
			const { out: collapsed, saved } = collapseRepeats(text);
			const work = collapsed;
			let out: string | null = null;
			let label = "";
			switch (classify(command)) {
				case "test":
					out = distillTest(work);
					label = "test";
					break;
				case "git-status":
					out = distillGitStatus(work);
					label = "git-status";
					break;
				case "git-log":
					out = distillGitLog(work);
					label = "git-log";
					break;
				case "git-diff":
					/* leave diffs to review/diff tooling */ break;
				case "list":
					out = distillList(work, "bash");
					label = "list";
					break;
			}
			// If a distiller fired, use it. Else, if repeat-collapse alone saved a lot,
			// return the collapsed text (still lossless). Otherwise pass through.
			if (out) {
				record(label, text, out);
				return { content: [{ type: "text", text: out }, ...nonText] };
			}
			if (saved >= 20) {
				record("collapse", text, work);
				return {
					content: [
						{ type: "text", text: `[compress: collapsed ${saved} repeated line(s)]\n${work}` },
						...nonText,
					],
				};
			}
			return;
		}

		// grep/find/ls native tools → grouped list
		if (/^(grep|rg|find|glob|ls|fd)$/.test(tool)) {
			const out = distillList(text, tool);
			if (out) {
				record("list", text, out);
				return { content: [{ type: "text", text: out }, ...nonText] };
			}
			return;
		}

		// web_search / fetch_content → cap the raw result. Search returns many sources
		// (title/url/snippet each); a full dump of 15-20 sources is thousands of tokens
		// of noise when the agent wants an answer. Keep it under a budget; externalize
		// the rest for recovery. fetch_content of a page → head+tail if huge.
		if (/^(web_search|get_search_content|fetch_content)$/.test(tool)) {
			const out = distillWeb(text, tool);
			if (out) {
				record("web", text, out);
				return { content: [{ type: "text", text: out }, ...nonText] };
			}
			return;
		}

		// --- Headroom: AST file collapse for large source-file reads ---
		if (AST_ENABLED && /read|cat|view|open|file/i.test(tool) && text.length >= AST_MIN_CHARS) {
			const info = fileReadInfo(tool, event.input, text);
			if (info) {
				const collapsed = await astCollapse(info.source, extname(info.path).toLowerCase());
				// Worth it if we removed a meaningful chunk — either a solid fraction OR
				// a large absolute amount (a body-heavy file can save a lot even at a
				// modest ratio; a comment-heavy file legitimately saves little → skip).
				const savedChars = collapsed ? info.source.length - collapsed.out.length : 0;
				if (collapsed && (savedChars > info.source.length * 0.25 || savedChars > 1500)) {
					const path = externalize(info.source, "file");
					const header =
						`[compress: ${info.path} — ${collapsed.collapsed} bodies collapsed, ${est(info.source)}→${est(collapsed.out)} tok. ` +
						`Signatures kept; read a specific body from ${path} when you need it.]\n`;
					record("ast", info.source, collapsed.out);
					return { content: [{ type: "text", text: header + collapsed.out }, ...nonText] };
				}
			}
		}
	});

	pi.registerCommand("compress", {
		description: "Show what output compression has saved this session (RTK distillers + AST collapse)",
		handler: async (_a: string, ctx: any) => {
			if (!cov.size) {
				ctx.ui.notify("compress: nothing compressed yet this session.", "info");
				return;
			}
			const rows = [...cov.entries()].map(
				([k, r]) => `  ${k}: ${r.hits}× · saved ~${r.savedTok} tok (of ${r.inTok} in)`,
			);
			const saved = [...cov.values()].reduce((a, r) => a + r.savedTok, 0);
			ctx.ui.notify(`Output compression this session — ~${saved} tokens saved:\n${rows.join("\n")}`, "info");
		},
	});
}
