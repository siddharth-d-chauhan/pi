/**
 * Shared card-drawing helper for the production extensions: rounded-border
 * boxes in the omp style. Pure functions only — extensions each load with
 * their own module graph, which is fine for stateless helpers.
 *
 * This directory has no index.ts, so the extension loader skips it during
 * directory discovery; it is only reachable via relative imports.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface CardOptions {
	width: number;
	/** Pre-colored title embedded in the top border (optional). */
	title?: string;
	/** Pre-colored body lines. */
	body: string[];
	/** Colors border glyphs (e.g. theme.fg("accent", s)). */
	edge: (text: string) => string;
}

/**
 * Strip trailing spaces while preserving trailing ANSI reset codes —
 * child components often pad lines to full width, which would otherwise
 * make the truncator append a phantom ellipsis.
 */
export function rtrimAnsi(line: string): string {
	return line.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1");
}

/** Lines that carry inline-image escape payloads must not be reflowed/boxed. */
function isImageLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337");
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Time-derived spinner frame: no timers to leak — the frame advances on
 * whatever re-renders streaming already causes (text deltas, tool updates),
 * and freezes when nothing is happening, which is honest.
 */
export function spinnerGlyph(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];
}

/** Slow two-phase pulse for border colors while running. */
export function pulseOn(): boolean {
	return Math.floor(Date.now() / 500) % 2 === 0;
}

export function cardLines(opts: CardOptions): string[] {
	const { width, title, body, edge } = opts;
	if (width < 24) {
		return [
			...(title ? [truncateToWidth(title, width, "…")] : []),
			...body.map((l) => truncateToWidth(l, width, "…")),
		];
	}
	const inner = width - 4;
	const out: string[] = [];
	if (title) {
		const clipped = truncateToWidth(rtrimAnsi(title), inner - 2, "…");
		const fill = Math.max(0, inner - visibleWidth(clipped) - 1);
		out.push(`${edge("╭─")} ${clipped} ${edge("─".repeat(fill))}${edge("╮")}`);
	} else {
		out.push(edge(`╭${"─".repeat(width - 2)}╮`));
	}
	for (const raw of body) {
		if (isImageLine(raw)) {
			out.push(raw);
			continue;
		}
		const clipped = truncateToWidth(rtrimAnsi(raw), inner, "…");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
		out.push(`${edge("│")} ${clipped}${pad} ${edge("│")}`);
	}
	out.push(edge(`╰${"─".repeat(width - 2)}╯`));
	return out;
}
