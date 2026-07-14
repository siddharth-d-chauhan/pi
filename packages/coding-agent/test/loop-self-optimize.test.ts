import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Same specifier as the extension -> one registry singleton.
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import loopExtension from "../../../extensions/loop.ts";

// SEE IT WORKING: set DEMO=1 to print the round-prompt evolution.
const DEMO = process.env.DEMO === "1";
const show = (label: string, text: string) => {
	if (!DEMO) return;
	process.stderr.write(`\n${"═".repeat(72)}\n${label}\n${"─".repeat(72)}\n${text}\n`);
};

test("online GEPA-lite: the loop rewrites its own round prompt after a failure recurs", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/loop-gepa-`);
	const sent: Array<{ customType: string; content: string; details?: Record<string, unknown> }> = [];
	let settled: (() => Promise<void>) | undefined;
	let cmd: ((a: string, c: unknown) => Promise<void>) | undefined;

	const pi = {
		registerTool() {},
		registerShortcut() {},
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
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "test-session" },
		ui: { notify: (t: string, l: string) => notes.push(`[${l}] ${t}`) },
	};
	const registry = getBackgroundProcessRegistry();
	const entry = () => registry.list().find((e) => e.label === "↻ orchestrate fix-export");
	const lastRound = () => [...sent].reverse().find((m) => m.customType === "loop-round");
	const settleOnce = async () => {
		await settled?.();
		await new Promise((r) => setTimeout(r, 25));
	};

	loopExtension(pi as never);
	if (!cmd || !settled) throw new Error("extension did not register");

	// launch (no gate/review — isolate the criteria failure class)
	await cmd("fix-export rounds=8 review=off", ctx);
	const dir = `${cwd}/.pi/loops/fix-export`;
	const progress = `${dir}/PROGRESS.md`;
	// criteria round 0
	writeFileSync(
		`${dir}/criteria.json`,
		JSON.stringify([{ id: "c1", desc: "export returns valid CSV", verify: "pytest test_export.py", passes: false }]),
	);
	await settleOnce(); // -> round 1 prompt
	const before = lastRound()?.content ?? "";
	show("ROUND 1 prompt — before any learning", before);
	expect(before).not.toContain("LEARNED THIS RUN");

	// round 1: model claims done but leaves c1 unmet -> criteria rejection #1
	appendFileSync(progress, "\nLOOP_VERDICT: done — exported it\n");
	await settleOnce();
	expect(entry()?.status).toBe("running");
	const afterOne = lastRound()?.content ?? "";
	// one failure is not yet a pattern -> no rewrite
	expect(afterOne).not.toContain("LEARNED THIS RUN");

	// round 2: SAME failure class again -> threshold hit -> self-rewrite
	appendFileSync(progress, "\nLOOP_VERDICT: done — surely done now\n");
	await settleOnce();
	const afterTwo = lastRound()?.content ?? "";
	show("ROUND 3 prompt — after the loop rewrote itself", afterTwo);

	// the prompt now carries a learned, un-skippable step it wrote for itself
	expect(afterTwo).toContain("LEARNED THIS RUN");
	expect(afterTwo).toContain("makes the failing verify commands exit 0");
	expect(afterTwo).toContain("(learned:");
	// and it is placed FIRST, before the passive "go read the guardrails file"
	expect(afterTwo.indexOf("LEARNED THIS RUN")).toBeLessThan(afterTwo.indexOf("Guardrails file"));

	// it was announced and persisted for resume
	expect(notes.some((n) => n.includes("rewrote its round prompt"))).toBe(true);
	const state = JSON.parse(readFileSync(`${dir}/state.json`, "utf-8"));
	expect(state.learnedSteps.length).toBe(1);
	expect(state.failureCounts.criteria.count).toBeGreaterThanOrEqual(2);
	expect(readFileSync(`${dir}/GUARDRAILS.md`, "utf-8")).toContain("LEARNED STEP (criteria×2)");

	// a THIRD repeat does not duplicate the same learned step
	appendFileSync(progress, "\nLOOP_VERDICT: done — third time\n");
	await settleOnce();
	const state3 = JSON.parse(readFileSync(`${dir}/state.json`, "utf-8"));
	expect(state3.learnedSteps.length).toBe(1);

	// learned steps survive a restart (resume rehydrates them into the prompt)
	registry.kill(entry()?.id as string);
	const stPath = `${dir}/state.json`;
	const saved = JSON.parse(readFileSync(stPath, "utf-8"));
	saved.status = "parked";
	writeFileSync(stPath, JSON.stringify(saved));
	sent.length = 0;
	await cmd("resume fix-export", ctx);
	const resumedRound = lastRound()?.content ?? "";
	show("RESUMED round prompt — learned step rehydrated from state.json", resumedRound);
	expect(resumedRound).toContain("LEARNED THIS RUN");
	registry.kill(entry()?.id as string);
});
