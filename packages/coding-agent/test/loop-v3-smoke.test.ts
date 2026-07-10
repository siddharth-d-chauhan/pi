import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Import the registry through the SAME specifier the extension uses, so both
// see one module instance (and one registry singleton).
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import loopExtension from "../../../extensions/loop.ts";

test("orchestrated loop v3: review-gated done, guardrails, resume", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/loop-smoke-`);
	const sent: Array<{ customType: string; content: string }> = [];
	let settledHandler: (() => Promise<void>) | undefined;
	let loopCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;

	const pi = {
		registerTool() {},
		registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			loopCommand = def.handler;
		},
		on(event: string, handler: () => Promise<void>) {
			if (event === "agent_settled") settledHandler = handler;
		},
		sendMessage(msg: { customType: string; content: string }) {
			sent.push(msg);
		},
	};

	const notifications: string[] = [];
	const ctx = { cwd, ui: { notify: (t: string, l: string) => notifications.push(`[${l}] ${t}`) } };
	const registry = getBackgroundProcessRegistry();
	// registry.list() orders newest-first; match the loop by goal name instead.
	const loopEntry = (goal: string) => registry.list().find((e) => e.label === `↻ orchestrate ${goal}`);
	const settle = async () => {
		await settledHandler?.();
		await new Promise((r) => setTimeout(r, 25));
	};

	loopExtension(pi as never);
	if (!loopCommand || !settledHandler) throw new Error("extension did not register");

	// launch — review defaults ON
	await loopCommand("ship-export rounds=4 orchestrate", ctx);
	const progress = `${cwd}/.pi/loops/ship-export/PROGRESS.md`;
	const guardrails = `${cwd}/.pi/loops/ship-export/GUARDRAILS.md`;
	expect(sent[0].customType).toBe("loop-round");
	expect(sent[0].content).toContain("GUARDRAILS.md");
	expect(sent[0].content).toContain("INDEPENDENT");

	// round 1 claims done → a review must be dispatched, not completion
	appendFileSync(progress, "\nLOOP_VERDICT: done — export module shipped\n");
	await settle();
	expect(sent[sent.length - 1].customType).toBe("loop-review");
	expect(loopEntry("ship-export")?.status).toBe("running");

	// review FAILS → guardrail + evidence in next round
	appendFileSync(progress, "\nREVIEW_VERDICT: fail — CSV escaping unhandled\n");
	await settle();
	const round2 = sent[sent.length - 1];
	expect(round2.customType).toBe("loop-round");
	expect(round2.content).toContain("FAILED independent review");
	expect(readFileSync(guardrails, "utf-8")).toContain("review rejected");

	// round 2 done → review PASS → completed (no devbrain gate configured)
	appendFileSync(progress, "\nLOOP_VERDICT: done — escaping fixed, verified\n");
	await settle();
	expect(sent[sent.length - 1].customType).toBe("loop-review");
	appendFileSync(progress, "\nREVIEW_VERDICT: pass — goal verified against diff\n");
	await settle();
	expect(loopEntry("ship-export")?.status).toBe("completed");
	expect(loopEntry("ship-export")?.summary).toContain("review ✓");
	const done = JSON.parse(readFileSync(`${cwd}/.pi/loops/ship-export/state.json`, "utf-8"));
	expect(done.status).toBe("completed");

	// resume refuses completed loops
	notifications.length = 0;
	await loopCommand("resume", ctx);
	expect(notifications[0]).toContain("nothing to resume");

	// review=off loop parks on blocked; state survives a "restart"; resume re-attaches
	await loopCommand("audit-perms rounds=3 orchestrate review=off", ctx);
	expect(notifications[notifications.length - 1]).toContain("review: OFF");
	appendFileSync(`${cwd}/.pi/loops/audit-perms/PROGRESS.md`, "\nLOOP_VERDICT: blocked — need staging creds?\n");
	await settle();
	expect(loopEntry("audit-perms")?.status).toBe("parked");
	const stPath = `${cwd}/.pi/loops/audit-perms/state.json`;
	expect(JSON.parse(readFileSync(stPath, "utf-8")).status).toBe("parked");

	registry.kill(loopEntry("audit-perms")?.id as string); // simulate pi shutting down
	const parked = JSON.parse(readFileSync(stPath, "utf-8"));
	parked.status = "parked"; // kill persisted "cancelled"; restore as an interrupted run
	writeFileSync(stPath, JSON.stringify(parked));
	notifications.length = 0;
	await loopCommand("resume audit-perms", ctx);
	expect(notifications[0]).toContain("resumed at round 1/3");
	expect(sent[sent.length - 1].customType).toBe("loop-round");
	registry.kill(loopEntry("audit-perms")?.id as string); // leave no live loop behind for other tests
});
