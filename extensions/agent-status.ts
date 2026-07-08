/**
 * Agent Status Extension — a compact below-editor strip of in-flight
 * background work (subagents, tracked tasks).
 *
 *   ▸ agent worker 2m · reading src/auth/session.ts
 *   2 background tasks · /agents to inspect
 *
 * Renders nothing while idle. Fed by the core BackgroundProcessRegistry
 * (same singleton the agent tool writes — imported from
 * "@earendil-works/pi-coding-agent", which shares the core module graph).
 */

import {
	type BackgroundProcessKind,
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	formatTaskAge,
	getBackgroundProcessRegistry,
	sanitizeLogLine,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Max individual entry lines before rolling up into a count. */
const MAX_ENTRY_LINES = 3;

const KIND_LABELS: Record<BackgroundProcessKind, string> = {
	subagent: "agent",
	delegation: "agent",
	mcp: "mcp",
	"shell-suspend": "shell",
	other: "task",
};

type ThemeLike = { fg(name: string, text: string): string };

class AgentStatusWidget implements Component {
	private running: BackgroundProcessSnapshot[] = [];
	private readonly unsubscribe: () => void;
	private readonly theme: ThemeLike;

	constructor(tui: TUI, theme: ThemeLike) {
		this.theme = theme;
		this.refresh();
		this.unsubscribe = getBackgroundProcessRegistry().subscribe(() => {
			this.refresh();
			tui.requestRender();
		});
	}

	private refresh(): void {
		this.running = getBackgroundProcessRegistry()
			.list()
			.filter((snap) => snap.status === "running");
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.theme;
		const running = this.running;
		if (running.length === 0) return [];

		const lines: string[] = [];
		for (const snap of running.slice(0, MAX_ENTRY_LINES)) {
			const marker = theme.fg("accent", "▸");
			const kind = theme.fg("muted", KIND_LABELS[snap.kind]);
			const label = theme.fg("accent", snap.label);
			const age = theme.fg("dim", formatTaskAge(snap));
			const tail = snap.logTail.at(-1);
			const preview = tail ? theme.fg("dim", ` · ${sanitizeLogLine(tail)}`) : "";
			lines.push(truncateToWidth(`${marker} ${kind} ${label} ${age}${preview}`, width, "…"));
		}
		const remaining = running.length - MAX_ENTRY_LINES;
		if (remaining > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  … and ${remaining} more`), width, "…"));
		}
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`  ${running.length === 1 ? "1 background task" : `${running.length} background tasks`} · /agents to inspect`,
				),
				width,
				"…",
			),
		);
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("agent-status", (tui, theme) => new AgentStatusWidget(tui, theme), {
			placement: "belowEditor",
		});
	});
}
