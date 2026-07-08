/**
 * Streaming markdown line-commit buffer.
 *
 * Re-rendering the full markdown on every streamed token causes two visible
 * artefacts on long answers:
 *
 *  1. Wrap jitter — a line that just wrapped to N visual rows can shift to
 *     N ± 1 rows as later text arrives and pushes earlier content around,
 *     making already-displayed lines visibly snap.
 *  2. Layout work scales with the full buffer on every frame, so total cost
 *     is O(N²) in characters streamed.
 *
 * `StreamingMarkdown` addresses both by separating the buffer into two
 * regions once a "long answer" threshold is crossed:
 *
 *   - committed prefix — text up to the last newline that has been observed.
 *     Its rendered line list is cached at the width it was first laid out at
 *     and never re-derived, so wrap widths of already-displayed lines are
 *     pinned.
 *   - tail — the partial last line. Re-rendered fresh each frame; small, so
 *     cheap.
 *
 * Until the threshold is crossed we stay in "atomic" mode: the entire buffer
 * is rendered fresh on every frame (the whole block re-lays out consistently,
 * which is fine for short messages and avoids the user seeing a partial /
 * mid-line commit before they have any reason to expect streaming).
 *
 * Hysteresis: once we promote to incremental mode we never demote, so we
 * never bounce back and re-render the whole prefix.
 *
 * Width: the committed-prefix cache is keyed on render width, so a terminal
 * resize re-lays out the prefix (which is desired — the screen changed) but
 * does not invalidate the structural separation between committed and tail.
 */

import type { DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "./components/markdown.ts";
import { Markdown } from "./components/markdown.ts";

/** Threshold constants =====================================================
 *
 * These three knobs control when we switch from atomic (re-render whole
 * buffer each frame) to incremental (commit-on-newline, cache committed
 * prefix, only render the tail).
 *
 * Promotion is "OR" — we promote as soon as ANY threshold is crossed, so we
 * don't have to pick a single dimension. Trade-offs:
 *
 *  - `LINE_THRESHOLD`: most accurate predictor of visible wrap jitter, since
 *    wrap jitter is per-line. 30 lines comfortably fits a short answer; past
 *    that, mid-line re-flow is noticeably distracting.
 *  - `BYTE_THRESHOLD`: a cheap upper bound that catches very long single
 *    lines (e.g. a code block without wrapping) before they cause the
 *    prefix-render cost to dominate the frame budget.
 *  - `TIME_THRESHOLD_MS`: catches the "slow drip" case where a model emits
 *    one token per second for a short paragraph — by byte/line count we'd
 *    stay atomic forever, but the user is staring at the screen and the
 *    jitter is obvious.
 *
 * Once any of these is crossed, we promote. The values were picked to be
 * generous enough that any "single short paragraph" reply stays atomic
 * (i.e. the user sees a consistent block re-render with no mid-line commits)
 * but tight enough that anything resembling a multi-paragraph response
 * commits incrementally.
 */

export const STREAMING_LINE_THRESHOLD = 30;
export const STREAMING_BYTE_THRESHOLD = 5_000;
export const STREAMING_TIME_THRESHOLD_MS = 1_500;

/**
 * A line-commit buffer for streaming markdown. The consumer (typically an
 * assistant-message component) calls `append` on each token batch and
 * `render(width)` on each frame.
 *
 * The instance owns an internal `Markdown` for the actual rendering; the
 * same padding / theme / default-text-style options apply as for a regular
 * `Markdown` component.
 *
 * The instance is single-message: construct a fresh one per assistant
 * message turn. Do NOT reuse it across messages — `invalidate` / `reset`
 * are provided for tests and rare structural changes only.
 */
export class StreamingMarkdown {
	private buffer: string;
	private paddingX: number;
	private paddingY: number;
	private theme: MarkdownTheme;
	private defaultTextStyle: DefaultTextStyle | undefined;
	private options: MarkdownOptions | undefined;

	/** Wall-clock time of the first `append`; gates the time threshold. */
	private startTime: number | undefined;

	/** Set to `true` once any promotion threshold is crossed; never reset. */
	private incremental = false;

	/**
	 * In incremental mode: the index in `buffer` of the start of the
	 * (uncommitted) tail. Always equal to the position of the first byte
	 * after the last `\n` that has been observed in the buffer, except that
	 * if the buffer ends with `\n` the tail is the empty string and the
	 * committed prefix includes the trailing newline.
	 *
	 * In atomic mode: `-1` (unused).
	 */
	private tailStart = -1;

	/**
	 * Cache of the committed prefix's rendered lines, keyed on the width at
	 * which they were laid out. Cleared on `invalidate` and when the buffer
	 * changes shape in ways that invalidate the boundary (none, in current
	 * design — see `appendTail`).
	 */
	private committedCache: { width: number; lines: string[] } | undefined;

	constructor(
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options;
		this.buffer = "";
	}

	/**
	 * Update the layout-affecting constructor arguments and invalidate the
	 * committed-prefix cache so the next render re-lays everything out
	 * against the new padding / theme. Used by the parent component when a
	 * setting changes (e.g. `outputPad` is reconfigured). The buffer text
	 * is preserved — only the cached render is dropped.
	 */
	updateLayout(
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	): void {
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options;
		this.committedCache = undefined;
	}

	/** Append a delta of incoming text. */
	append(delta: string): void {
		if (!delta) return;
		if (this.startTime === undefined) {
			this.startTime = Date.now();
		}
		this.buffer += delta;
		if (!this.incremental) this.maybePromote();
	}

	/**
	 * Reset the buffer and seed it with a complete string. Use after a
	 * theme change or other context where the previous deltas are no longer
	 * the authoritative input — i.e. when you have a fresh full snapshot
	 * and want to keep the line-commit semantics for subsequent deltas.
	 */
	seed(text: string): void {
		this.buffer = text;
		this.startTime = Date.now();
		this.incremental = false;
		this.tailStart = -1;
		this.committedCache = undefined;
		if (text) this.maybePromote();
	}
	/**
	 * Mark the stream as complete (the producer reports it has no more
	 * text). Forces promotion to incremental if not already there, so the
	 * final render commits any remaining tail.
	 */
	markComplete(): void {
		if (!this.incremental) this.promote();
	}

	/**
	 * Drop all cached state. Use sparingly: only when the surrounding
	 * component needs to force a re-layout of the committed prefix (e.g. a
	 * theme change). Tests use this to reset between cases.
	 */
	invalidate(): void {
		this.committedCache = undefined;
		this.startTime = undefined;
		this.incremental = false;
		this.tailStart = -1;
		this.buffer = "";
	}

	/**
	 * Reset for reuse with a fresh stream. Like `invalidate` but does not
	 * touch the constructor-provided theme / padding.
	 */
	reset(): void {
		this.buffer = "";
		this.startTime = undefined;
		this.incremental = false;
		this.tailStart = -1;
		this.committedCache = undefined;
	}

	/** Render the current buffer at the given width. */
	render(width: number): string[] {
		if (!this.incremental) {
			const md = new Markdown(
				this.buffer,
				this.paddingX,
				this.paddingY,
				this.theme,
				this.defaultTextStyle,
				this.options,
			);
			return md.render(width);
		}
		return this.renderIncremental(width);
	}

	/** Number of committed lines currently held (0 in atomic mode). */
	get committedLineCount(): number {
		return this.committedCache?.lines.length ?? 0;
	}

	/** Whether the buffer has promoted to incremental mode yet. */
	get isIncremental(): boolean {
		return this.incremental;
	}

	/** Total bytes held in the buffer (raw, not rendered). */
	get byteLength(): number {
		return this.buffer.length;
	}

	/**
	 * Number of newlines currently committed in the buffer (i.e. the count
	 * of `\n` characters strictly before `tailStart`). In atomic mode this
	 * is always 0 — there are no committed lines.
	 */
	get committedNewlineCount(): number {
		if (!this.incremental) return 0;
		let n = 0;
		for (let i = 0; i < this.tailStart; i++) {
			if (this.buffer.charCodeAt(i) === 10 /* \n */) n++;
		}
		return n;
	}

	private maybePromote(): void {
		if (this.incremental) return;
		const elapsed = this.startTime === undefined ? 0 : Date.now() - this.startTime;
		// Line count is the most accurate predictor of visible wrap jitter.
		let lineCount = this.buffer.length === 0 ? 0 : 1;
		for (let i = 0; i < this.buffer.length; i++) {
			if (this.buffer.charCodeAt(i) === 10) lineCount++;
		}
		if (
			lineCount >= STREAMING_LINE_THRESHOLD ||
			this.buffer.length >= STREAMING_BYTE_THRESHOLD ||
			elapsed >= STREAMING_TIME_THRESHOLD_MS
		) {
			this.promote();
		}
	}

	private promote(): void {
		this.incremental = true;
		// Move the boundary to just after the last newline in the buffer.
		// If the buffer ends with \n, tailStart = buffer.length and the
		// tail is empty (already committed).
		const idx = this.buffer.lastIndexOf("\n");
		this.tailStart = idx === -1 ? 0 : idx + 1;
		this.committedCache = undefined;
	}

	private renderIncremental(width: number): string[] {
		// Update the boundary: tailStart advances to the first byte after
		// the most recent newline in the buffer. Because newlines only ever
		// arrive at the END of the buffer (text streams are append-only),
		// tailStart is monotonically non-decreasing.
		const lastNl = this.buffer.lastIndexOf("\n");
		const newTailStart = lastNl === -1 ? 0 : lastNl + 1;
		if (newTailStart > this.tailStart) {
			// New committed lines arrived. Drop the cache so the prefix is
			// re-rendered with the new content included.
			this.tailStart = newTailStart;
			this.committedCache = undefined;
		}

		const committedLines = this.renderCommittedPrefix(width);
		const tailText = this.buffer.slice(this.tailStart);
		if (!tailText) return committedLines;
		// A trailing newline in the tail means "this line is done, please
		// commit it" — but if we got here `tailStart` already covers that
		// newline, so any trailing newline in tailText is actually a
		// partial-line followed by a terminator we have not yet promoted.
		// Render only up to the first \n.
		const nlIdx = tailText.indexOf("\n");
		const renderable = nlIdx === -1 ? tailText : tailText.slice(0, nlIdx);
		if (!renderable) return committedLines;
		const md = new Markdown(
			renderable,
			this.paddingX,
			this.paddingY,
			this.theme,
			this.defaultTextStyle,
			this.options,
		);
		return committedLines.concat(md.render(width));
	}

	private renderCommittedPrefix(width: number): string[] {
		const cached = this.committedCache;
		if (cached && cached.width === width) return cached.lines;
		const prefixText = this.buffer.slice(0, this.tailStart);
		const md = new Markdown(
			prefixText,
			this.paddingX,
			this.paddingY,
			this.theme,
			this.defaultTextStyle,
			this.options,
		);
		const lines = md.render(width);
		this.committedCache = { width, lines };
		return lines;
	}
}

import type { Component } from "./tui.ts";

/**
 * Thin `Component` adapter around `StreamingMarkdown` for direct use in a
 * `Container`. The buffer itself stays pure data; this wrapper just exposes
 * the two methods (`render`, `invalidate`) that the TUI tree requires.
 *
 * Construct with the same arguments you'd give `Markdown` (padding, theme,
 * default text style, options), call `append(delta)` as tokens arrive, and
 * call `markComplete()` when the producer reports the stream is done.
 */
export class StreamingMarkdownView implements Component {
	private readonly buffer: StreamingMarkdown;

	constructor(
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.buffer = new StreamingMarkdown(paddingX, paddingY, theme, defaultTextStyle, options);
	}

	append(delta: string): void {
		this.buffer.append(delta);
	}

	seed(text: string): void {
		this.buffer.seed(text);
	}

	updateLayout(
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	): void {
		this.buffer.updateLayout(paddingX, paddingY, theme, defaultTextStyle, options);
	}

	markComplete(): void {
		this.buffer.markComplete();
	}

	render(width: number): string[] {
		return this.buffer.render(width);
	}

	invalidate(): void {
		this.buffer.invalidate();
	}

	/** Whether the buffer has promoted to incremental mode. */
	get isIncremental(): boolean {
		return this.buffer.isIncremental;
	}
}
