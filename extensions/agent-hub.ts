/**
 * Agent Hub Extension — a focusable overlay for managing subagents.
 *
 * `/agents` opens a live roster of every subagent the `agent` tool has
 * registered this session: status, label, age, tokens/cost. From the list:
 *
 *   ↑/↓  select        x  kill the selected running agent
 *   s    steer (type a message, Enter sends it to the running child)
 *   Esc  close
 *
 * Everything comes from the core BackgroundProcessRegistry — imported from
 * "@earendil-works/pi-coding-agent", which shares the core module graph, so
 * this is the same singleton the built-in widgets read. No core changes.
 */

import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	type ExtensionCommandContext,
	formatTaskAge,
	getBackgroundProcessRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type Theme = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1];

const STATUS_GLYPH: Record<BackgroundProcessSnapshot["status"], string> = {
	running: "▶",
	idle: "◌",
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
};

function formatTokens(tokens: number): string {
	return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

class AgentHubComponent implements Component {
	focused = false;

	private selected = 0;
	private steering = false;
	private steerText = "";
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
			.filter((snap) => snap.kind === "subagent" || snap.kind === "delegation");
		if (this.selected >= this.snapshots.length) {
			this.selected = Math.max(0, this.snapshots.length - 1);
		}
	}

	handleInput(data: string): void {
		const selected = this.snapshots[this.selected];

		if (this.steering) {
			if (matchesKey(data, "escape")) {
				this.steering = false;
				this.steerText = "";
			} else if (matchesKey(data, "return")) {
				if (selected && this.steerText.trim()) {
					getBackgroundProcessRegistry().steer(selected.id, this.steerText.trim());
				}
				this.steering = false;
				this.steerText = "";
			} else if (matchesKey(data, "backspace")) {
				this.steerText = this.steerText.slice(0, -1);
			} else if (!data.startsWith("\x1b")) {
				for (const ch of data) {
					if (ch >= " " && ch !== "\x7f") this.steerText += ch;
				}
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
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.snapshots.length - 1), this.selected + 1);
		} else if (data === "x" && selected?.canKill && selected.status === "running") {
			getBackgroundProcessRegistry().kill(selected.id);
		} else if (data === "s" && selected?.canSteer && selected.status === "running") {
			this.steering = true;
			this.steerText = "";
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		const pad = (s: string) => truncateToWidth(s, width);
		lines.push(pad(theme.fg("accent", theme.bold(" Agent Hub "))));
		lines.push("");

		if (this.snapshots.length === 0) {
			lines.push(pad(theme.fg("muted", "  No subagents this session. Spawn one with the agent tool.")));
		}
		for (let i = 0; i < this.snapshots.length; i++) {
			const snap = this.snapshots[i];
			const cursor = i === this.selected ? theme.fg("accent", "› ") : "  ";
			const glyph = STATUS_GLYPH[snap.status] ?? "·";
			const glyphColor = snap.status === "running" ? "accent" : snap.status === "failed" ? "error" : "dim";
			const name = theme.fg("accent", theme.bold(snap.agentType ?? "agent"));
			const metricsParts: string[] = [formatTaskAge(snap)];
			if (snap.metrics?.tokens) metricsParts.push(`${formatTokens(snap.metrics.tokens)} tok`);
			if (snap.metrics?.costUsd) metricsParts.push(`$${snap.metrics.costUsd.toFixed(4)}`);
			const metrics = theme.fg("dim", metricsParts.join(" · "));
			const label = theme.fg("muted", snap.label);
			lines.push(pad(`${cursor}${theme.fg(glyphColor, glyph)} ${name} ${metrics} ${label}`));
		}

		lines.push("");
		if (this.steering) {
			const target = this.snapshots[this.selected];
			lines.push(
				pad(
					theme.fg("accent", `  steer ${target?.agentType ?? "agent"} › `) +
						this.steerText +
						theme.fg("accent", "█"),
				),
			);
			lines.push(pad(theme.fg("dim", "  Enter to send · Esc to cancel")));
		} else {
			lines.push(pad(theme.fg("dim", "  ↑/↓ select · x kill · s steer · Esc close")));
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "Open the agent hub (roster, kill, steer)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => new AgentHubComponent(tui, theme, done), {
				overlay: true,
				overlayOptions: { anchor: "center", width: "80%", minWidth: 56, maxHeight: "70%", margin: 1 },
			});
		},
	});
}
