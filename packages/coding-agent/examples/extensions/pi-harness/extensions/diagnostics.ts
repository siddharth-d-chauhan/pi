/**
 * diagnostics.ts — semantic diagnostics after edits (the high-value 80% of LSP).
 *
 * oh-my-pi and Claude Code have full LSP; the part that actually pays off turn-to-
 * turn is: after you edit a file, immediately surface type errors / undefined refs
 * / lint failures so a broken edit is caught NOW, not three steps later. This does
 * that by running the language's own fast checker on the changed file after an
 * edit tool runs, and feeding failures back as a tool-result annotation.
 *
 * We deliberately use per-language CHECKERS (tsc/pyright/ruff/go vet/…) rather than
 * a full LSP JSON-RPC client: same diagnostic value, a fraction of the machinery,
 * no long-lived server processes. (Full semantic rename/refactor — the hard 20% —
 * is out of scope; it's the less-used part.)
 *
 * Checkers are AUTODETECTED (rank 23) via the shared lsp-registry: a checker fires
 * only when its rootMarker is present in the tree AND its binary resolves, and
 * project-local bins (node_modules/.bin, .venv/bin) are preferred over global
 * PATH — so a repo's pinned toolchain wins and we don't fire a Python checker in a
 * pure-JS tree. The registry tags each entry linter (diagnostics-only) vs
 * type-intel; both are valid for diagnostics here (only rename/refs is type-intel
 * exclusive), and type-intel checkers are ordered first.
 *
 * Runs on tool_result of edit/write/hedit for the touched file. Non-blocking:
 * diagnostics are appended to the edit's result so the model sees "you just broke
 * X" and can fix it — it never blocks the edit itself.
 *
 * Config: KP_DIAG_ENABLED=0 disable · KP_DIAG_TIMEOUT_MS (default 30s).
 *   Checkers auto-detected; missing tools / absent rootMarkers are skipped silently.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { findRoot, resolveBin } from "./lsp-registry.ts";

const ENABLED = process.env.KP_DIAG_ENABLED !== "0";
const TIMEOUT = Number(process.env.KP_DIAG_TIMEOUT_MS || 30_000);
const EDIT_TOOLS = /^(edit|write|hedit|multiedit|apply_patch|str_replace)$/;

function have(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// A checker: the diagnostic tool name, the binary that must resolve, the rootMarkers
// that gate it, its tag, and a command builder given the resolved binary path + a
// shell-quoted file. `bin: null` = no gating binary (interpreter/npx-launched
// language checks that resolve on their own). first available (rootMarker ∩ binary)
// wins per language, type-intel before linter.
type Checker = {
	tool: string;
	bin: string | null;
	rootMarkers: string[];
	kind: "type-intel" | "linter";
	cmd: (bin: string, q: string) => string;
};

// language (ext) → ordered checkers. rootMarker+binary come from the same
// autodetect discipline as lsp-registry; commands stay checker-shaped (fast, no
// long-lived server). project-local bins are preferred via resolveBin().
function checkersFor(file: string): Checker[] {
	const ext = extname(file).toLowerCase();
	if (ext === ".ts" || ext === ".tsx")
		return [
			{
				tool: "tsc",
				bin: "tsc",
				rootMarkers: ["tsconfig.json", "package.json"],
				kind: "type-intel",
				cmd: (b, q) => `${b} --noEmit --pretty false ${q} 2>&1 | head -40`,
			},
			{
				tool: "eslint",
				bin: "eslint",
				rootMarkers: [
					".eslintrc",
					".eslintrc.js",
					".eslintrc.json",
					".eslintrc.cjs",
					"eslint.config.js",
					"eslint.config.mjs",
					"package.json",
				],
				kind: "linter",
				cmd: (b, q) => `${b} ${q} 2>&1 | head -30`,
			},
		];
	if (ext === ".js" || ext === ".jsx" || ext === ".mjs")
		return [
			{
				tool: "eslint",
				bin: "eslint",
				rootMarkers: [
					".eslintrc",
					".eslintrc.js",
					".eslintrc.json",
					".eslintrc.cjs",
					"eslint.config.js",
					"eslint.config.mjs",
					"package.json",
				],
				kind: "linter",
				cmd: (b, q) => `${b} ${q} 2>&1 | head -30`,
			},
			{
				tool: "node-check",
				bin: "node",
				rootMarkers: ["package.json"],
				kind: "linter",
				cmd: (b, q) => `${b} --check ${q} 2>&1 | head -20`,
			},
		];
	if (ext === ".py")
		return [
			{
				tool: "pyright",
				bin: "pyright",
				rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", "requirements.txt"],
				kind: "type-intel",
				cmd: (b, q) => `${b} ${q} 2>&1 | tail -25`,
			},
			{
				tool: "ruff",
				bin: "ruff",
				rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml", "setup.cfg", "tox.ini"],
				kind: "linter",
				cmd: (b, q) => `${b} check ${q} 2>&1 | head -30`,
			},
			{
				tool: "pyflakes",
				bin: "pyflakes",
				rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
				kind: "linter",
				cmd: (b, q) => `${b} ${q} 2>&1 | head -25`,
			},
			{
				tool: "py-compile",
				bin: null,
				rootMarkers: [],
				kind: "linter",
				cmd: (_b, q) => `python3 -m py_compile ${q} 2>&1 | head -20`,
			},
		];
	if (ext === ".go")
		return [
			{
				tool: "go-vet",
				bin: "go",
				rootMarkers: ["go.mod", "go.work"],
				kind: "type-intel",
				cmd: (b, q) => `${b} vet ${q} 2>&1 | head -30`,
			},
		];
	if (ext === ".rs")
		return [
			{
				tool: "rustc",
				bin: "rustc",
				rootMarkers: ["Cargo.toml"],
				kind: "type-intel",
				cmd: (b, q) => `${b} --edition 2021 --emit=metadata --crate-type lib ${q} -o /dev/null 2>&1 | head -30`,
			},
		];
	if (ext === ".json")
		return [
			{
				tool: "json",
				bin: null,
				rootMarkers: [],
				kind: "linter",
				cmd: (_b, q) =>
					`python3 -c "import json; json.load(open(${q}))" 2>&1 | grep -iE "error|expecting|delimiter" | head -3`,
			},
		];
	return [];
}

function runCheck(file: string, cwd: string): { tool: string; output: string } | null {
	const fromDir = resolve(file, "..");
	// type-intel checkers first, then linters — richer signal on a broken edit.
	const ordered = [...checkersFor(file)].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "type-intel" ? -1 : 1));
	for (const c of ordered) {
		// rootMarker gate (autodetect): skip a checker whose project isn't present here.
		if (c.rootMarkers.length && !findRoot(file, c.rootMarkers)) continue;
		// binary gate: resolve preferring project-local bins; null-bin checkers
		// (py-compile/json via python3) resolve their own interpreter.
		let binPath = c.bin;
		if (c.bin) {
			const r = resolveBin(c.bin, fromDir);
			if (!r) continue;
			binPath = r;
		} else if (!have("python3")) continue;
		const q = JSON.stringify(file);
		const cmd = c.cmd(binPath ?? "", q);
		try {
			const out = execSync(cmd, { cwd, encoding: "utf-8", timeout: TIMEOUT, stdio: ["ignore", "pipe", "pipe"] });
			const trimmed = out.trim();
			// clean = no diagnostics
			if (!trimmed || /^0 errors|no issues|All checks passed/i.test(trimmed)) return null;
			// tsc/pyright/ruff print nothing meaningful on success; treat empty as clean
			return { tool: c.tool, output: trimmed.slice(0, 2000) };
		} catch (e: any) {
			const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
			if (out) return { tool: c.tool, output: out.slice(0, 2000) };
		}
		return null; // ran, clean
	}
	return null; // no checker available
}

export default function (pi: any) {
	if (!ENABLED) return;

	pi.on("tool_result", async (event: any) => {
		if (event.isError) return;
		if (!EDIT_TOOLS.test(event.toolName || "")) return;
		const target = String(event.input?.path ?? event.input?.file_path ?? "").trim();
		if (!target) return;
		const abs = resolve(process.cwd(), target);
		if (!existsSync(abs)) return;

		const diag = runCheck(abs, process.cwd());
		if (!diag) return; // clean or unchecked — leave the result as-is

		// Append diagnostics so the model sees the breakage on the SAME turn.
		const content = event.content ?? [];
		return {
			content: [
				...content,
				{
					type: "text",
					text: `\n⚠ YOUR EDIT INTRODUCED ERRORS (${diag.tool} on ${target}) — do not proceed; fix these now:\n${diag.output}`,
				},
			],
		};
	});

	// Manual re-check of any file.
	pi.registerTool({
		name: "check_file",
		label: "check",
		description:
			"Run semantic diagnostics (type-check/lint) on a file — surfaces type errors, undefined refs, syntax issues. Auto-picks the checker (tsc/pyright/ruff/go vet/…).",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		async execute(_id: string, params: any) {
			const abs = resolve(process.cwd(), params.path);
			if (!existsSync(abs))
				return { content: [{ type: "text", text: `no such file: ${params.path}` }], isError: true };
			const diag = runCheck(abs, process.cwd());
			return { content: [{ type: "text", text: diag ? `${diag.tool}:\n${diag.output}` : "✓ no diagnostics" }] };
		},
	});
}
