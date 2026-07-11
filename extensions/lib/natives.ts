/**
 * natives.ts — Node-safe optional loader for `@oh-my-pi/pi-natives`.
 *
 * The published package is a Bun-first N-API addon: its own loader
 * (`native/index.js`) resolves the `.node` via `import.meta.dir`, which is a
 * Bun-only property (`undefined` under Node) and throws at import time. The
 * compiled `.node` leaves themselves are plain N-API and load fine under Node.
 *
 * So we bypass the package loader entirely and `require()` the platform leaf
 * `.node` directly. Verified on linux-x64 (POC 2026-07-12): 61 exports,
 * astEdit/blockRangeAt/isoProbe functional, 78 tree-sitter languages, CoW iso
 * backend available.
 *
 * This is a strictly OPTIONAL accelerator: if `@oh-my-pi/pi-natives` (and the
 * matching platform leaf) is not installed, `loadNatives()` returns null and
 * callers fall back to pure-JS paths. Nothing here throws.
 *
 * Config: KP_NATIVES=0 force-disable (always fall back to JS).
 */

import { createRequire } from "node:module";

/** The subset of the pi-natives surface we currently consume. Loosely typed
 *  on purpose — the addon is not a TS module and we only touch a few fns. */
export interface PiNatives {
	/** Detect the enclosing brace/indent block that STARTS on `line` (1-indexed).
	 *  AST-accurate across 78 languages (incl. indent langs like Python). */
	blockRangeAt(opts: {
		code: string;
		lang?: string;
		path?: string;
		line: number;
	}): { startLine: number; endLine: number } | null;
	/** Tree-sitter language aliases the addon supports. */
	getSupportedLanguages(): string[];
	/** CoW-isolation probe: is a copy-on-write backend usable here? */
	isoProbe(kind?: number | null): { available: boolean; kind: number };
	/** Everything else the addon exports (astEdit, isoStart/Diff/Stop, grep…). */
	[k: string]: unknown;
}

const require = createRequire(import.meta.url);

let cached: PiNatives | null | undefined;

/** Candidate leaf specifiers for the current platform, most-capable first.
 *  x64 ships baseline+modern ISA variants; other tags ship a single file. */
function leafCandidates(): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const pkg = `@oh-my-pi/pi-natives-${tag}`;
	const base = `${pkg}/pi_natives.${tag}`;
	if (process.arch === "x64") {
		// Prefer the modern (AVX2) build; fall back to baseline. The addon works
		// either way — modern is just faster where the CPU supports it.
		return [`${base}-modern.node`, `${base}-baseline.node`, `${base}.node`];
	}
	return [`${base}.node`];
}

/**
 * Load the native addon, or return null if unavailable. Cached (including the
 * null result) so a missing package costs one resolve attempt per process.
 */
export function loadNatives(): PiNatives | null {
	if (cached !== undefined) return cached;
	if (process.env.KP_NATIVES === "0") {
		cached = null;
		return cached;
	}
	for (const spec of leafCandidates()) {
		try {
			const resolved = require.resolve(spec);
			const addon = require(resolved) as PiNatives;
			// Sanity: the AST surface we care about must be present.
			if (typeof addon.blockRangeAt === "function") {
				cached = addon;
				return cached;
			}
		} catch {
			// try next candidate
		}
	}
	cached = null;
	return cached;
}

/** True when the native accelerator is present and usable. */
export function nativesAvailable(): boolean {
	return loadNatives() !== null;
}
