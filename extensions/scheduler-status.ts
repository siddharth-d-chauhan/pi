/**
 * scheduler-status.ts — visibility for the durable schedule daemon (Wave 5).
 *
 * `/schedule` shows whether a pi-scheduler daemon is alive (holds a live lease),
 * and each job's interval, fire count, and last/next fire. It complements
 * `/every` (which defines schedules): this reports on DURABLE execution — the
 * jobs that fire even with no session open. Read-only; does not fire anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LEASE_TTL_MS, leaseStatus, loadState, type ScheduledJob } from "./lib/scheduler.ts";

function loadJobs(cwd: string): ScheduledJob[] {
	try {
		const p = join(cwd, ".pi", "schedules.json");
		if (!existsSync(p)) return [];
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		return Array.isArray(parsed)
			? parsed.filter((j) => j && typeof j.prompt === "string" && typeof j.intervalMs === "number")
			: [];
	} catch {
		return [];
	}
}

function fmtAge(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("schedule", {
		description: "Durable schedule daemon status: is it alive, and when did/will jobs fire",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const now = Date.now();
			const state = loadState(cwd);
			const lease = leaseStatus(state, now);
			const jobs = loadJobs(cwd);

			const header = lease.held
				? `Daemon: ALIVE · owner=${lease.owner} · heartbeat ${fmtAge(now - (state.lease?.heartbeatAt ?? now))} ago`
				: `Daemon: STOPPED${lease.owner ? ` (last owner ${lease.owner}, stale >${fmtAge(LEASE_TTL_MS)})` : ""} — start: node bin/pi-scheduler.mjs`;

			const lines = jobs.length
				? jobs.map((j) => {
						const fires = state.fires[j.id] ?? j.fires ?? 0;
						const last = state.lastFired[j.id];
						const lastStr = last ? `last ${fmtAge(now - last)} ago` : "never fired";
						const next = last ? `next ~${fmtAge(Math.max(0, j.intervalMs - (now - last)))}` : "next: due";
						return `  · ${j.prompt} — every ${fmtAge(j.intervalMs)} · fires=${fires} · ${lastStr} · ${next}`;
					})
				: ["  (no schedules — create with /every <interval> <prompt>)"];

			ctx.ui.notify([header, ...lines].join("\n"), "info");
		},
	});
}
