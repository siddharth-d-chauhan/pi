/**
 * HistorySearchComponent — reverse-i-search over the session's prior user
 * messages. Bound to Ctrl-R from the editor.
 *
 * Behaviour:
 *  - User types a substring; the matching list narrows on each keystroke.
 *  - Backspace deletes from the search query.
 *  - Enter / Right-arrow commits the highlighted match back to the editor.
 *  - Esc / Ctrl-G cancels.
 *  - Ctrl-R (or Down-arrow) cycles to the next-older match.
 *
 * The component is a self-contained input handler; the owner (interactive
 * mode) wires `onCommit` and `onCancel` to its own overlay lifecycle.
 */

import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export interface HistorySearchOptions {
	/** User messages from the current session, oldest → newest. */
	history: string[];
	/** Initial query (e.g. the editor's current text), pre-filled. */
	initialQuery?: string;
	/** Called with the chosen prompt text. */
	onCommit: (text: string) => void;
	/** Called when the user dismisses without choosing. */
	onCancel: () => void;
}

const MAX_VISIBLE = 5;
const PROMPTPrefix = "(reverse-i-search)\u0060";
const PROMPTSuffix = "\u0027: ";

export class HistorySearchComponent extends Container {
	private query: string;
	private matchIndex = 0;
	private readonly history: string[];
	private readonly onCommit: (text: string) => void;
	private readonly onCancel: () => void;

	constructor(opts: HistorySearchOptions) {
		super();
		this.history = opts.history;
		this.query = opts.initialQuery ?? "";
		this.onCommit = opts.onCommit;
		this.onCancel = opts.onCancel;
		this.addChild(new DynamicBorder());
		this.rebuild();
		this.addChild(new DynamicBorder());
	}

	/** Current matches for the current query, newest → oldest. */
	private matches(): string[] {
		if (!this.query) return [];
		const q = this.query.toLowerCase();
		const out: string[] = [];
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (this.history[i].toLowerCase().includes(q)) out.push(this.history[i]);
		}
		return out;
	}

	/** Current highlight, or undefined if no matches. */
	private currentMatch(): string | undefined {
		const m = this.matches();
		if (m.length === 0) return undefined;
		if (this.matchIndex >= m.length) this.matchIndex = 0;
		return m[this.matchIndex];
	}

	private rebuild(): void {
		// Drop everything except the top/bottom borders (children 0 and last).
		while (this.children.length > 2) {
			this.removeChild(this.children[1]);
		}
		const innerWidth = Math.max(40, 80);
		const lines: string[] = [];
		lines.push(this.renderPromptRow(innerWidth));
		lines.push("");
		const cur = this.currentMatch();
		if (cur) {
			const idx = cur.toLowerCase().indexOf(this.query.toLowerCase());
			const before = idx >= 0 ? cur.slice(0, idx) : "";
			const match = idx >= 0 ? cur.slice(idx, idx + this.query.length) : "";
			const after = idx >= 0 ? cur.slice(idx + this.query.length) : "";
			lines.push(
				theme.fg("muted", "match: ") +
					theme.fg("text", before) +
					theme.fg("accent", theme.bold(match)) +
					theme.fg("text", after),
			);
			const rest = this.matches().slice(this.matchIndex + 1, this.matchIndex + 1 + MAX_VISIBLE);
			if (rest.length > 0) {
				lines.push(theme.fg("dim", "older:"));
				for (const m of rest) {
					lines.push(theme.fg("dim", `  ${truncateToWidth(m, innerWidth - 4, theme.fg("dim", "…"))}`));
				}
			}
		} else if (this.query) {
			lines.push(theme.fg("muted", "(no matches)"));
		} else {
			lines.push(theme.fg("muted", "(type to search prompt history)"));
		}
		lines.push("");
		lines.push(theme.fg("dim", "Enter to commit · Ctrl-R for next match · Esc/Ctrl-G to cancel"));
		this.addChildAt(1, new Text(lines.join("\n"), 0, 0));
	}

	private addChildAt(index: number, child: import("@earendil-works/pi-tui").Component): void {
		// Container.addChild appends; we want to insert at index 1 (after the
		// top border). Use a tiny splice to keep the rest of the component
		// tree intact.
		const c = this.children as unknown as Array<import("@earendil-works/pi-tui").Component>;
		c.splice(index, 0, child);
	}

	private renderPromptRow(width: number): string {
		const tail = PROMPTSuffix;
		const q = theme.fg("text", this.query);
		const cur = theme.fg("accent", "\u2588"); // block cursor
		const prefix = theme.fg("accent", PROMPTPrefix);
		const prompt = prefix + q + cur + theme.fg("muted", tail);
		return prompt + " ".repeat(Math.max(0, width - 1 - rawWidth(prompt)));
	}

	invalidate(): void {
		this.rebuild();
	}

	dispose(): void {
		// no resources
	}

	handleInput(data: string): void {
		// Esc / Ctrl-G → cancel.
		if (data === "\x1b" || data === "\x07") {
			this.onCancel();
			return;
		}
		// Ctrl-R (0x12) → next-older match.
		if (data === "\x12") {
			const m = this.matches();
			if (m.length > 0) this.matchIndex = (this.matchIndex + 1) % m.length;
			this.rebuild();
			return;
		}
		// Enter → commit.
		if (data === "\r" || data === "\n") {
			const m = this.currentMatch();
			if (m !== undefined) this.onCommit(m);
			else this.onCancel();
			return;
		}
		// Backspace.
		if (data === "\x7f" || data === "\b") {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.matchIndex = 0;
				this.rebuild();
			}
			return;
		}
		// Printable input — append (ignore control chars except those handled above).
		if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
			this.query += data;
			this.matchIndex = 0;
			this.rebuild();
		}
	}
}

/** Lightweight width calculator (avoids pulling visibleWidth from tui). */
function rawWidth(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0x1b) {
			i++;
			while (i < s.length) {
				const cc = s.charCodeAt(i);
				if (cc >= 0x40 && cc <= 0x7e) break;
				i++;
			}
			continue;
		}
		n++;
	}
	return n;
}
