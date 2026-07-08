/**
 * BackgroundStatusWidget — compact below-editor summary of in-flight
 * background work (subagents, delegated agents, tracked subprocesses).
 *
 * Renders nothing when the registry has no running entries, one line per
 * running entry up to a small cap, then a rollup line. The down-arrow
 * affordance (editor empty → BackgroundLogPanel) is the drill-in; this
 * widget is the always-visible surface that tells the user something is
 * running down there in the first place.
 *
 * render() runs on every TUI frame, so the running list is cached and
 * refreshed only by the registry subscription (which also asks the TUI
 * for a re-render). The widget owns no timers: elapsed times are computed
 * at render time, so they refresh whenever anything else triggers a
 * render, which is plenty for a coarse "2m" display.
 */

import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type BackgroundProcessKind,
	type BackgroundProcessSnapshot,
	formatTaskAge,
	getBackgroundProcessRegistry,
} from "../../../core/background-process-registry.ts";
import { theme } from "../theme/theme.ts";

/** Max individual entry lines before rolling up into a count. */
const MAX_ENTRY_LINES = 3;

const KIND_LABELS: Record<BackgroundProcessKind, string> = {
	subagent: "agent",
	delegation: "agent",
	mcp: "mcp",
	"shell-suspend": "shell",
	other: "task",
};

/**
 * Make a raw log line safe to embed in a rendered TUI row: drop CSI/OSC
 * escape sequences and map remaining control characters (\r, \t, \b, …)
 * to spaces so they can't move the cursor or skew width math.
 */
function sanitizeLogLine(line: string): string {
	return line
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b./g, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim();
}

export class BackgroundStatusWidget implements Component {
	private ui: TUI;
	private running: BackgroundProcessSnapshot[] = [];
	private unsubscribe: (() => void) | undefined;

	constructor(ui: TUI) {
		this.ui = ui;
		this.refresh();
		this.unsubscribe = getBackgroundProcessRegistry().subscribe(() => {
			this.refresh();
			this.ui.requestRender();
		});
	}

	private refresh(): void {
		this.running = getBackgroundProcessRegistry()
			.list()
			.filter((s) => s.status === "running");
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	invalidate(): void {
		// Renders from the subscription-maintained cache; nothing else cached.
	}

	render(width: number): string[] {
		const running = this.running;
		if (running.length === 0) return [];

		const lines: string[] = [];
		for (const snapshot of running.slice(0, MAX_ENTRY_LINES)) {
			lines.push(this.renderEntry(snapshot, width));
		}
		const remaining = running.length - MAX_ENTRY_LINES;
		if (remaining > 0) {
			lines.push(truncateToWidth(theme.fg("dim", `  … and ${remaining} more`), width, "…"));
		}
		lines.push(
			truncateToWidth(
				theme.fg(
					"dim",
					`  ${running.length === 1 ? "1 background task" : `${running.length} background tasks`} · ↓ on empty prompt to inspect`,
				),
				width,
				"…",
			),
		);
		return lines;
	}

	private renderEntry(snapshot: BackgroundProcessSnapshot, width: number): string {
		const marker = theme.fg("accent", "▸");
		const kind = theme.fg("muted", KIND_LABELS[snapshot.kind]);
		const label = theme.fg("accent", snapshot.label);
		const elapsed = theme.fg("dim", formatTaskAge(snapshot));
		const tail = snapshot.logTail.at(-1);
		const sanitized = tail ? sanitizeLogLine(tail) : "";
		const preview = sanitized ? theme.fg("dim", ` · ${sanitized}`) : "";
		return truncateToWidth(`${marker} ${kind} ${label} ${elapsed}${preview}`, width, "…");
	}
}
