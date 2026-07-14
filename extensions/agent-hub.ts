/**
 * Agent Hub Extension — a focusable bottom drawer for managing subagents.
 *
 * `/agents` opens a Claude-style live activity view over the shared background
 * registry: subagents, delegated work, background shells, and extension tasks.
 * Entries are grouped by Needs input / Working / Completed. From the list:
 *
 *   ↑/↓  select        ←/→/Tab  filter all/agents/processes
 *   Enter open detail  x  kill running / remove finished
 *   s    steer/message (running: steer; idle/parked: wake with a message)
 *   r    revive a parked agent   q/Esc  close
 *
 * Everything comes from the core BackgroundProcessRegistry — imported from
 * "@earendil-works/pi-coding-agent", which shares the core module graph, so
 * this is the same singleton the built-in widgets read. No core changes.
 */

import {
	type BackgroundProcessSnapshot,
	deliverToAgent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	formatTaskAge,
	getBackgroundProcessRegistry,
	reviveAgent,
	sanitizeLogLine,
} from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as ui from "./lib/chips.ts";

type Theme = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1];

function formatTokens(tokens: number): string {
	return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

type ActivityFilter = "all" | "agents" | "processes";
export type ActivitySection = "needs-input" | "working" | "completed";

const FILTERS: ActivityFilter[] = ["all", "agents", "processes"];
const SECTION_ORDER: ActivitySection[] = ["needs-input", "working", "completed"];
const DETAIL_LINES = 16;

const SECTION_LABELS: Record<ActivitySection, string> = {
	"needs-input": "Needs input",
	working: "Working",
	completed: "Finished",
};

function isAgent(snapshot: BackgroundProcessSnapshot): boolean {
	return snapshot.kind === "subagent" || snapshot.kind === "delegation";
}

function isLoop(snapshot: BackgroundProcessSnapshot): boolean {
	return snapshot.kind === "delegation" && /^↻\s+(?:loop|orchestrate)\b/.test(snapshot.label);
}

export function activityKind(snapshot: BackgroundProcessSnapshot): string {
	if (isLoop(snapshot)) return "loop";
	if (isAgent(snapshot)) return snapshot.agentType ?? "agent";
	return snapshot.kind === "shell" ? "$" : snapshot.kind;
}

export function activitySection(snapshot: BackgroundProcessSnapshot): ActivitySection {
	if (snapshot.inputRequest) return "needs-input";
	if (snapshot.status === "running") return "working";
	return "completed";
}

function matchesFilter(snapshot: BackgroundProcessSnapshot, filter: ActivityFilter): boolean {
	if (filter === "all") return true;
	return filter === "agents" ? isAgent(snapshot) : !isAgent(snapshot);
}

export function groupActivity(
	snapshots: BackgroundProcessSnapshot[],
	filter: ActivityFilter,
): Record<ActivitySection, BackgroundProcessSnapshot[]> {
	const groups: Record<ActivitySection, BackgroundProcessSnapshot[]> = {
		"needs-input": [],
		working: [],
		completed: [],
	};
	for (const snapshot of snapshots) {
		if (matchesFilter(snapshot, filter)) groups[activitySection(snapshot)].push(snapshot);
	}
	for (const section of SECTION_ORDER) groups[section].sort((a, b) => b.startedAt - a.startedAt);
	return groups;
}

function headline(snapshot: BackgroundProcessSnapshot): string {
	if (snapshot.inputRequest) return snapshot.inputRequest;
	const latest = snapshot.logTail.at(-1);
	return snapshot.summary?.trim() || (latest ? sanitizeLogLine(latest) : "") || snapshot.label;
}

export class AgentHubComponent implements Component {
	focused = false;

	private selected = 0;
	private steering = false;
	private steerText = "";
	private messageTargetId: string | undefined;
	private filter: ActivityFilter = "all";
	private detailId: string | undefined;
	private detailTop = 0;
	private followTail = true;
	private snapshots: BackgroundProcessSnapshot[] = [];
	private readonly unsubscribe: () => void;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: undefined) => void;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.refresh();
		this.unsubscribe = getBackgroundProcessRegistry().subscribe(() => {
			this.refresh();
			this.tui.requestRender();
		});
	}

	/** Cycle the selection among RUNNING tasks (wraps). In detail view, jumps the
	 *  detail to the next running task — Claude's shift+↓ transcript cycling. */
	private cycleRunning(direction: 1 | -1): void {
		const running = this.snapshots.map((s, i) => ({ s, i })).filter(({ s }) => s.status === "running");
		if (running.length === 0) return;
		const currentId = this.detailId ?? this.snapshots[this.selected]?.id;
		const at = running.findIndex(({ s }) => s.id === currentId);
		const next = running[(at + direction + running.length) % running.length];
		this.selected = next.i;
		if (this.detailId) this.openDetail(next.s);
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	private refresh(): void {
		const selectedId = this.snapshots[this.selected]?.id;
		const groups = groupActivity(getBackgroundProcessRegistry().list(), this.filter);
		this.snapshots = SECTION_ORDER.flatMap((section) => groups[section]);
		if (selectedId) {
			const nextIndex = this.snapshots.findIndex((snapshot) => snapshot.id === selectedId);
			if (nextIndex >= 0) this.selected = nextIndex;
		}
		if (this.selected >= this.snapshots.length) {
			this.selected = Math.max(0, this.snapshots.length - 1);
		}
		if (this.detailId && this.followTail) {
			const entry = getBackgroundProcessRegistry().get(this.detailId);
			this.detailTop = Math.max(0, (entry?.log.length ?? 0) - DETAIL_LINES);
		}
	}

	private cycleFilter(direction: -1 | 1): void {
		const index = FILTERS.indexOf(this.filter);
		this.filter = FILTERS[(index + direction + FILTERS.length) % FILTERS.length];
		this.selected = 0;
		this.refresh();
	}

	private openDetail(selected: BackgroundProcessSnapshot): void {
		this.detailId = selected.id;
		this.followTail = true;
		const entry = getBackgroundProcessRegistry().get(selected.id);
		this.detailTop = Math.max(0, (entry?.log.length ?? 0) - DETAIL_LINES);
	}

	private scrollDetail(delta: number): void {
		const entry = this.detailId ? getBackgroundProcessRegistry().get(this.detailId) : undefined;
		const maxTop = Math.max(0, (entry?.log.length ?? 0) - DETAIL_LINES);
		this.detailTop = Math.max(0, Math.min(maxTop, this.detailTop + delta));
		this.followTail = this.detailTop === maxTop;
	}

	private canMessage(snapshot: BackgroundProcessSnapshot | undefined): snapshot is BackgroundProcessSnapshot {
		return Boolean(
			snapshot &&
				isAgent(snapshot) &&
				(snapshot.status === "running" || snapshot.status === "idle" || snapshot.status === "parked"),
		);
	}

	private beginMessage(snapshot: BackgroundProcessSnapshot): void {
		this.steering = true;
		this.steerText = "";
		this.messageTargetId = snapshot.id;
	}

	private finishMessage(): void {
		this.steering = false;
		this.steerText = "";
		this.messageTargetId = undefined;
	}

	private renderMessageComposer(width: number): string[] {
		const target = this.snapshots.find((snapshot) => snapshot.id === this.messageTargetId);
		return [
			truncateToWidth(
				` ${ui.copper(ui.bold(`steer ${target?.agentType ?? "agent"}`))} ${ui.faint("›")} ${ui.ink(this.steerText)}${ui.amber("▌")}`,
				width,
			),
			truncateToWidth(
				ui.keyHints([
					["↵", "send"],
					["esc", "cancel"],
				]),
				width,
			),
		];
	}

	handleInput(data: string): void {
		const selected = this.snapshots[this.selected];

		if (this.steering) {
			if (matchesKey(data, "escape")) {
				this.finishMessage();
			} else if (matchesKey(data, "return")) {
				const target = this.snapshots.find((snapshot) => snapshot.id === this.messageTargetId);
				if (target && this.steerText.trim()) {
					const text = this.steerText.trim();
					if (target.status === "running" || isLoop(target)) {
						getBackgroundProcessRegistry().update(target.id, { inputRequest: undefined });
						getBackgroundProcessRegistry().steer(target.id, text);
					} else {
						getBackgroundProcessRegistry().update(target.id, { inputRequest: undefined });
						void deliverToAgent(target.id, text, { from: "user" }).then((receipt) => {
							if (receipt.status === "failed") {
								getBackgroundProcessRegistry().appendLog(target.id, `[message failed: ${receipt.reason}]`);
							}
						});
					}
				}
				this.finishMessage();
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

		if (this.detailId) {
			const detail = this.snapshots.find((snapshot) => snapshot.id === this.detailId);
			if (matchesKey(data, "shift+down")) {
				this.cycleRunning(1);
			} else if (matchesKey(data, "shift+up")) {
				this.cycleRunning(-1);
			} else if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.detailId = undefined;
			} else if (data === "q") {
				this.done(undefined);
			} else if (this.keybindings.matches(data, "tui.select.up")) {
				this.scrollDetail(-1);
			} else if (this.keybindings.matches(data, "tui.select.down")) {
				this.scrollDetail(1);
			} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
				this.scrollDetail(-DETAIL_LINES);
			} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
				this.scrollDetail(DETAIL_LINES);
			} else if (data === "x") {
				if (detail?.canKill && detail.status === "running") getBackgroundProcessRegistry().kill(detail.id);
			} else if (this.keybindings.matches(data, "tui.activity.message") && this.canMessage(detail)) {
				this.beginMessage(detail);
			}
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "shift+down")) {
			this.cycleRunning(1);
		} else if (matchesKey(data, "shift+up")) {
			this.cycleRunning(-1);
		} else if (this.keybindings.matches(data, "tui.select.up")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.selected = Math.min(Math.max(0, this.snapshots.length - 1), this.selected + 1);
		} else if (this.keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.cycleFilter(-1);
		} else if (
			this.keybindings.matches(data, "tui.editor.cursorRight") ||
			this.keybindings.matches(data, "tui.input.tab")
		) {
			this.cycleFilter(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm") && selected) {
			this.openDetail(selected);
		} else if (data === "x" && selected?.canKill && selected.status === "running") {
			getBackgroundProcessRegistry().kill(selected.id);
		} else if (data === "x" && selected && selected.status !== "running" && selected.status !== "idle") {
			getBackgroundProcessRegistry().unregister(selected.id);
		} else if (data === "r" && selected?.status === "parked") {
			if (isLoop(selected)) getBackgroundProcessRegistry().steer(selected.id, "more 1");
			else void reviveAgent(selected.id);
		} else if (this.keybindings.matches(data, "tui.activity.message") && this.canMessage(selected)) {
			this.beginMessage(selected);
		}
		this.tui.requestRender();
	}

	private renderDetail(width: number): string[] {
		const theme = this.theme;
		const pad = (text: string) => truncateToWidth(text, width);
		const snapshot = this.snapshots.find((item) => item.id === this.detailId);
		const entry = this.detailId ? getBackgroundProcessRegistry().get(this.detailId) : undefined;
		if (!snapshot || !entry) {
			return [
				pad(`  ${ui.soft("this activity is no longer available")}`),
				"",
				pad(
					ui.keyHints([
						["esc", "back"],
						["q", "close"],
					]),
				),
			];
		}

		const lines: string[] = [];
		const kind = activityKind(snapshot);
		// header: kind chip · status pill · id, then label/summary, then metrics
		lines.push(
			pad(
				` ${ui.chip(kind.toUpperCase())} ${ui.statusPill(snapshot.status)} ${ui.faint(snapshot.id)}  ${ui.faint(formatTaskAge(snapshot))}`,
			),
		);
		lines.push(pad(`  ${ui.ink(snapshot.label)}`));
		if (snapshot.summary && snapshot.summary !== snapshot.label) {
			lines.push(pad(`  ${ui.soft(snapshot.summary)}`));
		}
		const metrics = snapshot.metrics;
		if (metrics) {
			const parts = [
				metrics.freshTokens ? `${formatTokens(metrics.freshTokens)} fresh` : undefined,
				metrics.cacheReadTokens ? `${formatTokens(metrics.cacheReadTokens)} cached` : undefined,
				!metrics.freshTokens && !metrics.cacheReadTokens && metrics.tokens
					? `${formatTokens(metrics.tokens)} tok`
					: undefined,
				metrics.costUsd ? `$${metrics.costUsd.toFixed(4)}` : undefined,
				metrics.requests ? `${metrics.requests} req` : undefined,
				metrics.contextPct ? `${metrics.contextPct.toFixed(0)}% ctx` : undefined,
			].filter((part): part is string => part !== undefined);
			if (parts.length > 0) lines.push(pad(`  ${ui.faint(parts.join(" · "))}`));
		}
		lines.push("");
		const position =
			entry.log.length > DETAIL_LINES
				? ui.faint(
						`${this.detailTop + 1}-${this.detailTop + Math.min(DETAIL_LINES, entry.log.length - this.detailTop)}/${entry.log.length}`,
					)
				: "";
		lines.push(pad(ui.section("output", position)));
		const visible = entry.log.slice(this.detailTop, this.detailTop + DETAIL_LINES);
		if (visible.length === 0) {
			lines.push(pad(`  ${ui.faint("(no output yet)")}`));
		} else {
			for (const raw of visible) lines.push(pad(theme.fg("toolOutput", `  ${sanitizeLogLine(raw)}`)));
		}
		lines.push("");
		if (this.steering) {
			lines.push(...this.renderMessageComposer(width));
			return lines;
		}
		const hints: Array<[string, string]> = [
			["↑↓", "scroll"],
			["⇧↓", "running"],
		];
		if (this.canMessage(snapshot)) {
			const messageKey = this.keybindings.getKeys("tui.activity.message")[0] ?? "s";
			hints.push([messageKey, "steer"]);
		}
		if (snapshot.status === "running" && snapshot.canKill) hints.push(["x", "kill"]);
		hints.push(["esc", "back"], ["q", "close"]);
		lines.push(pad(ui.keyHints(hints)));
		return lines;
	}

	render(width: number): string[] {
		if (this.detailId) return this.renderDetail(width);
		const lines: string[] = [];
		const pad = (s: string) => truncateToWidth(s, width);

		// header: AGENTS chip · running/needs-input rollup · filter chips (right)
		const groups = groupActivity(this.snapshots, "all");
		const runningN = this.snapshots.filter((s) => s.status === "running").length;
		const needsN = groups["needs-input"].length;
		const rollup = [
			runningN > 0 ? `${ui.amber(ui.bold(String(runningN)))} ${ui.soft("running")}` : "",
			needsN > 0 ? `${ui.blue(ui.bold(String(needsN)))} ${ui.soft("needs input")}` : "",
		]
			.filter(Boolean)
			.join(ui.faint("  ·  "));
		const filters = FILTERS.map((filter) =>
			filter === this.filter ? ui.pill("blue", filter) : ui.faint(` ${filter} `),
		).join(" ");
		lines.push(pad(ui.rowAlign(` ${ui.chip("AGENTS")}  ${rollup}`, filters, width)));
		lines.push("");

		if (this.snapshots.length === 0) {
			lines.push(pad(`  ${ui.soft(`no ${this.filter === "all" ? "activity" : this.filter} this session`)}`));
			lines.push("");
			lines.push(pad(ui.keyHints([["q", "close"]])));
			return lines;
		}

		let rowIndex = 0;
		for (const section of SECTION_ORDER) {
			const entries = groups[section];
			if (entries.length === 0) continue;
			lines.push(pad(ui.section(SECTION_LABELS[section], ui.faint(String(entries.length)))));
			for (const snapshot of entries) {
				const kind = activityKind(snapshot);
				const group = snapshot.group ? ui.faint(` · ${snapshot.group}`) : "";
				const left =
					` ${ui.dotForStatus(snapshot.status)} ${ui.copper(kind.padEnd(6))} ` +
					`${ui.statusPill(snapshot.status)} ${ui.ink(headline(snapshot))}${group}`;
				const right = ui.faint(formatTaskAge(snapshot));
				const row = ui.rowAlign(left, right, width - 1);
				lines.push(rowIndex === this.selected ? ui.cursorRow(row, width) : pad(` ${row}`));
				rowIndex++;
			}
		}

		lines.push("");
		if (this.steering) {
			lines.push(...this.renderMessageComposer(width));
		} else {
			const messageKey = this.keybindings.getKeys("tui.activity.message")[0] ?? "s";
			lines.push(
				pad(
					ui.keyHints([
						["↑↓", "select"],
						["⇧↓", "running"],
						["←→", "filter"],
						["↵", "logs"],
						["x", "kill"],
						[messageKey, "steer"],
						["r", "revive"],
						["q", "close"],
					]),
				),
			);
		}
		return lines;
	}
}

export function openHub(ctx: ExtensionContext): Promise<undefined> {
	return ctx.ui.custom<undefined>(
		(tui, theme, keybindings, done) => new AgentHubComponent(tui, theme, keybindings, done),
		{ drawer: { height: "40%" } },
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("agents", {
		description: "Open unified subagent and background-process activity",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await openHub(ctx);
		},
	});
	// Ctrl+Alt+A opens the agent roster (quick-key parity with Claude Code).
	// Note: pi core already routes the plain Down arrow on an empty editor here
	// when subagents/delegations are active (and to the built-in background-log
	// panel otherwise), so we deliberately do NOT bind Shift+Down — that would
	// shadow the core panel. Inside the hub, Shift+↑/↓ cycles between running
	// tasks and Enter opens the selected task's live logs.
	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Open unified subagent and background-process activity",
		handler: async (ctx: ExtensionContext) => {
			await openHub(ctx);
		},
	});
}
