/**
 * Tiny visualization helpers for the production extensions — the layout
 * primitives Ink would give us, without the framework. Pure functions.
 *
 * Like lib/card.ts, this directory has no index.ts so the extension loader
 * skips it; reachable only via relative imports.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Unicode sparkline for a numeric series (empty series → ""). */
export function sparkline(values: number[], maxWidth = 24): string {
	if (values.length === 0) return "";
	const slice = values.slice(-maxWidth);
	const max = Math.max(...slice);
	if (max <= 0) return SPARK_GLYPHS[0].repeat(slice.length);
	return slice
		.map(
			(value) =>
				SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, Math.floor((value / max) * (SPARK_GLYPHS.length - 1)))],
		)
		.join("");
}

/** Horizontal gauge: `███████░░░ 68%`-style bar (0..1 clamped). */
export function gauge(fraction: number, width = 10): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * width);
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/**
 * Two-column layout: left column fixed to the widest label, right column
 * truncated to the remaining width. Rows with an empty right side span.
 */
export function twoColumns(rows: Array<[string, string]>, width: number, gap = 2): string[] {
	const labelWidth = Math.max(0, ...rows.map(([label]) => visibleWidth(label)));
	return rows.map(([label, value]) => {
		if (!value) return truncateToWidth(label, width, "…");
		const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(label)) + gap);
		return truncateToWidth(`${label}${pad}${value}`, width, "…");
	});
}

/** Compact human numbers: 950, 8.2k, 1.4M. */
export function compactNumber(value: number): string {
	if (value < 1000) return `${Math.round(value)}`;
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}
