/**
 * headroom-ledger.ts — a shared token-savings ledger across the compression stack.
 *
 * pi has several independent context-reduction layers (tool-distill's SmartCrusher + list/bash
 * distillers, compress.ts's RTK/AST collapse, context-lcm's DAG compaction). Each tracked its own
 * savings in isolation, so there was no end-to-end "how much headroom are we actually reclaiming"
 * view. This module is the single place they all report to; `/headroom` reads it.
 *
 * Import-shared singleton (one module instance per pi process), so any extension can
 * `record(source, inTok, outTok)` and the dashboard sees the union. No file I/O, no per-turn
 * cost, nothing in the prompt — purely observability.
 */

export type HeadroomStat = { source: string; calls: number; inTok: number; outTok: number };

const ledger = new Map<string, HeadroomStat>();

/** Record one compression event. `source` groups the accounting (e.g. "smartcrush", "distill:grep",
 * "lcm:compaction", "compress:ast"). inTok = tokens before, outTok = tokens after. */
export function record(source: string, inTok: number, outTok: number): void {
	const s = ledger.get(source) || { source, calls: 0, inTok: 0, outTok: 0 };
	s.calls++;
	s.inTok += Math.max(0, inTok);
	s.outTok += Math.max(0, outTok);
	ledger.set(source, s);
}

export function snapshot(): HeadroomStat[] {
	return [...ledger.values()].sort((a, b) => b.inTok - b.outTok - (a.inTok - a.outTok));
}

/** est tokens from chars — the rough 4:1 heuristic used across the harness. */
export const estTok = (chars: number) => Math.ceil(chars / 4);

/** Render the unified dashboard. Pure, so it's testable and the command is a one-liner. */
export function render(): string {
	const rows = snapshot();
	if (!rows.length) return "No compression recorded yet this session.";
	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
	const totalIn = rows.reduce((n, r) => n + r.inTok, 0);
	const totalOut = rows.reduce((n, r) => n + r.outTok, 0);
	const saved = totalIn - totalOut;
	const pct = totalIn ? Math.round((saved / totalIn) * 100) : 0;
	const lines = [
		`Headroom — ${k(saved)} tokens reclaimed (${pct}% of ${k(totalIn)} seen), across ${rows.length} layer(s)`,
		"",
		...rows.map((r) => {
			const s = r.inTok - r.outTok;
			const p = r.inTok ? Math.round((s / r.inTok) * 100) : 0;
			return `  ${r.source.padEnd(20)} ${r.calls}× · ${k(r.inTok)}→${k(r.outTok)} tok · saved ${k(s)} (${p}%)`;
		}),
		"",
		"Layers: smartcrush (JSON fold) · distill:* (tool results) · compress:* (files) · lcm:* (history)",
	];
	return lines.join("\n");
}
