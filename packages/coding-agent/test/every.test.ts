import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import everyExt, { parseInterval } from "../../../extensions/every.ts";
import { registerSlashSeam } from "../../../extensions/lib/kp-bridge.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	((globalThis as Record<string, unknown>).__pi_slash__ as Map<string, unknown>)?.clear();
});

function harness() {
	const handlers = new Map<string, (e: unknown) => Promise<void>>();
	let cmd: ((a: string, c: unknown) => Promise<void>) | undefined;
	const sent: Array<{
		msg: { customType: string; content: string; details?: Record<string, unknown> };
		opts?: Record<string, unknown>;
	}> = [];
	const notes: string[] = [];
	const pi = {
		on(e: string, h: (x: unknown) => Promise<void>) {
			handlers.set(e, h);
		},
		registerTool() {},
		registerMessageRenderer() {},
		registerCommand(_n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) {
			cmd = d.handler;
		},
		sendMessage(msg: never, opts?: Record<string, unknown>) {
			sent.push({ msg, opts });
		},
	};
	everyExt(pi as never);
	return { handlers, cmd, sent, notes, ctx: (cwd: string) => ({ cwd, ui: { notify: (t: string) => notes.push(t) } }) };
}

test("parseInterval: units, floor, rejects non-intervals", () => {
	expect(parseInterval("5m")).toBe(300_000);
	expect(parseInterval("2h")).toBe(7_200_000);
	expect(parseInterval("1d")).toBe(86_400_000);
	expect(parseInterval("30s")).toBe(60_000); // floored to 1m
	expect(parseInterval("check")).toBeUndefined();
	expect(parseInterval("5")).toBeUndefined();
});

test("schedule -> fires on interval -> repeats -> stop halts", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/every-`);
	const h = harness();
	const ctx = h.ctx(cwd);

	await h.cmd?.("5m check the deploy", ctx);
	expect(h.notes[0]).toContain("every 5m");
	expect(JSON.parse(readFileSync(join(cwd, ".pi", "schedules.json"), "utf-8"))).toHaveLength(1);

	// nothing yet, then the first fire at +5m: turn-triggering, follow-up when busy
	await vi.advanceTimersByTimeAsync(4 * 60_000);
	expect(h.sent.length).toBe(0);
	await vi.advanceTimersByTimeAsync(90_000);
	expect(h.sent.length).toBe(1);
	expect(h.sent[0].msg.customType).toBe("every-fire");
	expect(h.sent[0].msg.content).toContain("check the deploy");
	expect(h.sent[0].opts?.triggerTurn).toBe(true);
	expect(h.sent[0].opts?.deliverAs).toBe("followUp");

	// keeps firing
	await vi.advanceTimersByTimeAsync(5 * 60_000);
	expect(h.sent.length).toBe(2);
	expect(h.sent[1].msg.details?.fires).toBe(2);

	// stop removes the job and halts the timer
	await h.cmd?.("stop 1", ctx);
	await vi.advanceTimersByTimeAsync(20 * 60_000);
	expect(h.sent.length).toBe(2);
	expect(JSON.parse(readFileSync(join(cwd, ".pi", "schedules.json"), "utf-8"))).toHaveLength(0);
});

test("slash prompts execute through the seam, not the model", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/every3-`);
	const seamCalls: Array<{ args: string; cwd: string }> = [];
	registerSlashSeam("dream", async (args, ctx) => {
		seamCalls.push({ args, cwd: ctx.cwd });
		ctx.ui.notify("dream dispatched", "info");
	});
	const h = harness();
	await h.cmd?.("1d /dream force", h.ctx(cwd));
	await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1000);
	// the seam handler ran with the right args and cwd
	expect(seamCalls).toEqual([{ args: "force", cwd }]);
	// no model-directed <scheduled-prompt> was sent — only status chips
	const contents = h.sent.map((s) => s.msg.content);
	expect(contents.some((c) => c.includes("<scheduled-prompt"))).toBe(false);
	expect(contents.some((c) => c.includes("scheduled: /dream force"))).toBe(true);
	expect(contents.some((c) => c.includes("[/dream force] dream dispatched"))).toBe(true);
	// none of the chips trigger a turn
	expect(h.sent.every((s) => s.opts?.triggerTurn === false)).toBe(true);
	// an UNREGISTERED slash prompt falls back to model-directed text
	const h2 = harness();
	await h2.cmd?.("1d /nonexistent thing", h2.ctx(mkdtempSync(`${tmpdir()}/every4-`)));
	await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1000);
	expect(h2.sent.some((s) => s.msg.content.includes("<scheduled-prompt"))).toBe(true);
});

test("cross-session dedup + expiry + re-arm on session_start", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/every2-`);
	// a persisted job another session JUST fired, and one long expired
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "schedules.json"),
		JSON.stringify([
			{
				id: "e-live",
				intervalMs: 300_000,
				prompt: "poll the queue",
				created: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
				lastFired: new Date().toISOString(), // other session fired NOW
				fires: 3,
			},
			{
				id: "e-old",
				intervalMs: 300_000,
				prompt: "ancient job",
				created: new Date(0).toISOString(),
				expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
				fires: 99,
			},
		]),
	);

	const h = harness();
	const origCwd = process.cwd();
	process.chdir(cwd);
	try {
		await h.handlers.get("session_start")?.({});
		// expired job pruned on re-arm
		const jobs = JSON.parse(readFileSync(join(cwd, ".pi", "schedules.json"), "utf-8"));
		expect(jobs).toHaveLength(1);
		// ANOTHER session fires the job 3m into our 5m wait (rewrites lastFired)...
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		jobs[0].lastFired = new Date().toISOString();
		writeFileSync(join(cwd, ".pi", "schedules.json"), JSON.stringify(jobs));
		// ...so OUR tick at +5m is skipped (their fire was 2m ago < 90% of 5m)
		await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000);
		expect(h.sent.length).toBe(0);
		// the next tick is legitimately due and fires
		await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].msg.content).toContain("poll the queue");
		// shutdown clears timers
		await h.handlers.get("session_shutdown")?.({});
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(h.sent.length).toBe(1);
	} finally {
		process.chdir(origCwd);
	}
});
