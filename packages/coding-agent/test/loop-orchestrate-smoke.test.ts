import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Import the registry through the SAME specifier the extension uses, so both
// see one module instance (and one registry singleton).
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import loopExtension from "../../../extensions/loop.ts";

test("orchestrated loop v4: criteria data, review diversity, best-of-n, resume, status", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/loop-smoke-`);
	const sent: Array<{ customType: string; content: string; details?: Record<string, unknown> }> = [];
	let settledHandler: (() => Promise<void>) | undefined;
	let loopCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const renderers = new Map<string, (m: unknown, o: unknown, t: unknown) => unknown>();

	const pi = {
		registerTool() {},
		registerShortcut() {},
		registerMessageRenderer(customType: string, fn: (m: unknown, o: unknown, t: unknown) => unknown) {
			renderers.set(customType, fn);
		},
		registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			loopCommand = def.handler;
		},
		on(event: string, handler: () => Promise<void>) {
			if (event === "agent_settled") settledHandler = handler;
		},
		sendMessage(msg: { customType: string; content: string; details?: Record<string, unknown> }) {
			sent.push(msg);
		},
	};

	const notifications: string[] = [];
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "test-session" },
		ui: { notify: (t: string, l: string) => notifications.push(`[${l}] ${t}`) },
	};
	const registry = getBackgroundProcessRegistry();
	const loopEntry = (goal: string) => registry.list().find((e) => e.label === `↻ orchestrate ${goal}`);
	const lastSent = () => sent[sent.length - 1];
	const settle = async () => {
		await settledHandler?.();
		await new Promise((r) => setTimeout(r, 25));
	};

	loopExtension(pi as never);
	if (!loopCommand || !settledHandler) throw new Error("extension did not register");

	// ---- launch: criteria phase (round 0) dispatches first, review model recorded
	await loopCommand("ship-export rounds=6 rmodel=pi/smol", ctx);
	expect(notifications[notifications.length - 1]).toContain("review model: pi/smol");
	const dir = `${cwd}/.pi/loops/ship-export`;
	const progress = `${dir}/PROGRESS.md`;
	expect(lastSent().customType).toBe("loop-criteria");
	expect(lastSent().content).toContain("criteria.json");

	// no criteria written → one retry
	await settle();
	expect(lastSent().customType).toBe("loop-criteria");
	expect(lastSent().content).toContain("unusable");

	// write usable criteria → round 1 dispatched with the failing criteria listed.
	// verify commands are REAL: the loop executes them itself and sets passes
	// objectively, so a criterion "passes" by making its command exit 0.
	const criteria = [
		{ id: "c1", desc: "export endpoint returns CSV", verify: "false", passes: false },
		{ id: "c2", desc: "unit tests pass", verify: "false", passes: false },
	];
	writeFileSync(`${dir}/criteria.json`, JSON.stringify(criteria));
	await settle();
	expect(lastSent().customType).toBe("loop-round");
	expect(lastSent().content).toContain("Still failing: c1");
	// collaboration is prompt-based: personas + per-worker models, ONE coordinator
	expect(lastSent().content).toContain("ROLE persona");
	expect(lastSent().content).toContain("ONLY coordinator");
	expect(lastSent().content).toContain("chain tool");
	expect(lastSent().details?.criteria).toEqual({ passed: 0, total: 2 });

	// ---- round 1: done claim while verify commands fail → MECHANICAL rejection, no review spent
	appendFileSync(progress, "\nLOOP_VERDICT: done — shipped it\n");
	await settle();
	expect(lastSent().customType).toBe("loop-round"); // not loop-review
	expect(lastSent().content).toContain("I ran the criteria verify commands myself");
	expect(readFileSync(`${dir}/GUARDRAILS.md`, "utf-8")).toContain("verify commands still fail");

	// ---- round 2: c1's verify now exits 0, c2 still fails → second rejection
	criteria[0].verify = "true";
	writeFileSync(`${dir}/criteria.json`, JSON.stringify(criteria));
	appendFileSync(progress, "\nLOOP_VERDICT: done — c1 verified\n");
	await settle();
	// two consecutive rejections → BEST-OF-N round
	expect(lastSent().customType).toBe("loop-round");
	expect(lastSent().content).toContain("BEST-OF-N");
	expect(lastSent().details?.bestOfN).toBe(true);

	// ---- round 3 (best-of-n): all verify commands pass → review dispatched on the diverse model
	criteria[1].verify = "true";
	writeFileSync(`${dir}/criteria.json`, JSON.stringify(criteria));
	appendFileSync(progress, "\nLOOP_VERDICT: done — all criteria verified\n");
	await settle();
	expect(lastSent().customType).toBe("loop-review");
	expect(lastSent().content).toContain('model parameter set to "pi/smol"');
	expect(lastSent().content).toContain("adversarial");

	// review verdict is ADVISORY: objective criteria all pass, so even a failing
	// review completes the loop (its findings are logged, not blocking).
	appendFileSync(progress, "\nREVIEW_VERDICT: fail — evidence for c2 was asserted, not run\n");
	await settle();
	expect(loopEntry("ship-export")?.status).toBe("completed");
	expect(loopEntry("ship-export")?.summary).toContain("criteria 2/2 ✓");
	const state = JSON.parse(readFileSync(`${dir}/state.json`, "utf-8"));
	expect(state.status).toBe("completed");
	expect(state.rejections).toBeGreaterThanOrEqual(2);
	expect(state.verdicts.length).toBeGreaterThan(0);

	// ---- /loop status renders a rich panel from files alone
	await loopCommand("status ship-export", ctx);
	const status = lastSent();
	expect(status.customType).toBe("loop-status");
	expect((status.details?.criteria as unknown[]).length).toBe(2);
	const fakeTheme = { fg: (_c: string, t: string) => t };
	const panel = renderers.get("loop-status")?.(
		{ content: status.content, details: status.details },
		{ expanded: true },
		fakeTheme,
	);
	const panelText = JSON.stringify(panel ?? "");
	expect(panelText).toContain("acceptance criteria");
	expect(panelText).toContain("c1");

	// ---- criteria=off review=off loop goes straight to rounds; blocked parks; resume works
	await loopCommand("audit-perms rounds=3 review=off criteria=off", ctx);
	expect(lastSent().customType).toBe("loop-round");
	appendFileSync(`${cwd}/.pi/loops/audit-perms/PROGRESS.md`, "\nLOOP_VERDICT: blocked — need staging creds?\n");
	await settle();
	expect(loopEntry("audit-perms")?.status).toBe("parked");

	registry.kill(loopEntry("audit-perms")?.id as string); // simulate pi shutting down
	const stPath = `${cwd}/.pi/loops/audit-perms/state.json`;
	const parked = JSON.parse(readFileSync(stPath, "utf-8"));
	parked.status = "parked"; // kill persisted "cancelled"; restore as an interrupted run
	writeFileSync(stPath, JSON.stringify(parked));
	notifications.length = 0;
	await loopCommand("resume audit-perms", ctx);
	expect(notifications[0]).toContain("resumed at round 1/3");
	expect(lastSent().customType).toBe("loop-round"); // criteria stay off across resume
	registry.kill(loopEntry("audit-perms")?.id as string); // leave no live loop behind
});

test("simple launch: bare `/loop <goal>` uses repo defaults and auto-sizes the budget", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/loop-simple-`);
	mkdirSync(`${cwd}/.pi`, { recursive: true });
	// configure once in the repo...
	writeFileSync(`${cwd}/.pi/loop.json`, JSON.stringify({ gate: "smoke-tested", reviewModel: "pi/smol" }));

	const sent: Array<{ customType: string; content: string }> = [];
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
		sendMessage(m: { customType: string; content: string }) {
			sent.push(m);
		},
	};
	const notes: string[] = [];
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => "test-session" },
		ui: { notify: (t: string) => notes.push(t) },
	};
	const registry = getBackgroundProcessRegistry();
	loopExtension(pi as never);

	// ...then the whole launch is just the goal
	await cmd?.("ship-thing", ctx);
	expect(notes[notes.length - 1]).toContain("gate: smoke-tested"); // from .pi/loop.json
	expect(notes[notes.length - 1]).toContain("review model: pi/smol");
	expect(sent[sent.length - 1].customType).toBe("loop-criteria"); // orchestrate is the default

	// 3 criteria -> budget auto-sizes to 5 (criteria + 2)
	writeFileSync(
		`${cwd}/.pi/loops/ship-thing/criteria.json`,
		JSON.stringify([
			{ id: "c1", desc: "a", verify: "x", passes: false },
			{ id: "c2", desc: "b", verify: "y", passes: false },
			{ id: "c3", desc: "c", verify: "z", passes: false },
		]),
	);
	await settled?.();
	await new Promise((r) => setTimeout(r, 25));
	const entry = registry.list().find((e) => e.label === "↻ orchestrate ship-thing");
	expect(sent[sent.length - 1].content).toContain('budget="5"');
	const state = JSON.parse(readFileSync(`${cwd}/.pi/loops/ship-thing/state.json`, "utf-8"));
	expect(state.budget).toBe(5);
	registry.kill(entry?.id as string);
});
