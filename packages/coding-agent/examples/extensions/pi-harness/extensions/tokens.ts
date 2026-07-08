/**
 * tokens.ts — token & cache economics report over pi's session JSONL.
 *
 * "You can't improve what you don't measure." pi records per-turn usage
 * (input/output/cacheRead/cacheWrite) in every session file; nothing surfaced
 * it. This turns those numbers into the metrics every cost decision needs:
 *
 *   cache hit-rate  = cacheRead / (cacheRead + input)   ← THE health metric for
 *     the stable-prefix / distillation / LCM design. High = the expensive prefix
 *     is riding the cache; a drop means something volatile is busting it.
 *   re-sent ratio   = cacheRead / total                 ← how much of each turn is
 *     re-sent (cached) context vs genuinely new work.
 *   cost model      = input + output + 0.1·cacheRead + 1.25·cacheWrite (input-eq),
 *     the effective billable-token-equivalent so cache wins are visible even on a
 *     subscription where $ is not metered.
 *
 * Two surfaces: `/tokens` command (current or recent sessions) and a report()
 * export used by tests. Read-only, pure code, no LLM.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type SessionReport = {
	file: string;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cacheHitRate: number; // cacheRead / (cacheRead + input)
	resentRatio: number; // cacheRead / total
	inputEq: number; // billable-token-equivalent
	when: string;
};

function usageFromFile(file: string): TurnUsage[] {
	const turns: TurnUsage[] = [];
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return turns;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		const u = e?.message?.usage;
		if (u && (u.input || u.output || u.cacheRead || u.cacheWrite)) {
			turns.push({
				input: u.input || 0,
				output: u.output || 0,
				cacheRead: u.cacheRead || 0,
				cacheWrite: u.cacheWrite || 0,
			});
		}
	}
	return turns;
}

export function reportFile(file: string): SessionReport | null {
	const turns = usageFromFile(file);
	if (!turns.length) return null;
	const s = turns.reduce(
		(a, t) => ({
			input: a.input + t.input,
			output: a.output + t.output,
			cacheRead: a.cacheRead + t.cacheRead,
			cacheWrite: a.cacheWrite + t.cacheWrite,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	);
	const total = s.input + s.output + s.cacheRead + s.cacheWrite;
	return {
		file,
		turns: turns.length,
		...s,
		total,
		cacheHitRate: s.cacheRead + s.input > 0 ? s.cacheRead / (s.cacheRead + s.input) : 0,
		resentRatio: total > 0 ? s.cacheRead / total : 0,
		inputEq: Math.round(s.input + s.output + 0.1 * s.cacheRead + 1.25 * s.cacheWrite),
		when: (() => {
			try {
				return new Date(statSync(file).mtimeMs).toISOString().slice(0, 16);
			} catch {
				return "?";
			}
		})(),
	};
}

// pi encodes cwd into the dir name, but symlink resolution (/tmp→/private/tmp on
// macOS) makes reconstruction unreliable. Match on the real cwd, trying both the
// literal and realpath-resolved encodings.
function projectDirCandidates(cwd: string): Set<string> {
	const enc = (p: string) => `--${p.replace(/^\//, "").replaceAll("/", "-")}--`;
	const set = new Set([enc(cwd)]);
	try {
		set.add(enc(realpathSync(cwd)));
	} catch {}
	return set;
}

function recentFiles(cwd: string, scope: string, limit: number): string[] {
	let dirs = readdirSync(SESSIONS_ROOT);
	if (scope === "project") {
		const want = projectDirCandidates(cwd);
		dirs = dirs.filter((d) => want.has(d));
	}
	const files: string[] = [];
	for (const d of dirs) {
		const r = join(SESSIONS_ROOT, d);
		try {
			for (const n of readdirSync(r)) if (n.endsWith(".jsonl")) files.push(join(r, n));
		} catch {}
	}
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, limit);
}

function pct(x: number): string {
	return `${Math.round(x * 100)}%`;
}
function k(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function bar(rate: number, width = 16): string {
	const f = Math.round(rate * width);
	return "█".repeat(f) + "░".repeat(width - f);
}

export function report(cwd: string, scope: string, limit: number): string {
	const reports = recentFiles(cwd, scope, limit).map(reportFile).filter(Boolean) as SessionReport[];
	if (!reports.length) return "No sessions with usage data yet.";
	const agg = reports.reduce(
		(a, r) => ({
			input: a.input + r.input,
			output: a.output + r.output,
			cacheRead: a.cacheRead + r.cacheRead,
			cacheWrite: a.cacheWrite + r.cacheWrite,
			total: a.total + r.total,
			inputEq: a.inputEq + r.inputEq,
			turns: a.turns + r.turns,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, inputEq: 0, turns: 0 },
	);
	const hit = agg.cacheRead + agg.input > 0 ? agg.cacheRead / (agg.cacheRead + agg.input) : 0;
	const naiveEq = agg.input + agg.output + agg.cacheRead + agg.cacheWrite; // if nothing cached
	const saving = naiveEq > 0 ? 1 - agg.inputEq / naiveEq : 0;

	const lines = [
		`Token & cache economics — ${reports.length} sessions (${scope}), ${agg.turns} turns`,
		``,
		`cache hit-rate:  ${bar(hit)} ${pct(hit)}   ← health metric (higher = prefix cached)`,
		`re-sent cached:  ${k(agg.cacheRead)} tok read from cache (10% price)`,
		`genuinely new:   ${k(agg.input)} input + ${k(agg.output)} output at full price`,
		`cache writes:    ${k(agg.cacheWrite)} tok (1.25x, one-time per prefix)`,
		`total tokens:    ${k(agg.total)}`,
		``,
		`billable-equiv:  ${k(agg.inputEq)} tok  (vs ${k(naiveEq)} uncached → ${pct(saving)} saved by caching)`,
		``,
		`top sessions by billable-equivalent:`,
		...reports
			.slice()
			.sort((a, b) => b.inputEq - a.inputEq)
			.slice(0, 5)
			.map(
				(r) =>
					`  ${r.when}  ${k(r.inputEq).padStart(6)} eq  ${pct(r.cacheHitRate).padStart(4)} hit  ${r.turns}t  ${basename(r.file).slice(0, 24)}`,
			),
	];
	if (hit < 0.5 && agg.turns > 3)
		lines.push(
			"",
			"⚠ low hit-rate: something volatile may be busting the cached prefix (check for per-turn prefix changes).",
		);
	return lines.join("\n");
}

export default function (pi: any) {
	pi.registerCommand("tokens", {
		description: "Token & cache economics report (cache hit-rate, re-sent ratio, cost) over sessions",
		handler: async (args: string, ctx: any) => {
			const scope = /\ball\b/.test(args || "") ? "all" : "project";
			const limit = scope === "all" ? 50 : 20;
			ctx.ui.notify(report(process.cwd(), scope, limit), "info");
		},
	});
}
