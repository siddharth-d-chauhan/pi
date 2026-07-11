/**
 * Every — time-based recurring prompts (the cron half of prospective memory;
 * /intend is the event-triggered half).
 *
 *   /every 10m check the deploy      run a prompt every 10 minutes
 *   /every 2h /loop status           slash commands work too
 *   /every                           list jobs (next fire, fires so far)
 *   /every stop <n>                  remove job n
 *
 * Intervals: Ns/Nm/Nh/Nd, minimum 1 minute, default 10m when omitted.
 * Jobs persist in <repo>/.pi/schedules.json and re-arm when a session opens
 * in that repo; they auto-expire after 7 days (PI_EVERY_MAX_AGE_DAYS).
 * Cross-session dedup: a fire is skipped when another session already fired
 * the job within 90% of its interval (lastFired is persisted).
 * Delivery: busy agent -> queued follow-up; idle agent -> runs immediately.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { copper, heatLine } from "./lib/card.ts";
import { getSlashSeam } from "./lib/kp-bridge.ts";

const MAX_AGE_MS = Number(process.env.PI_EVERY_MAX_AGE_DAYS ?? 7) * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 10 * 60_000;

interface ScheduledJob {
	id: string;
	intervalMs: number;
	prompt: string;
	created: string;
	expiresAt: string;
	lastFired?: string;
	fires?: number;
}

function schedulesPath(cwd: string): string {
	return join(cwd, ".pi", "schedules.json");
}

function loadJobs(cwd: string): ScheduledJob[] {
	try {
		const parsed = JSON.parse(readFileSync(schedulesPath(cwd), "utf-8"));
		if (Array.isArray(parsed)) {
			return parsed.filter((j) => j && typeof j.prompt === "string" && typeof j.intervalMs === "number");
		}
	} catch {
		// none yet
	}
	return [];
}

function saveJobs(cwd: string, jobs: ScheduledJob[]): void {
	try {
		mkdirSync(dirname(schedulesPath(cwd)), { recursive: true });
		writeFileSync(schedulesPath(cwd), `${JSON.stringify(jobs, null, 2)}\n`);
	} catch {
		// best-effort
	}
}

/** "5m" -> 300000; undefined when the token is not an interval. */
export function parseInterval(token: string): number | undefined {
	const m = /^(\d+)([smhd])$/.exec(token);
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
	return Math.max(MIN_INTERVAL_MS, n * unit);
}

function fmtInterval(ms: number): string {
	if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000}h`;
	if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
	return `${Math.round(ms / 60_000)}m`;
}

export default function (pi: ExtensionAPI) {
	const timers = new Map<string, NodeJS.Timeout>();

	function fire(cwd: string, jobId: string): void {
		const jobs = loadJobs(cwd);
		const job = jobs.find((j) => j.id === jobId);
		if (!job) {
			clear(jobId); // stopped elsewhere
			return;
		}
		if (Date.now() > Date.parse(job.expiresAt)) {
			saveJobs(
				cwd,
				jobs.filter((j) => j.id !== jobId),
			);
			clear(jobId);
			return;
		}
		// Cross-session dedup: another pi session may have fired this already.
		const last = job.lastFired ? Date.parse(job.lastFired) : 0;
		if (Date.now() - last >= job.intervalMs * 0.9) {
			job.lastFired = new Date().toISOString();
			job.fires = (job.fires ?? 0) + 1;
			saveJobs(cwd, jobs);
			const details = { prompt: job.prompt, interval: fmtInterval(job.intervalMs), fires: job.fires };
			// Slash prompts execute DIRECTLY through the opt-in seam (the model
			// cannot invoke slash commands); plain prompts go to the model.
			const slash = /^\/(\S+)\s*(.*)$/.exec(job.prompt);
			const handler = slash ? getSlashSeam(slash[1]) : undefined;
			if (slash && handler) {
				pi.sendMessage(
					{ customType: "every-fire", content: `scheduled: ${job.prompt}`, display: true, details },
					{ triggerTurn: false },
				);
				void handler(slash[2] ?? "", {
					cwd,
					ui: {
						notify: (text) => {
							pi.sendMessage(
								{ customType: "every-fire", content: `[${job.prompt}] ${text}`, display: true, details },
								{ triggerTurn: false },
							);
						},
					},
				});
			} else {
				pi.sendMessage(
					{
						customType: "every-fire",
						content: [
							`<scheduled-prompt interval="${fmtInterval(job.intervalMs)}" fire="${job.fires}">`,
							"This is a scheduled recurring prompt the user set up. Execute it now:",
							job.prompt,
							"</scheduled-prompt>",
						].join("\n"),
						display: true,
						details,
					},
					// idle -> run now; busy -> queued as a follow-up, never an interrupt
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
		}
		arm(cwd, jobId, job.intervalMs);
	}

	function arm(cwd: string, jobId: string, intervalMs: number): void {
		clear(jobId);
		const t = setTimeout(() => fire(cwd, jobId), intervalMs);
		t.unref?.();
		timers.set(jobId, t);
	}

	function clear(jobId: string): void {
		const t = timers.get(jobId);
		if (t) clearTimeout(t);
		timers.delete(jobId);
	}

	function armAll(cwd: string): number {
		const jobs = loadJobs(cwd);
		const live = jobs.filter((j) => Date.now() <= Date.parse(j.expiresAt));
		if (live.length !== jobs.length) saveJobs(cwd, live); // prune expired
		for (const job of live) arm(cwd, job.id, job.intervalMs);
		return live.length;
	}

	pi.on("session_start", async () => {
		armAll(process.cwd());
	});
	pi.on("session_shutdown", async () => {
		for (const id of [...timers.keys()]) clear(id);
	});

	pi.registerMessageRenderer<{ prompt?: string; interval?: string; fires?: number }>(
		"every-fire",
		(message, options, theme) => {
			const d = message.details;
			const head =
				`${copper("▎")} ⏱ ${theme.fg("text", `every ${d?.interval ?? "?"}: ${(d?.prompt ?? "").slice(0, 56)}`)} ` +
				`${theme.fg("muted", `· fire #${d?.fires ?? 1}`)}${options.expanded ? "" : ` ${theme.fg("dim", "· ctrl+o")}`}`;
			const body = typeof message.content === "string" ? message.content : "";
			return new Text(
				options.expanded ? `${head}\n${heatLine(46)}\n${theme.fg("dim", body)}` : `${head}\n${heatLine(46)}`,
				0,
				0,
			);
		},
	);

	pi.registerCommand("every", {
		description: "Recurring prompts: /every [interval] <prompt> | /every (list) | /every stop <n>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				const jobs = loadJobs(ctx.cwd).filter((j) => Date.now() <= Date.parse(j.expiresAt));
				if (jobs.length === 0) {
					ctx.ui.notify(
						"no scheduled prompts — /every [interval] <prompt> (e.g. /every 10m check the deploy)",
						"info",
					);
					return;
				}
				const lines = jobs.map((j, n) => {
					const days = Math.max(0, Math.round((Date.parse(j.expiresAt) - Date.now()) / 86_400_000));
					return `${n + 1}. every ${fmtInterval(j.intervalMs)} — ${j.prompt.slice(0, 60)} (${j.fires ?? 0} fires, expires ~${days}d)`;
				});
				ctx.ui.notify(`scheduled prompts (/every stop <n>):\n${lines.join("\n")}`, "info");
				return;
			}
			const stop = /^stop\s+(\d+)$/.exec(raw);
			if (stop) {
				const jobs = loadJobs(ctx.cwd);
				const n = Number(stop[1]);
				if (n < 1 || n > jobs.length) {
					ctx.ui.notify(`Usage: /every stop <1..${jobs.length}>`, "error");
					return;
				}
				const [removed] = jobs.splice(n - 1, 1);
				saveJobs(ctx.cwd, jobs);
				clear(removed.id);
				ctx.ui.notify(`stopped: every ${fmtInterval(removed.intervalMs)} — ${removed.prompt.slice(0, 50)}`, "info");
				return;
			}
			// [interval] <prompt> — leading token is the interval when it parses as one
			const parts = raw.split(/\s+/);
			const lead = parseInterval(parts[0]);
			const intervalMs = lead ?? DEFAULT_INTERVAL_MS;
			const prompt = (lead ? parts.slice(1) : parts).join(" ").trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /every [interval] <prompt> — intervals Ns/Nm/Nh/Nd, min 1m, default 10m", "error");
				return;
			}
			const jobs = loadJobs(ctx.cwd);
			const job: ScheduledJob = {
				id: `e${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				intervalMs,
				prompt: prompt.slice(0, 500),
				created: new Date().toISOString(),
				expiresAt: new Date(Date.now() + MAX_AGE_MS).toISOString(),
				fires: 0,
			};
			jobs.push(job);
			saveJobs(ctx.cwd, jobs);
			arm(ctx.cwd, job.id, intervalMs);
			ctx.ui.notify(
				`scheduled: every ${fmtInterval(intervalMs)} — "${prompt.slice(0, 60)}" (first fire in ${fmtInterval(intervalMs)}, auto-expires in ${Math.round(MAX_AGE_MS / 86_400_000)}d)`,
				"info",
			);
		},
	});
}
