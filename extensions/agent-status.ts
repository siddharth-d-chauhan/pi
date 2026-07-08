/**
 * Agent Status Extension — a Claude Code-style footer indicator for
 * subagents. No popups, no extra widgets: a compact segment rendered by
 * the DEFAULT footer via ctx.ui.setStatus().
 *
 *   ● 2 agents            while agents are running (accent circle)
 *   ● 3 agents · 1 done   multiple agents, some finished (GREEN circle)
 *   (nothing)             once everything is done — the segment clears
 *
 * Use /agents (agent-hub extension) to inspect, steer, or kill.
 */

import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	getBackgroundProcessRegistry,
	theme,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "agent-status";

function isAgent(snap: BackgroundProcessSnapshot): boolean {
	return snap.kind === "subagent" || snap.kind === "delegation";
}

function segmentText(): string | undefined {
	const agents = getBackgroundProcessRegistry().list().filter(isAgent);
	const running = agents.filter((snap) => snap.status === "running").length;
	if (running === 0) return undefined; // all done (or none) — disappear
	const done = agents.filter((snap) => snap.status === "completed").length;
	const someDoneOfMany = agents.length > 1 && done > 0;
	const circle = theme.fg(someDoneOfMany ? "success" : "accent", "●");
	const label = `${running} agent${running === 1 ? "" : "s"}`;
	const doneNote = someDoneOfMany ? theme.fg("dim", ` · ${done} done`) : "";
	return `${circle} ${theme.fg("muted", label)}${doneNote}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, segmentText());
		getBackgroundProcessRegistry().subscribe(() => {
			ctx.ui.setStatus(STATUS_KEY, segmentText());
		});
	});
}
