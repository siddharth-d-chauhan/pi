/**
 * lsp-registry.ts — shared language-server / checker AUTODETECT (rank 23,
 * adopted from oh-my-pi). One small rootMarker + binary-resolution registry that
 * both lsp-rename.ts (type-intel: rename/references) and diagnostics.ts
 * (diagnostics-only linters + type-intel checkers) resolve against.
 *
 * A server/checker is chosen only when BOTH hold:
 *   1. rootMarker present — a marker file (tsconfig.json, go.mod, Cargo.toml, …)
 *      exists in the file's dir or any ancestor up to the repo root. This is what
 *      says "this language's project actually lives here", so we don't fire a
 *      Python server in a pure-JS repo (or vice-versa).
 *   2. binary resolves — the command exists, PREFERRING a project-local bin
 *      (node_modules/.bin, .venv/bin, .tox bin) over global PATH, so we run the
 *      repo's pinned toolchain, not whatever happens to be on PATH.
 *
 * Each entry is tagged `kind`:
 *   "type-intel"  — understands types/symbols across the project (rename/refs safe)
 *   "linter"      — diagnostics only (style/lint); NEVER used for rename/references
 *
 * npx-launched servers (typescript-language-server, pyright) can auto-INSTALL on first
 * use (network + npm-cache write), which is a surprising state-mutating default — so the
 * npx fallback is OFF unless KP_LSP_ALLOW_NPX=1. A resolved project-local/global binary
 * always wins over npx; with npx off and no binary, the tool reports no server (no install).
 *
 * Config: KP_LSP_ALLOW_NPX=1 permits npx auto-install of a missing server. Callers also
 * gate themselves (KP_LSP_*, KP_DIAG_*).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join, parse } from "node:path";

const ALLOW_NPX = process.env.KP_LSP_ALLOW_NPX === "1";

export type ServerKind = "type-intel" | "linter";

export interface LangEntry {
	/** file extensions this entry serves (lowercased, with dot) */
	exts: string[];
	/** any-of these marker files in an ancestor dir → this project is present */
	rootMarkers: string[];
	/** kind — type-intel is rename/refs-safe; linter is diagnostics-only */
	kind: ServerKind;
	/**
	 * candidate launch commands, best-first. `local` names are looked up in
	 * project-local bin dirs first; `bin` in the command is resolved to that local
	 * path when found. `npxFallback` (if set) is used when no binary resolves but a
	 * rootMarker is present and npx exists (auto-install servers).
	 */
	bin: string;
	args: string[];
	/** npx auto-install command, used only if `bin` doesn't resolve anywhere */
	npxFallback?: string[];
}

// Project-local bin dirs, searched (in order) upward from the file's dir. A binary
// here is preferred over global PATH so we run the repo's pinned toolchain.
const LOCAL_BIN_DIRS = ["node_modules/.bin", ".venv/bin", "venv/bin", ".tox/py/bin", "bin"];

function ancestors(fromDir: string): string[] {
	const out: string[] = [];
	let d = fromDir;
	const root = parse(d).root;
	for (;;) {
		out.push(d);
		if (d === root) break;
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return out;
}

/** first ancestor dir (of the file) containing any rootMarker, or null. */
export function findRoot(file: string, markers: string[]): string | null {
	for (const d of ancestors(dirname(file))) {
		for (const m of markers) if (existsSync(join(d, m))) return d;
	}
	return null;
}

/** resolve a binary preferring project-local bins over global PATH; null if none. */
export function resolveBin(bin: string, fromDir: string): string | null {
	for (const d of ancestors(fromDir)) {
		for (const rel of LOCAL_BIN_DIRS) {
			const p = join(d, rel, bin);
			if (existsSync(p)) return p;
		}
	}
	try {
		execSync(`command -v ${bin}`, { stdio: "ignore" });
		return bin;
	} catch {
		return null;
	}
}

function haveNpx(): boolean {
	try {
		execSync("command -v npx", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// The registry. Ordered per-language best-first; the first entry whose rootMarker
// is present AND whose binary resolves wins for a given (ext, kind).
export const REGISTRY: LangEntry[] = [
	// --- TypeScript / JavaScript ---
	{
		exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		kind: "type-intel",
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
		bin: "typescript-language-server",
		args: ["--stdio"],
		npxFallback: ["npx", "-y", "typescript-language-server", "--stdio"],
	},
	{
		exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		kind: "linter",
		rootMarkers: [
			".eslintrc",
			".eslintrc.js",
			".eslintrc.json",
			".eslintrc.cjs",
			"eslint.config.js",
			"eslint.config.mjs",
			"package.json",
		],
		bin: "eslint",
		args: [],
	},

	// --- Python ---
	{
		exts: [".py", ".pyi"],
		kind: "type-intel",
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json", "requirements.txt"],
		bin: "pyright-langserver",
		args: ["--stdio"],
		npxFallback: ["npx", "-y", "pyright", "--stdio"],
	},
	{
		exts: [".py", ".pyi"],
		kind: "linter",
		rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml", "setup.cfg", "tox.ini"],
		bin: "ruff",
		args: ["check"],
	},

	// --- Rust ---
	{ exts: [".rs"], kind: "type-intel", rootMarkers: ["Cargo.toml"], bin: "rust-analyzer", args: [] },

	// --- Go ---
	{ exts: [".go"], kind: "type-intel", rootMarkers: ["go.mod", "go.work"], bin: "gopls", args: [] },
];

/**
 * Resolve a launch command for `file` of the given `kind`, honoring rootMarker ∩
 * binary and project-local preference. Returns the argv (bin resolved to a local
 * path when found), or null if nothing applies.
 */
export function resolveServer(file: string, cwd: string, kind: ServerKind): string[] | null {
	const e = extname(file).toLowerCase();
	const abs = file.startsWith("/") ? file : join(cwd, file);
	const fromDir = dirname(abs);
	for (const entry of REGISTRY) {
		if (entry.kind !== kind) continue;
		if (!entry.exts.includes(e)) continue;
		if (!findRoot(abs, entry.rootMarkers)) continue; // project not present here
		const resolved = resolveBin(entry.bin, fromDir);
		if (resolved) return [resolved, ...entry.args];
		// npx -y would non-interactively INSTALL the server (network fetch + npm cache write) on
		// first use with no draft→confirm — a surprising, state-mutating default. Gate it behind
		// an explicit opt-in; when off we return null (tool reports "no resolved server binary").
		if (ALLOW_NPX && entry.npxFallback && haveNpx()) return entry.npxFallback;
	}
	return null;
}

/** Convenience: the type-intel server for a file (rename/references). */
export function typeIntelServerFor(file: string, cwd: string): string[] | null {
	return resolveServer(file, cwd, "type-intel");
}
