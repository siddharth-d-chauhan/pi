import { expect, test } from "vitest";
import {
	canRun,
	dueJobs,
	emptyState,
	LEASE_TTL_MS,
	leaseStatus,
	recordFire,
	refreshLease,
	type ScheduledJob,
	type SchedulerState,
} from "../../../extensions/lib/scheduler.ts";

const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const iso = (t: number) => new Date(t).toISOString();

function job(over: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "j1",
		intervalMs: HOUR,
		prompt: "/dream force",
		created: iso(now - 2 * HOUR),
		expiresAt: iso(now + 365 * 24 * HOUR),
		...over,
	};
}

// --- lease ---------------------------------------------------------------

test("a fresh lease is held; a stale one is takeable", () => {
	const held: SchedulerState = { ...emptyState(), lease: { owner: "a", heartbeatAt: now - 1000 } };
	expect(leaseStatus(held, now).held).toBe(true);
	const stale: SchedulerState = { ...emptyState(), lease: { owner: "a", heartbeatAt: now - LEASE_TTL_MS - 1 } };
	expect(leaseStatus(stale, now).held).toBe(false);
	expect(leaseStatus(stale, now).owner).toBe("a"); // reports prior owner
});

test("canRun: free/stale lease or our own lets us run; someone else's live lease blocks", () => {
	expect(canRun(emptyState(), "me", now)).toBe(true);
	const mine: SchedulerState = { ...emptyState(), lease: { owner: "me", heartbeatAt: now } };
	expect(canRun(mine, "me", now)).toBe(true);
	const other: SchedulerState = { ...emptyState(), lease: { owner: "other", heartbeatAt: now } };
	expect(canRun(other, "me", now)).toBe(false);
	const staleOther: SchedulerState = {
		...emptyState(),
		lease: { owner: "other", heartbeatAt: now - LEASE_TTL_MS - 1 },
	};
	expect(canRun(staleOther, "me", now)).toBe(true);
});

test("refreshLease writes our heartbeat", () => {
	const s = refreshLease(emptyState(), "me", now);
	expect(s.lease).toEqual({ owner: "me", heartbeatAt: now });
});

// --- due computation -----------------------------------------------------

test("a recurring job fires after one interval from its baseline, not immediately", () => {
	const fresh = job({ created: iso(now) }); // created just now
	expect(dueJobs([fresh], emptyState(), now)).toEqual([]); // not yet due
	const aged = job({ created: iso(now - HOUR - 1) }); // one interval elapsed
	expect(dueJobs([aged], emptyState(), now).map((j) => j.id)).toEqual(["j1"]);
});

test("after firing, a recurring job is due again only once the interval re-elapses", () => {
	let state = recordFire(emptyState(), "j1", now - HOUR / 2);
	expect(dueJobs([job()], state, now)).toEqual([]); // half an interval in
	state = recordFire(emptyState(), "j1", now - HOUR - 1);
	expect(dueJobs([job()], state, now).map((j) => j.id)).toEqual(["j1"]);
});

test("missed recurring fires collapse to a single catch-up fire", () => {
	// last fired 10 intervals ago -> due, but only ONE entry (not 10)
	const state = recordFire(emptyState(), "j1", now - 10 * HOUR);
	const due = dueJobs([job()], state, now);
	expect(due.length).toBe(1);
});

test("a one-shot fires once (even overdue) then never again", () => {
	const os = job({ oneShot: true, startAt: iso(now - 5 * HOUR) });
	expect(dueJobs([os], emptyState(), now).map((j) => j.id)).toEqual(["j1"]); // overdue -> fires
	const fired = recordFire(emptyState(), "j1", now);
	expect(dueJobs([os], fired, now)).toEqual([]); // never again
});

test("expiresAt, startAt, and maxFires gate firing", () => {
	expect(dueJobs([job({ expiresAt: iso(now - 1) })], emptyState(), now)).toEqual([]); // expired
	expect(dueJobs([job({ startAt: iso(now + HOUR) })], emptyState(), now)).toEqual([]); // not yet
	const capped = job({ created: iso(now - 5 * HOUR), maxFires: 3 });
	const atCap = recordFire(
		recordFire(recordFire(emptyState(), "j1", now - 3 * HOUR), "j1", now - 2 * HOUR),
		"j1",
		now - HOUR - 1,
	);
	expect(dueJobs([capped], atCap, now)).toEqual([]); // hit the cap
});

test("recordFire advances lastFired and increments the count", () => {
	const s = recordFire(recordFire(emptyState(), "j1", now - HOUR), "j1", now);
	expect(s.lastFired.j1).toBe(now);
	expect(s.fires.j1).toBe(2);
});
