/**
 * edit-lint.ts — reject a syntactically-broken edit before it lands (SWE-agent ACI).
 *
 * SWE-agent's most-cited ACI finding: when an agent makes an edit that breaks
 * syntax, blocking it AT EDIT TIME (with the parse error shown) prevents a
 * failure cascade — otherwise the agent corrupts the file, then flails because
 * nothing compiles and the real error is buried three tool-calls back. Their
 * linter "does not let the edit command go through if the code isn't
 * syntactically correct."
 *
 * We do this natively with the tree-sitter we already vendored (compress.ts):
 *   - tool_call (pre-edit): snapshot the target file's content + its current
 *     syntax-error count, keyed by toolCallId.
 *   - tool_result (post-edit): re-parse the now-written file. If the edit
 *     INTRODUCED new ERROR nodes (count went up), REVERT the write and return an
 *     error naming the first broken line — the edit "didn't go through." If the
 *     file was already broken before, we don't block (the agent may be mid-fix).
 *
 * Net: you can't leave a file more broken than you found it. Especially valuable
 * for Java — a dropped brace/semicolon means the whole module won't compile.
 *
 * Annotations/decorators are never touched (they're structure, not error nodes)
 * and this only concerns syntax validity, so custom @Annotations are safe.
 *
 * Only guards the edit tools (hedit, hedit_block, edit, write) on files in a
 * language we have a grammar for; everything else passes through untouched.
 *
 * ── ADDED GUARDS ─────────────────────────────────────────────────────────────
 *  - BLOCK-AUTO-GENERATED (KP_EDITLINT_NOGEN, default ON): refuse edits to files
 *    that should never be hand-edited — lockfiles, dist/build output, *.generated.*,
 *    *.min.*, vendored dirs, snapshots. These are regenerated from source; a manual
 *    edit is almost always a mistake that gets clobbered on the next build. Blocked
 *    PRE-EDIT (before the write) with a pointer to the real source.
 *  - FUZZY-ANCHOR FALLBACK (KP_EDITLINT_FUZZY, default ON): when an anchor-based edit
 *    (hedit/str_replace) fails because the exact anchor wasn't found, look for a
 *    near-match (whitespace-normalised / trimmed) in the file and tell the model the
 *    closest line(s) it likely meant — turning a dead "no match" into a usable hint,
 *    instead of the agent re-reading the whole file blind.
 *
 * Config: KP_EDITLINT_ENABLED=0 disable · KP_EDITLINT_WARN=1 warn-instead-of-block
 *   KP_EDITLINT_NOGEN=0   allow edits to generated/lock/dist files
 *   KP_EDITLINT_FUZZY=0   disable fuzzy-anchor hinting
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENABLED = process.env.KP_EDITLINT_ENABLED !== "0";
const WARN_ONLY = process.env.KP_EDITLINT_WARN === "1";
const NOGEN = process.env.KP_EDITLINT_NOGEN !== "0"; // block auto-generated (default on)
const FUZZY = process.env.KP_EDITLINT_FUZZY !== "0"; // fuzzy-anchor hint (default on)

// Same vendored parser set as compress.ts (single source of grammars).
const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "tree-sitter");
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
const EDIT_TOOLS = /^(hedit|hedit_block|edit|write|apply_patch|str_replace)$/i;

let _Parser: any = null;
let _initPromise: Promise<any> | null = null;
const _langCache = new Map<string, any>();

async function getParser(): Promise<any> {
	if (_Parser) return _Parser;
	if (!_initPromise) {
		_initPromise = (async () => {
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
		const l = await P.Language.load(wasm);
		_langCache.set(grammar, l);
		return l;
	} catch {
		_langCache.set(grammar, null);
		return null;
	}
}

// Count ERROR / MISSING nodes and return the first one's 1-based line + text.
async function syntaxErrors(
	source: string,
	ext: string,
): Promise<{ count: number; firstLine: number; firstText: string } | null> {
	const grammar = GRAMMAR_BY_EXT[ext];
	if (!grammar) return null; // unsupported language → don't guard
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

	let count = 0,
		firstLine = -1,
		firstText = "";
	const lines = source.split("\n");
	const walk = (n: any) => {
		if (n.type === "ERROR" || n.isMissing?.() === true || n.isMissing === true) {
			count++;
			if (firstLine < 0) {
				firstLine = (n.startPosition?.row ?? 0) + 1;
				firstText = (lines[n.startPosition?.row ?? 0] || "").trim().slice(0, 100);
			}
		}
		for (let i = 0; i < n.childCount; i++) walk(n.child(i));
	};
	try {
		walk(tree.rootNode);
	} catch {
		return null;
	}
	// hasError catches deep parse failures the ERROR-node walk can miss.
	if (count === 0 && tree.rootNode?.hasError?.()) {
		count = 1;
		firstLine = firstLine < 0 ? 1 : firstLine;
	}
	return { count, firstLine, firstText };
}

function pathOf(input: any): string {
	return String(input?.file_path ?? input?.path ?? input?.file ?? input?.filename ?? "");
}

// ── BLOCK-AUTO-GENERATED ─────────────────────────────────────────────────────
// Files that are produced by a tool, not authored by hand. A manual edit here is
// almost always wrong (clobbered on next build/install) — block pre-edit and point
// at the source of truth.
const LOCKFILES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"npm-shrinkwrap.json",
	"poetry.lock",
	"Pipfile.lock",
	"Cargo.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
	"bun.lockb",
	"flake.lock",
	"uv.lock",
]);
const GEN_PATH_RE =
	/(^|\/)(dist|build|out|node_modules|vendor|\.next|\.nuxt|coverage|__snapshots__|__generated__|target\/(?:debug|release))(\/|$)/i;
const GEN_FILE_RE = /(\.min\.(?:js|css)|\.generated\.[^./]+|\.gen\.[^./]+|\.g\.dart|_pb2?\.py|\.pb\.go|\.snap|\.map)$/i;

function whyGenerated(path: string): string | null {
	if (!NOGEN) return null;
	const norm = path.replace(/\\/g, "/");
	const base = basename(norm);
	if (LOCKFILES.has(base))
		return `\`${base}\` is a dependency lockfile — regenerate it via your package manager (install/update), don't hand-edit it`;
	if (GEN_PATH_RE.test(norm))
		return `\`${norm}\` lives in a build/vendor/generated directory — edit the source it's built from, not the output`;
	if (GEN_FILE_RE.test(norm))
		return `\`${base}\` looks auto-generated (minified/generated/snapshot) — edit the source and regenerate, don't hand-edit the artifact`;
	return null;
}

// ── FUZZY-ANCHOR FALLBACK ────────────────────────────────────────────────────
const normWs = (s: string) => s.replace(/\s+/g, " ").trim();
// Pull the anchor/old-string the edit tried to match, across tool shapes.
function anchorOf(input: any): string {
	return String(
		input?.old_string ??
			input?.oldText ??
			input?.old ??
			input?.anchor ??
			input?.search ??
			input?.find ??
			input?.target ??
			"",
	);
}
// Cheap line-level similarity (Dice coefficient on char bigrams).
function similarity(a: string, b: string): number {
	a = normWs(a);
	b = normWs(b);
	if (!a.length || !b.length) return 0;
	if (a === b) return 1;
	const bg = (s: string) => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) {
			const g = s.slice(i, i + 2);
			m.set(g, (m.get(g) || 0) + 1);
		}
		return m;
	};
	const ma = bg(a),
		mb = bg(b);
	let inter = 0;
	for (const [g, n] of ma) if (mb.has(g)) inter += Math.min(n, mb.get(g)!);
	return (2 * inter) / (a.length - 1 + b.length - 1);
}
// Find the closest window in `source` to the (multi-line) anchor. Returns the
// best-matching lines + their 1-based start line, or null if nothing is close.
function fuzzyFind(source: string, anchor: string): { line: number; text: string; score: number } | null {
	const anchorFirst = anchor.split("\n").find((l) => l.trim().length > 3) ?? anchor.split("\n")[0] ?? "";
	if (normWs(anchorFirst).length < 4) return null;
	const lines = source.split("\n");
	let best = { line: -1, text: "", score: 0 };
	for (let i = 0; i < lines.length; i++) {
		const s = similarity(anchorFirst, lines[i]);
		if (s > best.score) best = { line: i + 1, text: lines[i].trim().slice(0, 120), score: s };
	}
	return best.score >= 0.6 && best.line > 0 ? best : null;
}
// Heuristic: did this tool_result fail because the anchor wasn't found?
function isAnchorMiss(event: any): boolean {
	if (!event?.isError) return false;
	const txt = (event.content ?? [])
		.filter((b: any) => b?.type === "text")
		.map((b: any) => b.text)
		.join(" ")
		.toLowerCase();
	return /not\s*found|no\s*match|could\s*not\s*find|does\s*not\s*(?:appear|match)|unique|anchor|old_string|no occurrences|0 occurrences/.test(
		txt,
	);
}

export default function (pi: any) {
	if (!ENABLED) return;

	// toolCallId → snapshot captured pre-edit.
	const pending = new Map<string, { path: string; before: string; errCount: number; anchor: string }>();
	let blocked = 0;
	let blockedGen = 0;

	// PRE-EDIT: block auto-generated targets outright, else snapshot for the post-edit
	// syntax check + a fuzzy-anchor fallback.
	pi.on("tool_call", async (event: any) => {
		try {
			if (!EDIT_TOOLS.test(String(event.toolName || ""))) return;
			const path = pathOf(event.input);
			if (!path) return;

			// BLOCK-AUTO-GENERATED: refuse before any write happens.
			const gen = whyGenerated(path);
			if (gen && !WARN_ONLY) {
				blockedGen++;
				return {
					block: true,
					isError: true,
					content: [
						{
							type: "text",
							text: `edit-lint REFUSED this edit: ${gen}. No change was applied. If you truly must touch it, set KP_EDITLINT_NOGEN=0.`,
						},
					],
				};
			}

			const anchor = anchorOf(event.input);
			const ext = extname(path).toLowerCase();
			// Snapshot for fuzzy-anchor hinting even for languages we can't syntax-check,
			// as long as the file exists and the edit is anchor-based.
			const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
			if (!GRAMMAR_BY_EXT[ext]) {
				if (FUZZY && anchor && before) pending.set(event.toolCallId, { path, before, errCount: 0, anchor });
				return; // language we can't parse → no syntax guard
			}
			const pre = before ? await syntaxErrors(before, ext) : { count: 0, firstLine: -1, firstText: "" };
			pending.set(event.toolCallId, { path, before, errCount: pre?.count ?? 0, anchor });
		} catch {}
		// never blocks here (except the generated-file refusal above) — the syntax
		// check happens post-write so we see the real result.
	});

	// POST-EDIT: re-parse; if the edit introduced NEW errors, revert + report.
	pi.on("tool_result", async (event: any) => {
		const snap = pending.get(event.toolCallId);
		if (!snap) return;
		pending.delete(event.toolCallId);
		if (event.isError) {
			// FUZZY-ANCHOR FALLBACK: the edit failed. If it failed because the exact
			// anchor wasn't found, point the model at the closest matching line so it
			// can retry precisely instead of re-reading the whole file blind.
			try {
				if (!FUZZY || !snap.anchor || !isAnchorMiss(event)) return;
				const hit = fuzzyFind(snap.before, snap.anchor);
				if (!hit) return;
				const hint = `\n\n⚠ edit-lint fuzzy-anchor: the exact anchor wasn't found, but line ${hit.line} is a close match (${Math.round(hit.score * 100)}%):\n  ${hit.line}: ${hit.text}\nRe-read around line ${hit.line} and copy the anchor byte-for-byte (whitespace/indentation must match).`;
				const merged = [...(event.content ?? [])];
				const t = merged.find((b: any) => b.type === "text");
				if (t) t.text += hint;
				else merged.push({ type: "text", text: hint.trim() });
				return { content: merged };
			} catch {}
			return; // the tool itself already failed; nothing further to guard
		}
		try {
			const ext = extname(snap.path).toLowerCase();
			if (!existsSync(snap.path)) return;
			const after = readFileSync(snap.path, "utf-8");
			if (after === snap.before) return; // no-op edit
			const post = await syntaxErrors(after, ext);
			if (!post) return;
			// Block ONLY a valid→invalid transition. If the file already had errors
			// before, stay out of the way entirely — the agent is mid-repair, and
			// tree-sitter's error-recovery count isn't a reliable "better/worse"
			// signal between two broken states (comparing counts causes false blocks).
			if (snap.errCount > 0) return;
			if (post.count === 0) return;

			const where = post.firstLine > 0 ? ` at line ${post.firstLine}: \`${post.firstText}\`` : "";
			if (WARN_ONLY) {
				// leave the edit; append a warning to what the model sees.
				const warn = `\n\n⚠ edit-lint: this edit introduced a syntax error${where}. The file was left as written — fix it before running anything.`;
				const { content } = event;
				const merged = [...(content ?? [])];
				const t = merged.find((b: any) => b.type === "text");
				if (t) t.text += warn;
				else merged.push({ type: "text", text: warn.trim() });
				return { content: merged };
			}

			// BLOCK: revert to the pre-edit content and tell the model the edit didn't land.
			writeFileSync(snap.path, snap.before);
			blocked++;
			return {
				isError: true,
				content: [
					{
						type: "text",
						text:
							`edit-lint REJECTED this edit: it would introduce a syntax error${where}. ` +
							`The file was reverted to its previous state (no change applied). ` +
							`Re-read the region and make a syntactically-complete edit — check for a missing brace, paren, quote, or semicolon.`,
					},
				],
			};
		} catch {
			/* never let the guard itself break the edit */
		}
	});

	pi.registerCommand("editlint", {
		description: "Show edit-lint status (syntax guard on edits) and how many broken edits it blocked",
		handler: async (_a: string, ctx: any) => {
			ctx.ui.notify(
				`edit-lint: ${WARN_ONLY ? "WARN mode" : "BLOCK mode"} · syntax-guards hedit/edit/write on py/js/ts/go/rust/java/c · nogen=${NOGEN ? "on" : "off"} · fuzzy=${FUZZY ? "on" : "off"} · blocked ${blocked} broken + ${blockedGen} generated-file edit(s) this session.`,
				"info",
			);
		},
	});
}
