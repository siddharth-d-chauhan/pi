import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
	canonicalize,
	distill,
	type RunRecord,
	recurrence,
	scoreRun,
	versionTrend,
} from "../../../extensions/lib/loop-optimizer.ts";
import loopExtension from "../../../extensions/loop.ts";

const DEMO = process.env.DEMO === "1";
const show = (label: string, obj: unknown) => {
	if (!DEMO) return;
	process.stderr.write(`\n${"═".repeat(72)}\n${label}\n${"─".repeat(72)}\n${obj}\n`);
};

const CRITERIA_STEP =
	'Before ANY "done" verdict: run each remaining criterion\'s `verify` command from criteria.json and PASTE its real output into PROGRESS.md. Only flip passes=true from pasted command output — never from assertion. (learned: repeated done claims left criteria unmet — c1)';

test("optimizer pure logic: canonicalize, distill, recurrence, trend", () => {
	expect(canonicalize(CRITERIA_STEP)).not.toContain("(learned:");
	expect(canonicalize(CRITERIA_STEP).endsWith("assertion.")).toBe(true);

	const runs: RunRecord[] = [
		{
			goal: "a",
			promptVersion: 1,
			rounds: 6,
			rejections: 3,
			completed: true,
			learned: [{ cls: "criteria", text: CRITERIA_STEP }],
		},
		{
			goal: "b",
			promptVersion: 1,
			rounds: 5,
			rejections: 2,
			completed: true,
			learned: [{ cls: "criteria", text: CRITERIA_STEP }],
		},
		{
			goal: "c",
			promptVersion: 1,
			rounds: 4,
			rejections: 2,
			completed: false,
			learned: [{ cls: "criteria", text: CRITERIA_STEP }],
		},
		{
			goal: "d",
			promptVersion: 1,
			rounds: 3,
			rejections: 1,
			completed: true,
			learned: [{ cls: "review", text: "x (learned: independent review keeps rejecting — y)" }],
		},
	];
	// criteria recurred in 3 distinct runs -> promotable at minRuns=3; review only 1
	const proposals = distill(runs, [], 3);
	expect(proposals.length).toBe(1);
	expect(proposals[0].cls).toBe("criteria");
	expect(proposals[0].runs).toBe(3);
	expect(proposals[0].text).not.toContain("(learned:");

	// already-promoted class is not re-proposed
	expect(distill(runs, [{ cls: "criteria", text: "x", runs: 3, version: 2 }], 3).length).toBe(0);

	// recurrence before/after a promotion at version 2
	const withAfter: RunRecord[] = [
		...runs,
		{ goal: "e", promptVersion: 2, rounds: 2, rejections: 0, completed: true, learned: [] },
		{ goal: "f", promptVersion: 2, rounds: 2, rejections: 0, completed: true, learned: [] },
	];
	const eff = recurrence(withAfter, { cls: "criteria", text: "x", runs: 3, version: 2 });
	expect(eff.before).toBe("3/4"); // minted in 3 of 4 pre-promotion runs
	expect(eff.after).toBe("0/2"); // zero recurrences after promotion — it worked

	expect(scoreRun(runs[0])).toBeCloseTo(1 - 0.3 - 0.45, 5);
	const trend = versionTrend(withAfter);
	expect(trend.map((t) => t.version)).toEqual([1, 2]);
	expect(trend[1].meanScore).toBeGreaterThan(trend[0].meanScore); // v2 scores better
	show("version trend", JSON.stringify(trend, null, 2));
});

test("optimizer command: journal -> distill -> apply -> next loop pre-loaded", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/loop-opt-`);
	const sent: Array<{ customType: string; content: string; details?: Record<string, unknown> }> = [];
	let settled: (() => Promise<void>) | undefined;
	let cmd: ((a: string, c: unknown) => Promise<void>) | undefined;
	const pi = {
		registerTool() {},
		registerMessageRenderer() {},
		registerCommand(_n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) {
			cmd = d.handler;
		},
		on(e: string, h: () => Promise<void>) {
			if (e === "agent_settled") settled = h;
		},
		sendMessage(m: { customType: string; content: string; details?: Record<string, unknown> }) {
			sent.push(m);
		},
	};
	const notes: string[] = [];
	const ctx = { cwd, ui: { notify: (t: string, l: string) => notes.push(`[${l}] ${t}`) } };
	const registry = getBackgroundProcessRegistry();
	const lastOf = (type: string) => [...sent].reverse().find((m) => m.customType === type);

	loopExtension(pi as never);
	if (!cmd) throw new Error("no command");

	// Seed a journal: 3 past runs that each had to LEARN the criteria lesson.
	mkdirSync(`${cwd}/.pi/loops/_optimizer`, { recursive: true });
	const journal = ["past-a", "past-b", "past-c"]
		.map((goal) =>
			JSON.stringify({
				goal,
				promptVersion: 1,
				rounds: 6,
				rejections: 3,
				completed: true,
				learned: [{ cls: "criteria", text: CRITERIA_STEP }],
			}),
		)
		.join("\n");
	writeFileSync(`${cwd}/.pi/loops/_optimizer/journal.jsonl`, `${journal}\n`);

	// 1. optimize (no apply) -> shows a candidate, writes nothing
	await cmd("optimize", ctx);
	const panel = lastOf("loop-optimize");
	show("optimizer panel (dry run)", JSON.stringify(panel?.details, null, 2));
	expect(panel?.details?.proposals).toHaveLength(1);
	expect((panel?.details?.proposals as Array<{ cls: string }>)[0].cls).toBe("criteria");
	expect(existsSyncSafe(`${cwd}/.pi/loops/_optimizer/baseline-steps.json`)).toBe(false);

	// 2. optimize apply -> promotes into base v2
	await cmd("optimize apply", ctx);
	expect(notes.some((n) => n.includes("promoted 1 step(s) into base prompt v2"))).toBe(true);
	const baseline = JSON.parse(readFileSync(`${cwd}/.pi/loops/_optimizer/baseline-steps.json`, "utf-8"));
	expect(baseline).toHaveLength(1);
	expect(baseline[0].version).toBe(2);
	expect(baseline[0].text).not.toContain("(learned:");

	// 3. a NEW loop now starts pre-loaded with the standing lesson from round 1
	await cmd("ship-thing rounds=4 orchestrate review=off criteria=off", ctx);
	await settled?.();
	await new Promise((r) => setTimeout(r, 25));
	const round1 = lastOf("loop-round");
	show("new loop round-1 prompt (pre-loaded)", round1?.content);
	expect(round1?.content).toContain("STANDING LESSONS (v2)");
	expect(round1?.content).toContain("PASTE its real output");
	// pre-loaded from round 1, before any failure in THIS run
	expect(round1?.content).not.toContain("LEARNED THIS RUN");
	registry.kill(registry.list().find((e) => e.label.includes("ship-thing"))?.id as string);
});

function existsSyncSafe(p: string): boolean {
	try {
		readFileSync(p);
		return true;
	} catch {
		return false;
	}
}
