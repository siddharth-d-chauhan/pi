import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
	const ctx = { cwd, ui: { notify: (t: string, l: string) => notifications.push(`[${l}] ${t}`) } };
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
	await loopCommand("ship-export rounds=6 orchestrate rmodel=pi/smol", ctx);
	expect(notifications[notifications.length - 1]).toContain("review model: pi/smol");
	const dir = `${cwd}/.pi/loops/ship-export`;
	const progress = `${dir}/PROGRESS.md`;
	expect(lastSent().customType).toBe("loop-criteria");
	expect(lastSent().content).toContain("criteria.json");

	// no criteria written → one retry
	await settle();
	expect(lastSent().customType).toBe("loop-criteria");
	expect(lastSent().content).toContain("unusable");

	// write usable criteria → round 1 dispatched with remaining criteria listed
	const criteria = [
		{ id: "c1", desc: "export endpoint returns CSV", verify: "curl /export", passes: false },
		{ id: "c2", desc: "unit tests pass", verify: "npm test", passes: false },
	];
	writeFileSync(`${dir}/criteria.json`, JSON.stringify(criteria));
	await settle();
	expect(lastSent().customType).toBe("loop-round");
	expect(lastSent().content).toContain("Remaining: c1");
	expect(lastSent().details?.criteria).toEqual({ passed: 0, total: 2 });

	// ---- round 1: done claim with unmet criteria → MECHANICAL rejection, no review spent
	appendFileSync(progress, "\nLOOP_VERDICT: done — shipped it\n");
	await settle();
	expect(lastSent().customType).toBe("loop-round"); // not loop-review
	expect(lastSent().content).toContain("rejected WITHOUT review");
	expect(readFileSync(`${dir}/GUARDRAILS.md`, "utf-8")).toContain("unmet criteria");

	// ---- round 2: still one criterion unmet → second rejection
	criteria[0].passes = true;
	writeFileSync(`${dir}/criteria.json`, JSON.stringify(criteria));
	appendFileSync(progress, "\nLOOP_VERDICT: done — c1 verified\n");
	await settle();
	// two consecutive rejections → BEST-OF-N round
	expect(lastSent().customType).toBe("loop-round");
	expect(lastSent().content).toContain("BEST-OF-N");
	expect(lastSent().details?.bestOfN).toBe(true);

	// ---- round 3 (best-of-n): all criteria met → review dispatched on the diverse model
	criteria[1].passes = true;
	writeFileSync(`${dir}/criteria.json`, JSON.stringify(criteria));
	appendFileSync(progress, "\nLOOP_VERDICT: done — all criteria verified\n");
	await settle();
	expect(lastSent().customType).toBe("loop-review");
	expect(lastSent().content).toContain('model parameter set to "pi/smol"');
	expect(lastSent().content).toContain("SPOT-CHECK");

	// review fails → guardrail + another round
	appendFileSync(progress, "\nREVIEW_VERDICT: fail — evidence for c2 was asserted, not run\n");
	await settle();
	expect(lastSent().customType).toBe("loop-round");
	expect(readFileSync(`${dir}/GUARDRAILS.md`, "utf-8")).toContain("review rejected");

	// ---- round 4: done again → review → pass → completed with criteria in summary
	appendFileSync(progress, "\nLOOP_VERDICT: done — reran c2 with real evidence\n");
	await settle();
	expect(lastSent().customType).toBe("loop-review");
	appendFileSync(progress, "\nREVIEW_VERDICT: pass — verified against diff and criteria\n");
	await settle();
	expect(loopEntry("ship-export")?.status).toBe("completed");
	expect(loopEntry("ship-export")?.summary).toContain("criteria 2/2 ✓");
	const state = JSON.parse(readFileSync(`${dir}/state.json`, "utf-8"));
	expect(state.status).toBe("completed");
	expect(state.rejections).toBeGreaterThanOrEqual(3);
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
	await loopCommand("audit-perms rounds=3 orchestrate review=off criteria=off", ctx);
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
