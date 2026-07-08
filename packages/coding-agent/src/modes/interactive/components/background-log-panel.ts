/**
 * BackgroundLogPanel — a focusable component that lists registered
 * background processes and shows the selected process's log.
 *
 * The panel is opened by the editor's down-arrow handler (see
 * `custom-editor.ts`) and is rendered via `tui.showOverlay` so it floats
 * over the editor and steals focus until dismissed. Dismissal happens on
 * Esc or `q`; the `done` callback handed to the component's owner closes
 * the overlay and returns focus to the editor.
 *
 * Today the registry is empty in practice — no callers register processes
 * yet. The panel still renders correctly: an empty-state line and the
 * standard Esc/q dismiss. When future subagent/parallel-tool work lands
 * and calls `getBackgroundProcessRegistry().register(...)`, the panel
 * lights up automatically via its subscription.
 */

import type { Component, Terminal } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	type BackgroundProcessSnapshot,
	formatTaskAge,
	getBackgroundProcessRegistry,
} from "../../../core/background-process-registry.ts";

const EMPTY_STATE = "No background processes registered.";
const HEADER = "Background processes (Esc/q to close)";
const FOOTER_HINT = "↑/↓ select · Enter to view log · Esc/q to close";

const STATUS_GLYPH: Record<BackgroundProcessSnapshot["status"], string> = {
	running: "●",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
};

export interface BackgroundLogPanelOptions {
	terminal: Terminal;
	/** Called when the user dismisses the panel; the owner closes the overlay. */
	onDismiss: () => void;
}

export class BackgroundLogPanel implements Component {
	private snapshots: BackgroundProcessSnapshot[];
	private selectedIndex: number = 0;
	private unsubscribe: () => void;
	private opts: BackgroundLogPanelOptions;

	constructor(opts: BackgroundLogPanelOptions) {
		this.opts = opts;
		this.snapshots = getBackgroundProcessRegistry().list();
		this.unsubscribe = getBackgroundProcessRegistry().subscribe(() => {
			// Re-snapshot on every mutation; clamp the selected index so a
			// disappearing entry doesn't strand the user mid-list.
			this.snapshots = getBackgroundProcessRegistry().list();
			if (this.selectedIndex >= this.snapshots.length) {
				this.selectedIndex = Math.max(0, this.snapshots.length - 1);
			}
		});
	}

	invalidate(): void {
		// no cached state to drop
	}

	dispose(): void {
		this.unsubscribe();
	}

	handleInput(data: string): void {
		// Esc / q — dismiss.
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.opts.onDismiss();
			return;
		}
		// Navigation. Empty list: nothing to do but accept the key.
		if (this.snapshots.length === 0) return;
		// Up / k — previous.
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = (this.selectedIndex - 1 + this.snapshots.length) % this.snapshots.length;
			return;
		}
		// Down / j — next.
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % this.snapshots.length;
			return;
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 4); // border + padding
		const lines: string[] = [];
		lines.push(this.#pad(HEADER, width));
		lines.push(""); // spacer

		if (this.snapshots.length === 0) {
			lines.push(this.#pad(EMPTY_STATE, width));
		} else {
			// List entries.
			this.snapshots.forEach((snap, i) => {
				const isSelected = i === this.selectedIndex;
				const marker = isSelected ? "▸" : " ";
				const age = this.#formatAge(snap);
				const status = STATUS_GLYPH[snap.status];
				const row = `${marker} ${status} ${snap.label.padEnd(20).slice(0, 20)} ${age}`;
				lines.push(this.#pad(truncateToWidth(row, innerWidth), width));
			});
			lines.push(""); // spacer
			// Selected entry: show summary + log tail.
			const selected = this.snapshots[this.selectedIndex];
			if (selected) {
				lines.push(this.#pad(`— ${selected.label} (${selected.kind}, ${selected.status}) —`, width));
				if (selected.summary) {
					lines.push(this.#pad(truncateToWidth(selected.summary, innerWidth), width));
				}
				const tail = selected.logTail;
				if (tail.length === 0) {
					lines.push(this.#pad("(no log output yet)", width));
				} else {
					for (const l of tail) lines.push(this.#pad(truncateToWidth(l, innerWidth), width));
				}
			}
		}
		lines.push(""); // spacer
		lines.push(this.#pad(FOOTER_HINT, width));
		return lines;
	}

	#pad(text: string, width: number): string {
		// Right-pad to width with spaces. The TUI's diff renderer will paint
		// the panel over the editor, but we don't draw a border here — the
		// caller is expected to wrap in a Box or render in a bordered
		// overlay; this keeps the panel focused on content.
		const pad = Math.max(0, width - visibleWidth(text));
		return text + " ".repeat(pad);
	}

	#formatAge(snap: BackgroundProcessSnapshot): string {
		return formatTaskAge(snap);
	}
}

// Local util — avoid pulling from @earendil-works/pi-tui just for this.
function truncateToWidth(s: string, w: number): string {
	if (w <= 0) return "";
	if (visibleWidth(s) <= w) return s;
	// Cut from the right; preserve at least one char of body.
	return `…${s.slice(s.length - Math.max(0, w - 1))}`;
}

function visibleWidth(s: string): number {
	// Strip ANSI SGR/CSI for width purposes. Good enough for log tail rendering;
	// the panel renders content the registry already stored as plain strings
	// in practice, so this rarely encounters escapes.
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c === 0x1b) {
			// Skip CSI / OSC / DCS-ish sequences by jumping to the next
			// letter-like terminator. Best-effort.
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
