/**
 * Background Tasks Extension — a focusable overlay for background shell
 * commands launched with the bash tool's `run_in_background` option.
 *
 * `/bashes` (alias `/tasks`) opens a live roster of every background command
 * this session: status, `$ command`, age, and output line count. From the list:
 *
 *   ↑/↓  select        Enter/l  open live output    x  kill the selected command
 *   o    show output file path   q/Esc  close
 *
 * In the detail view the command's output tails live; ←/h/Esc returns to the
 * list, x kills, q closes.
 *
 * Everything comes from the core BackgroundProcessRegistry — imported from
 * "@earendil-works/pi-coding-agent", which shares the core module graph, so
 * this is the same singleton the bash tool writes to. No core changes.
 */

import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	formatTaskAge,
	getBackgroundProcessRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Theme = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1];

const STATUS_GLYPH: Record<BackgroundProcessSnapshot["status"], string> = {
	running: "▶",
	idle: "◌",
	parked: "⏸",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
};

const DETAIL_TAIL_LINES = 18;

function glyphColor(status: BackgroundProcessSnapshot["status"]): "accent" | "success" | "error" | "warning" | "dim" {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		default:
			return "dim";
	}
}

class BackgroundTasksComponent implements Component {
	focused = false;

	private selected = 0;
	private detailId: string | undefined;
	private notice = "";
	private snapshots: BackgroundProcessSnapshot[] = [];
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (result: undefined) => void;

	constructor(tui: TUI, theme: Theme, done: (result: undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.refresh();
		this.unsubscribe = getBackgroundProcessRegistry().subscribe(() => {
			this.refresh();
			this.tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	private refresh(): void {
		this.snapshots = getBackgroundProcessRegistry()
			.list()
			.filter((snap) => snap.kind === "shell")
			.sort((a, b) => b.startedAt - a.startedAt);
		if (this.selected >= this.snapshots.length) {
			this.selected = Math.max(0, this.snapshots.length - 1);
		}
	}

	handleInput(data: string): void {
		const selected = this.snapshots[this.selected];

		// Detail (live-tail) view.
		if (this.detailId) {
			if (matchesKey(data, "escape") || data === "q") {
				if (data === "q") this.done(undefined);
				else this.detailId = undefined;
			} else if (matchesKey(data, "left") || data === "h") {
				this.detailId = undefined;
			} else if (data === "x") {
				const entry = this.snapshots.find((s) => s.id === this.detailId);
				if (entry?.canKill && entry.status === "running") getBackgroundProcessRegistry().kill(entry.id);
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.notice = "";
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.snapshots.length - 1), this.selected + 1);
			this.notice = "";
		} else if ((matchesKey(data, "return") || data === "l") && selected) {
			this.detailId = selected.id;
		} else if (data === "x" && selected?.canKill && selected.status === "running") {
			getBackgroundProcessRegistry().kill(selected.id);
		} else if (data === "o" && selected?.summary) {
			this.notice = `output: ${selected.summary}`;
		}
		this.tui.requestRender();
	}

	private renderDetail(width: number): string[] {
		const theme = this.theme;
		const pad = (s: string) => truncateToWidth(s, width);
		const entry = getBackgroundProcessRegistry().get(this.detailId as string);
		const snap = this.snapshots.find((s) => s.id === this.detailId);
		const lines: string[] = [];
		if (!entry || !snap) {
			lines.push(pad(theme.fg("muted", "  (task no longer available)")));
			lines.push("");
			lines.push(pad(theme.fg("dim", "  ←/Esc back · q close")));
			return lines;
		}
		const glyph = STATUS_GLYPH[snap.status] ?? "·";
		lines.push(pad(`${theme.fg(glyphColor(snap.status), glyph)} ${theme.fg("accent", theme.bold(snap.label))}`));
		lines.push(pad(theme.fg("dim", `  ${snap.status} · ${formatTaskAge(snap)} · ${snap.logSize} lines`)));
		if (snap.summary) lines.push(pad(theme.fg("dim", `  output: ${snap.summary}`)));
		lines.push("");
		const tail = entry.log.slice(-DETAIL_TAIL_LINES);
		if (tail.length === 0) {
			lines.push(pad(theme.fg("muted", "  (no output yet)")));
		} else {
			for (const line of tail) lines.push(pad(theme.fg("toolOutput", `  ${line}`)));
		}
		lines.push("");
		lines.push(pad(theme.fg("dim", `  ←/Esc back · ${snap.status === "running" ? "x kill · " : ""}q close`)));
		return lines;
	}

	render(width: number): string[] {
		if (this.detailId) return this.renderDetail(width);

		const theme = this.theme;
		const lines: string[] = [];
		const pad = (s: string) => truncateToWidth(s, width);
		lines.push(pad(theme.fg("accent", theme.bold(" Background Tasks "))));
		lines.push("");

		if (this.snapshots.length === 0) {
			lines.push(pad(theme.fg("muted", "  No background commands this session.")));
			lines.push(pad(theme.fg("dim", "  Launch one with the bash tool's run_in_background option.")));
		}

		for (let i = 0; i < this.snapshots.length; i++) {
			const snap = this.snapshots[i];
			const cursor = i === this.selected ? theme.fg("accent", "› ") : "  ";
			const glyph = STATUS_GLYPH[snap.status] ?? "·";
			const metricsParts = [formatTaskAge(snap)];
			if (snap.logSize) metricsParts.push(`${snap.logSize} lines`);
			const metrics = theme.fg("dim", metricsParts.join(" · "));
			const label = theme.fg("muted", snap.label);
			lines.push(pad(`${cursor}${theme.fg(glyphColor(snap.status), glyph)} ${label} ${metrics}`));
			// Live tail preview under the selected running task.
			if (i === this.selected && snap.logTail.length > 0) {
				const preview = snap.logTail[snap.logTail.length - 1];
				lines.push(pad(theme.fg("dim", `    ${preview}`)));
			}
		}

		lines.push("");
		if (this.notice) lines.push(pad(theme.fg("accent", `  ${this.notice}`)));
		lines.push(pad(theme.fg("dim", "  ↑/↓ select · Enter open · x kill · o output path · q/Esc close")));
		return lines;
	}
}

function openOverlay(ctx: ExtensionContext): Promise<undefined> {
	return ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new BackgroundTasksComponent(tui, theme, done), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "80%", minWidth: 56, maxHeight: "70%", margin: 1 },
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bashes", {
		description: "Background shell commands: live output, kill (run_in_background)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openOverlay(ctx);
		},
	});
	pi.registerCommand("tasks", {
		description: "Background shell commands: live output, kill (alias of /bashes)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openOverlay(ctx);
		},
	});
	// Ctrl+Alt+B opens the background tasks panel. (Plain Ctrl+B is the
	// editor's cursor-left binding, so we use the Ctrl+Alt namespace that
	// other pi extensions use for overlays, e.g. Ctrl+Alt+A for the agent hub.)
	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Open background tasks (shell commands)",
		handler: async (ctx: ExtensionContext) => {
			await openOverlay(ctx);
		},
	});
}
