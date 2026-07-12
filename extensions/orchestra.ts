/**
 * Orchestra Widget — a live orchestration map above the prompt: which team
 * is active (roster, models, effort), which chains are running, and how
 * agents are linked (parent → child tree via A2A lineage).
 *
 *   ⛭ team squad — lead(pi/main·med) + scout(pi/smol·low), builder, qa
 *   ⛓ chain feature   [scout ✓] → [work ▶]
 *   ▶ lead · 34s
 *     ├ ✓ scout · 8.2k tok
 *     └ ▶ qa · 4s
 *
 * The agent tree renders only while something is running (it vanishes when
 * everything is done — the footer's idle hint takes over); the team line
 * stays while a team is active so the current routing is always visible.
 */

import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	getActiveTeam,
	getBackgroundProcessRegistry,
	listLifecycleAgents,
	onTeamChange,
	type TeamDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { copper, rtrimAnsi } from "./lib/card.ts";
import * as ui from "./lib/chips.ts";
import { icon, onIconModeChange } from "./lib/icons.ts";

const WIDGET_KEY = "orchestra";
const MAX_TREE_LINES = 10;

type ThemeLike = {
	fg(name: string, text: string): string;
	bg(name: string, text: string): string;
	bold(text: string): string;
};

function isAgent(snap: BackgroundProcessSnapshot): boolean {
	return snap.kind === "subagent" || snap.kind === "delegation";
}

// Rim-colored ○ dot, matching the agents hub and loop panel (chips language) —
// replaces the old accent-blue ▶ / success ✓ / error ✗ glyph set.
function statusGlyph(status: BackgroundProcessSnapshot["status"]): string {
	return ui.dotForStatus(status);
}

function elapsed(snap: BackgroundProcessSnapshot): string {
	const ms = (snap.endedAt ?? Date.now()) - snap.startedAt;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

function agentRow(snap: BackgroundProcessSnapshot, theme: ThemeLike): string {
	const name = snap.label.split("·")[0].trim() || snap.agentType || snap.id;
	const parts: string[] = [];
	if (snap.status === "running") parts.push(elapsed(snap));
	const tokens = snap.metrics?.tokens;
	if (tokens) parts.push(`${tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(1)}k`} tok`);
	const meta = parts.length > 0 ? theme.fg("dim", ` · ${parts.join(" · ")}`) : "";
	return `${statusGlyph(snap.status)} ${theme.fg("text", name)}${meta}`;
}

function teamLine(team: TeamDefinition, theme: ThemeLike): string {
	// Group roles that share the same model·effort so repeated specs collapse:
	//   team squad — lead·builder·qa (main·medium) + scout (smol·low)
	const traitsOf = (member?: { model?: string; effort?: string }) =>
		[member?.model?.replace(/^pi\//, ""), member?.effort].filter(Boolean).join("·");
	const groups = new Map<string, string[]>();
	const put = (name: string, traits: string) => {
		const list = groups.get(traits) ?? [];
		list.push(name);
		groups.set(traits, list);
	};
	put("lead", traitsOf(team.lead));
	for (const [name, member] of Object.entries(team.members)) put(name, traitsOf(member));
	const roster =
		groups.size > 0
			? [...groups.entries()]
					.map(([traits, names]) => `${names.join("·")}${traits ? ` (${traits})` : ""}`)
					.join(" + ")
			: "routing only";
	return `${theme.fg("muted", "team")} ${theme.fg("accent", theme.bold(team.name))} ${theme.fg("dim", `— ${roster}`)}`;
}

/** parent→children map: registry parentId is the parent SESSION id. */
function buildTree(agents: BackgroundProcessSnapshot[]): {
	roots: BackgroundProcessSnapshot[];
	children: Map<string, BackgroundProcessSnapshot[]>;
} {
	const sessionToRegistry = new Map<string, string>();
	for (const entry of listLifecycleAgents()) {
		const sessionId = entry.session?.sessionId;
		if (sessionId) sessionToRegistry.set(sessionId, entry.registryId);
	}
	const children = new Map<string, BackgroundProcessSnapshot[]>();
	const roots: BackgroundProcessSnapshot[] = [];
	for (const snap of agents) {
		const parentRegistry = snap.parentId ? sessionToRegistry.get(snap.parentId) : undefined;
		if (parentRegistry) {
			const list = children.get(parentRegistry) ?? [];
			list.push(snap);
			children.set(parentRegistry, list);
		} else {
			roots.push(snap);
		}
	}
	return { roots, children };
}

class OrchestraWidget implements Component {
	private readonly theme: ThemeLike;
	private readonly unsubscribers: Array<() => void> = [];

	constructor(tui: TUI, theme: ThemeLike) {
		this.theme = theme;
		this.unsubscribers.push(
			getBackgroundProcessRegistry().subscribe(() => tui.requestRender()),
			onTeamChange(() => tui.requestRender()),
			onIconModeChange(() => tui.requestRender()),
		);
	}

	dispose(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
	}

	invalidate(): void {}

	render(width: number): string[] {
		try {
			return this.renderLines(width);
		} catch {
			return [];
		}
	}

	private renderLines(width: number): string[] {
		if (width <= 0) return [];
		const theme = this.theme;
		const lines: string[] = [];

		const team = getActiveTeam();
		if (team) lines.push(teamLine(team, theme));

		// Active WorkFrame from the knowledge broker (context-broker publishes it).
		const wf = (globalThis as Record<string, unknown>).__pi_workframe__ as
			| { id?: string; epoch?: number; task?: string }
			| undefined;
		if (wf?.id) {
			const shortTask = (wf.task ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
			// The boot frame at epoch 1 says nothing — show the line only once
			// there's a real task or the direction has shifted.
			const meaningful = (wf.epoch ?? 1) > 1 || (shortTask && shortTask !== "session boot");
			if (meaningful)
				lines.push(
					`${theme.fg("muted", `e${wf.epoch ?? 1}`)}${shortTask ? theme.fg("dim", ` · ${shortTask}`) : ""}`,
				);
		}

		const agents = getBackgroundProcessRegistry().list().filter(isAgent);
		const anyRunning = agents.some((snap) => snap.status === "running");
		if (anyRunning) {
			// Chains first (grouped), then the parent→child tree of the rest.
			const grouped = new Map<string, BackgroundProcessSnapshot[]>();
			const ungrouped: BackgroundProcessSnapshot[] = [];
			for (const snap of agents) {
				if (snap.group) {
					const list = grouped.get(snap.group) ?? [];
					list.push(snap);
					grouped.set(snap.group, list);
				} else {
					ungrouped.push(snap);
				}
			}
			const treeLines: string[] = [];
			for (const [group, members] of grouped) {
				const flow = members
					.map((snap) => `${statusGlyph(snap.status)}${theme.fg("text", ` ${snap.agentType ?? ""}`)}`)
					.join(theme.fg("dim", " → "));
				treeLines.push(`${copper(icon("chain"))} ${theme.fg("muted", `chain ${theme.bold(group)}`)}  ${flow}`);
			}
			const { roots, children } = buildTree(ungrouped);
			const pushNode = (snap: BackgroundProcessSnapshot, depth: number, isLast: boolean): void => {
				const branch = depth === 0 ? "" : theme.fg("dim", `${"  ".repeat(depth - 1)}${isLast ? "└ " : "├ "}`);
				treeLines.push(`${branch}${agentRow(snap, theme)}`);
				const kids = children.get(snap.id) ?? [];
				kids.forEach((kid, index) => {
					pushNode(kid, depth + 1, index === kids.length - 1);
				});
			};
			roots.forEach((root, index) => {
				pushNode(root, 0, index === roots.length - 1);
			});

			if (treeLines.length > MAX_TREE_LINES) {
				const hidden = treeLines.length - MAX_TREE_LINES;
				treeLines.length = MAX_TREE_LINES;
				treeLines.push(theme.fg("dim", `… +${hidden} more (/agents)`));
			}
			lines.push(...treeLines);
		}

		if (lines.length === 0) return [];
		// omp-style: a copper left rule instead of a painted background band —
		// consistent with the forge header and the tool/user message shells.
		const w = Math.min(width, 100);
		return lines
			.filter((line) => line.trim().length > 0)
			.map((line) => `${copper("▎")} ${truncateToWidth(rtrimAnsi(line), w - 2, "…")}`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new OrchestraWidget(tui, theme as unknown as ThemeLike));
	});
}
