import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const AGENT_DIR = mkdtempSync(`${tmpdir()}/dream-agent-`);
vi.mock("@earendil-works/pi-coding-agent", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, getAgentDir: () => AGENT_DIR };
});

const { default: dreamExt } = await import("../../../extensions/dream.ts");

function harness() {
	let cmd: ((a: string, c: unknown) => Promise<void>) | undefined;
	const sent: Array<{
		msg: { customType: string; content: string; details?: Record<string, unknown> };
		opts?: Record<string, unknown>;
	}> = [];
	const notes: string[] = [];
	const pi = {
		on() {},
		registerTool() {},
		registerMessageRenderer() {},
		registerCommand(_n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) {
			cmd = d.handler;
		},
		sendMessage(msg: never, opts?: Record<string, unknown>) {
			sent.push({ msg, opts });
		},
	};
	dreamExt(pi as never);
	return { cmd, sent, notes, ctx: { cwd: "/repo", ui: { notify: (t: string) => notes.push(t) } } };
}

test("dream: dispatches the 4-phase consolidation brief, throttles, force overrides", async () => {
	const h = harness();
	// status before any run
	await h.cmd?.("status", h.ctx);
	expect(h.notes[0]).toContain("no dream has run yet");

	// first run dispatches a turn-triggering dream message with the governed brief
	await h.cmd?.("", h.ctx);
	expect(h.sent.length).toBe(1);
	const msg = h.sent[0];
	expect(msg.msg.customType).toBe("dream");
	expect(msg.opts?.triggerTurn).toBe(true);
	for (const phase of ["ORIENT", "GATHER", "CONSOLIDATE", "PRUNE"]) {
		expect(msg.msg.content).toContain(phase);
	}
	// governance: propose-first, never auto-apply destructive changes
	expect(msg.msg.content).toContain("WITHOUT autoconfirm");
	expect(msg.msg.content).toContain("NEVER delete or auto-confirm");
	expect(msg.msg.content).toContain("DREAM_SUMMARY:");
	// state recorded
	expect(JSON.parse(readFileSync(join(AGENT_DIR, "self", "dream-state.json"), "utf-8")).lastRun).toBeGreaterThan(0);

	// second run is throttled...
	await h.cmd?.("", h.ctx);
	expect(h.sent.length).toBe(1);
	expect(h.notes.some((n) => n.includes("throttled"))).toBe(true);
	// ...unless forced
	await h.cmd?.("force", h.ctx);
	expect(h.sent.length).toBe(2);
	expect(h.sent[1].msg.details?.forced).toBe(true);

	// status reports recency
	await h.cmd?.("status", h.ctx);
	expect(h.notes[h.notes.length - 1]).toContain("last dream: 0h ago");
});
