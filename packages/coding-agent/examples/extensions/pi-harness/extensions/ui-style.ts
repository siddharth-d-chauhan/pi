/**
 * ui-style.ts — shared TUI styling so our panels look like ONE designed system, not ad-hoc boxes.
 *
 * Theme-AWARE: colors come from ctx.ui.theme.fg(role, text), which adapts to the user's chosen theme
 * (light/dark). Roles: accent · success · error · warning · muted · dim · text · toolTitle · toolOutput.
 * All helpers degrade gracefully if theme is missing (return plain text).
 *
 * Design language (consistent across log viewer, agent cards, /memory review, /context):
 *   • rounded borders in `dim` (recede) · title in `accent` · selected row reversed/accented
 *   • status glyphs colored by state (running=accent, done=success, fail=error, warn=warning)
 *   • primary text = default · secondary/metadata = dim
 *   • every row padded to exact visible width (overlays render nothing otherwise)
 */

// ── width-safe primitives (ANSI-aware) — no external dep ──────────────────────────────────
export const visibleWidth = (s: string): number => [...(s || "").replace(/\x1b\[[0-9;]*m/g, "")].length;
export const truncateToWidth = (s: string, w: number): string =>
	visibleWidth(s) <= w ? s : `${[...(s || "")].slice(0, Math.max(0, w - 1)).join("")}…`;
export const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

// ── theme wrapper — safe if theme is absent ───────────────────────────────────────────────
export type ThemeLike = { fg?: (role: string, text: string) => string } | undefined | null;
export function styler(theme: ThemeLike) {
	const fg = (role: string, text: string): string => {
		try {
			return theme?.fg ? theme.fg(role, text) : text;
		} catch {
			return text;
		}
	};
	return {
		fg,
		accent: (t: string) => fg("accent", t),
		ok: (t: string) => fg("success", t),
		err: (t: string) => fg("error", t),
		warn: (t: string) => fg("warning", t),
		dim: (t: string) => fg("dim", t),
		muted: (t: string) => fg("muted", t),
		title: (t: string) => fg("toolTitle", t),
		out: (t: string) => fg("toolOutput", t),
		// reverse video for a focused/selected row (works with any theme)
		sel: (t: string) => `\x1b[7m${t}\x1b[27m`,
	};
}
export type Styler = ReturnType<typeof styler>;

// state → colored glyph, one place so every panel agrees.
export function stateGlyph(s: Styler, state: string): string {
	switch (state) {
		case "running":
			return s.accent("●");
		case "done":
			return s.ok("✓");
		case "failed":
			return s.err("✗");
		case "killed":
			return s.warn("⊘");
		default:
			return s.dim("•");
	}
}

/**
 * Render a titled, theme-styled box. `rows` are the body lines (already colored as desired); this
 * frames them with dim rounded borders, an accent title, and a dim footer/hint. Every line is
 * padded to exact width so the overlay draws. `width` is the target column count.
 */
export function frame(s: Styler, opts: { title: string; rows: string[]; footer?: string; width: number }): string[] {
	const inner = Math.max(1, opts.width - 2);
	const border = (l: string, r: string) => s.dim(l + "─".repeat(inner) + r);
	// a body row: pad the *visible* content to inner, then wrap in dim borders.
	const row = (content = "") => s.dim("│") + pad(truncateToWidth(content, inner), inner) + s.dim("│");
	const out: string[] = [border("╭", "╮")];
	out.push(row(` ${s.accent(opts.title)}`));
	out.push(row(""));
	for (const r of opts.rows) out.push(row(r));
	if (opts.footer) {
		out.push(row(""));
		out.push(row(` ${s.dim(opts.footer)}`));
	}
	out.push(border("╰", "╯"));
	return out;
}
