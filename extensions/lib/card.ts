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
export function isImageLine(line: string): boolean {
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

// ---------------------------------------------------------------------------
// Solid components (omp-style): full-width background-painted blocks instead
// of line-drawn borders. Content must use targeted fg resets (theme.fg /
// theme.bold do) — a raw \x1b[0m inside a line would kill the background.
// ---------------------------------------------------------------------------

/** Pad `line` to `width` and paint the whole run with `bg`. */
export function paintLine(line: string, width: number, bg: (text: string) => string): string {
	const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
	return bg(line + pad);
}

export interface SolidCardOptions {
	width: number;
	/** Raw label text for the header chip (e.g. "ORCHESTRA", "pi · main"). */
	label?: string;
	/** Paints the chip: typically a bright bg + contrasting fg. */
	labelStyle?: (text: string) => string;
	/** Extra pre-colored content on the label row, after the chip. */
	labelSuffix?: string;
	/** Pre-colored body lines (fg only — the card paints the bg). */
	body: string[];
	/** Background painter for the block, e.g. (s) => theme.bg("customMessageBg", s). */
	bg: (text: string) => string;
	paddingX?: number;
	/** Blank painted rows above/below the content (default 0). */
	paddingY?: number;
}

/**
 * A solid-color component block: every row is painted edge to edge, with a
 * chip-style label row on top. No border glyphs — the color IS the shape.
 */
export function solidCard(opts: SolidCardOptions): string[] {
	const { width, bg } = opts;
	const paddingX = opts.paddingX ?? 1;
	const pad = " ".repeat(paddingX);
	const inner = Math.max(1, width - paddingX * 2);
	const out: string[] = [];
	const paint = (content: string) => paintLine(`${pad}${truncateToWidth(rtrimAnsi(content), inner, "…")}`, width, bg);

	if (opts.paddingY) for (let i = 0; i < opts.paddingY; i++) out.push(paintLine("", width, bg));
	if (opts.label !== undefined) {
		const chip = (opts.labelStyle ?? ((text: string) => text))(` ${opts.label} `);
		out.push(paint(`${chip}${opts.labelSuffix ? ` ${opts.labelSuffix}` : ""}`));
		out.push(paintLine("", width, bg));
	}
	for (const line of opts.body) out.push(paint(line));
	if (opts.paddingY) for (let i = 0; i < opts.paddingY; i++) out.push(paintLine("", width, bg));
	return out;
}

// ---------------------------------------------------------------------------
// Forge components (pi-forge style): no background bands — a wordmark row and
// a gradient "heat line" hairline that cools left to right (white-hot →
// copper → steel → graphite). The hairline IS the frame.
// ---------------------------------------------------------------------------

/** Gradient color stops, hot → cold. */
const HEAT_STOPS: Array<[number, number, number]> = [
	[245, 240, 232], // white-hot
	[226, 114, 91], // ember
	[184, 115, 51], // copper
	[138, 146, 153], // brushed steel
	[58, 63, 69], // graphite
];

function lerpStops(t: number): [number, number, number] {
	const scaled = Math.min(0.9999, Math.max(0, t)) * (HEAT_STOPS.length - 1);
	const i = Math.floor(scaled);
	const f = scaled - i;
	const [r1, g1, b1] = HEAT_STOPS[i];
	const [r2, g2, b2] = HEAT_STOPS[i + 1];
	return [Math.round(r1 + (r2 - r1) * f), Math.round(g1 + (g2 - g1) * f), Math.round(b1 + (b2 - b1) * f)];
}

/**
 * The heat line: a stepped hairline cooling left to right. Glyph density
 * drops with the temperature (━ → ─ → ┄ → ·).
 */
export function heatLine(width: number): string {
	if (width <= 0) return "";
	let out = "";
	for (let i = 0; i < width; i++) {
		const t = i / Math.max(1, width - 1);
		const [r, g, b] = lerpStops(t);
		const glyph = t < 0.2 ? "━" : t < 0.55 ? "─" : t < 0.85 ? "┄" : "·";
		out += `\x1b[38;2;${r};${g};${b}m${glyph}`;
	}
	return `${out}\x1b[39m`;
}

/** The copper accent used for forge glyphs/wordmarks. */
export function copper(text: string): string {
	return `\x1b[38;2;184;115;51m${text}\x1b[39m`;
}

export interface ForgeHeaderOptions {
	width: number;
	/** Bold wordmark (pre-colored or plain; plain gets the ember treatment). */
	wordmark: string;
	/** Pre-colored trailing content on the wordmark row (branch, dirty count…). */
	suffix?: string;
	/** Pre-colored body rows below the heat line. */
	rows: string[];
}

/**
 * A forge-style header block: `π wordmark  suffix`, a cooling heat line, then
 * plain rows. No backgrounds, no borders — alignment and the hairline carry
 * the shape.
 */
export function forgeHeader(opts: ForgeHeaderOptions): string[] {
	const { width } = opts;
	const mark = `${copper("π")} \x1b[1m${opts.wordmark}\x1b[22m`;
	const head = opts.suffix ? `${mark}  ${opts.suffix}` : mark;
	const out: string[] = [truncateToWidth(rtrimAnsi(head), width, "…"), heatLine(width)];
	for (const row of opts.rows) out.push(truncateToWidth(rtrimAnsi(row), width, "…"));
	return out;
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
