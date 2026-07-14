/**
 * Agent Footer Extension — a custom footer focused on subagent activity.
 *
 * Replaces the default footer with a live agent strip:
 *
 *   ▶ worker 2m · ▶ explore 14s · ✓ 3 done   ⇄ 12.4k tok · $0.0180   model (branch)
 *
 * Left: running agents (up to three, with age), then a done/failed rollup.
 * Middle: total tokens/cost across all subagents this session.
 * Right: current model and git branch.
 *
 * Data comes from the core BackgroundProcessRegistry, which the `agent`
 * tool feeds (status, metrics, log). Importing it from
 * "@earendil-works/pi-coding-agent" shares the CORE module graph, so this
 * is the same singleton the widgets use — no globalThis tricks needed.
 *
 * Toggle with /agentfooter. See custom-footer.ts for the base pattern.
 */

import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	formatTaskAge,
	getBackgroundProcessRegistry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MAX_RUNNING_SHOWN = 3;

function formatTokens(tokens: number): string {
	return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

function agentTotals(snapshots: BackgroundProcessSnapshot[]): { fresh: number; cached: number; cost: number } {
	let fresh = 0;
	let cached = 0;
	let cost = 0;
	for (const snap of snapshots) {
		fresh += snap.metrics?.freshTokens ?? snap.metrics?.tokens ?? 0;
		cached += snap.metrics?.cacheReadTokens ?? 0;
		cost += snap.metrics?.costUsd ?? 0;
	}
	return { fresh, cached, cost };
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	pi.registerCommand("agentfooter", {
		description: "Toggle the subagent-activity footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;

			if (!enabled) {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
				return;
			}

			ctx.ui.setFooter((tui, theme, footerData) => {
				const registry = getBackgroundProcessRegistry();
				const unsubRegistry = registry.subscribe(() => tui.requestRender());
				const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

				return {
					dispose: () => {
						unsubRegistry();
						unsubBranch();
					},
					invalidate() {},
					render(width: number): string[] {
						const agents = registry
							.list()
							.filter((snap) => snap.kind === "subagent" || snap.kind === "delegation");
						const running = agents.filter((snap) => snap.status === "running");
						const done = agents.filter((snap) => snap.status === "completed").length;
						const failed = agents.filter((snap) => snap.status === "failed").length;

						const parts: string[] = [];
						for (const snap of running.slice(0, MAX_RUNNING_SHOWN)) {
							const name = snap.agentType ?? snap.label;
							parts.push(theme.fg("accent", `▶ ${name}`) + theme.fg("dim", ` ${formatTaskAge(snap)}`));
						}
						if (running.length > MAX_RUNNING_SHOWN) {
							parts.push(theme.fg("dim", `+${running.length - MAX_RUNNING_SHOWN} more`));
						}
						if (done > 0) parts.push(theme.fg("dim", `✓ ${done} done`));
						if (failed > 0) parts.push(theme.fg("error", `✗ ${failed} failed`));
						const left = parts.length > 0 ? parts.join(theme.fg("dim", " · ")) : theme.fg("dim", "no agents");

						const totals = agentTotals(agents);
						const middle =
							totals.fresh > 0
								? theme.fg(
										"dim",
										`⇄ ${formatTokens(totals.fresh)} fresh${totals.cached ? ` · ${formatTokens(totals.cached)} cached` : ""} · $${totals.cost.toFixed(4)}`,
									)
								: "";

						const branch = footerData.getGitBranch();
						const right = theme.fg("dim", `${ctx.model?.id ?? "no-model"}${branch ? ` (${branch})` : ""}`);

						const used = visibleWidth(left) + visibleWidth(middle) + visibleWidth(right);
						const gap = Math.max(1, Math.floor((width - used) / 2));
						const line = left + " ".repeat(gap) + middle + " ".repeat(Math.max(1, width - used - gap)) + right;
						return [truncateToWidth(line, width)];
					},
				};
			});
			ctx.ui.notify("Agent footer enabled", "info");
		},
	});
}
