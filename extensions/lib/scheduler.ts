/**
 * scheduler.ts — pure durable-scheduler core (Wave 5).
 *
 * `/every` persists schedule DEFINITIONS in .pi/schedules.json but only ARMS
 * them while a Pi session is open — close the session and nothing fires. This
 * splits definition-persistence from EXECUTION OWNERSHIP so a small per-project
 * daemon (bin/pi-scheduler.mjs) can own firing independently of any TUI:
 *
 *  - a single active daemon holds a LEASE (heartbeat + TTL) so two daemons — or a
 *    daemon and an in-session /every — never double-fire the same job;
 *  - due-job computation is catch-up aware: a recurring job whose interval
 *    elapsed while the daemon was DOWN fires once on restart (missed fires
 *    collapse, they don't spam), and a one-shot whose time passed still fires;
 *  - recurrence is capped by expiresAt, optional maxFires, and one-shot.
 *
 * Pure and side-effect-free (except the tiny load/save helpers) so the firing
 * policy unit-tests without a daemon, a clock, or a Pi process.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScheduledJob {
	id: string;
	/** Recurring interval in ms. A one-shot ignores this after its single fire. */
	intervalMs: number;
	prompt: string;
	created?: string;
	/** ISO instant after which the job is dead and never fires. */
	expiresAt: string;
	fires?: number;
	/** Fire once, then never again (catch-up: fires even if its time passed while down). */
	oneShot?: boolean;
	/** Hard cap on total fires (recurrence cap). */
	maxFires?: number;
	/** ISO instant before which the job must not fire. */
	startAt?: string;
}

export interface SchedulerState {
	/** The active daemon's lease. Absent when no daemon has ever run. */
	lease?: { owner: string; heartbeatAt: number };
	/** Job id -> last fire epoch ms. */
	lastFired: Record<string, number>;
	/** Job id -> fire count (daemon-side, authoritative for durable fires). */
	fires: Record<string, number>;
}

/** A lease older than this (no heartbeat) is stale and may be taken over. */
export const LEASE_TTL_MS = 90_000;

export function emptyState(): SchedulerState {
	return { lastFired: {}, fires: {} };
}

export function statePath(cwd: string): string {
	return join(cwd, ".pi", "scheduler-state.json");
}

export function loadState(cwd: string): SchedulerState {
	try {
		const p = statePath(cwd);
		if (!existsSync(p)) return emptyState();
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		return {
			lease: parsed.lease && typeof parsed.lease.owner === "string" ? parsed.lease : undefined,
			lastFired: parsed.lastFired && typeof parsed.lastFired === "object" ? parsed.lastFired : {},
			fires: parsed.fires && typeof parsed.fires === "object" ? parsed.fires : {},
		};
	} catch {
		return emptyState();
	}
}

export function saveState(cwd: string, state: SchedulerState): void {
	writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

/** Whether a live daemon lease is held right now, and by whom. */
export function leaseStatus(
	state: SchedulerState,
	now: number,
	ttl: number = LEASE_TTL_MS,
): { held: boolean; owner?: string } {
	const l = state.lease;
	if (!l) return { held: false };
	if (now - l.heartbeatAt > ttl) return { held: false, owner: l.owner }; // stale — takeable
	return { held: true, owner: l.owner };
}

/** May `owner` run the scheduler? Yes when the lease is free/stale or already ours. */
export function canRun(state: SchedulerState, owner: string, now: number, ttl: number = LEASE_TTL_MS): boolean {
	const s = leaseStatus(state, now, ttl);
	return !s.held || s.owner === owner;
}

/** Take/refresh the lease for `owner` (writes a fresh heartbeat). */
export function refreshLease(state: SchedulerState, owner: string, now: number): SchedulerState {
	return { ...state, lease: { owner, heartbeatAt: now } };
}

function firesOf(job: ScheduledJob, state: SchedulerState): number {
	return state.fires[job.id] ?? job.fires ?? 0;
}

/** The jobs due to fire at `now`, catch-up aware. Missed recurring intervals
 *  collapse to a single fire; a one-shot fires once even if its time passed. */
export function dueJobs(jobs: ScheduledJob[], state: SchedulerState, now: number): ScheduledJob[] {
	const out: ScheduledJob[] = [];
	for (const j of jobs) {
		if (!j || typeof j.prompt !== "string" || typeof j.intervalMs !== "number") continue;
		if (j.expiresAt && now > Date.parse(j.expiresAt)) continue; // expired
		if (j.startAt && now < Date.parse(j.startAt)) continue; // not yet
		const count = firesOf(j, state);
		if (j.oneShot && count >= 1) continue; // one-shot done
		if (j.maxFires != null && count >= j.maxFires) continue; // recurrence cap
		const last = state.lastFired[j.id];
		if (last == null) {
			if (j.oneShot) {
				out.push(j); // never fired one-shot: fire now (catch-up)
				continue;
			}
			// recurring, never fired: baseline off startAt/created; fire after one interval
			const baseRaw = j.startAt ?? j.created;
			const baseline = baseRaw ? Date.parse(baseRaw) : now;
			if (Number.isFinite(baseline) && now - baseline >= j.intervalMs) out.push(j);
			continue;
		}
		if (j.oneShot) continue; // one-shot with a recorded fire: never again
		if (now - last >= j.intervalMs) out.push(j); // recurring interval elapsed (collapses misses)
	}
	return out;
}

/** Record a fire of `id` at `now` (advances lastFired + fires count). */
export function recordFire(state: SchedulerState, id: string, now: number): SchedulerState {
	return {
		...state,
		lastFired: { ...state.lastFired, [id]: now },
		fires: { ...state.fires, [id]: (state.fires[id] ?? 0) + 1 },
	};
}
