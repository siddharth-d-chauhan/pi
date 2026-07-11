import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const DEMO = process.env.DEMO === "1";
const show = (label: string, obj: unknown) => {
	if (!DEMO) return;
	process.stderr.write(`\n${"═".repeat(72)}\n${label}\n${"─".repeat(72)}\n${obj}\n`);
};

// Point getAgentDir at a temp dir so the journal/standing files are isolated.
const AGENT_DIR = mkdtempSync(`${tmpdir()}/self-opt-`);
vi.mock("@earendil-works/pi-coding-agent", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, getAgentDir: () => AGENT_DIR };
});

const { default: selfOptimize } = await import("../../../extensions/self-optimize.ts");

function harness() {
	const handlers = new Map<string, (e: unknown) => Promise<unknown>>();
	let cmd: ((a: string, c: unknown) => Promise<void>) | undefined;
	const sent: Array<{ customType: string; details?: Record<string, unknown> }> = [];
	const notes: string[] = [];
	const pi = {
		on(e: string, h: (x: unknown) => Promise<unknown>) {
			handlers.set(e, h);
		},
		registerCommand(_n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) {
			cmd = d.handler;
		},
		registerMessageRenderer() {},
		sendMessage(m: { customType: string; details?: Record<string, unknown> }) {
			sent.push(m);
		},
	};
	selfOptimize(pi as never);
	const ctx = { cwd: "/repo", ui: { notify: (t: string) => notes.push(t) } };
	return { handlers, cmd: cmd as (a: string, c: unknown) => Promise<void>, sent, notes, ctx };
}

test("correction detection journals candidates; non-corrections are ignored", async () => {
	const h = harness();
	const fire = (prompt: string) => h.handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt });
	await fire("add a login endpoint"); // a task, not a correction
	await fire("no, don't auto-merge on github — we use bitbucket"); // correction
	await fire("why did you use spaces? this repo is tabs"); // correction
	const journal = readFileSync(join(AGENT_DIR, "self", "corrections.jsonl"), "utf-8")
		.trim()
		.split("\n");
	show("journal after 3 messages (1 task ignored)", journal.join("\n"));
	expect(journal.length).toBe(2);
	expect(journal.every((l) => JSON.parse(l).source === "heuristic")).toBe(true);
});

test("distinct-session recurrence -> candidate -> apply -> injected as standing block", async () => {
	// clean slate
	writeFileSync(join(AGENT_DIR, "self", "corrections.jsonl"), "");
	writeFileSync(join(AGENT_DIR, "self", "standing-instructions.json"), "[]");

	// session 1 corrects the merge target
	const s1 = harness();
	await s1.handlers.get("before_agent_start")?.({
		type: "before_agent_start",
		prompt: "no, don't auto-merge on github, we use bitbucket",
	});
	// a brand-new harness = a new session id -> the SAME lesson recurs cross-session
	const s2 = harness();
	await s2.handlers.get("before_agent_start")?.({
		type: "before_agent_start",
		prompt: "stop trying to merge on github, it is bitbucket here",
	});

	// dry run shows the candidate, writes no standing file
	await s2.cmd("optimize", s2.ctx);
	const panel = s2.sent.find((m) => m.customType === "self-optimize");
	show("self-optimize candidates", JSON.stringify(panel?.details, null, 2));
	expect((panel?.details?.proposals as unknown[]).length).toBe(1);
	expect(JSON.parse(readFileSync(join(AGENT_DIR, "self", "standing-instructions.json"), "utf-8"))).toHaveLength(0);

	// apply promotes it
	await s2.cmd("optimize apply", s2.ctx);
	expect(s2.notes.some((n) => n.includes("promoted 1 standing preference"))).toBe(true);
	const standing = JSON.parse(readFileSync(join(AGENT_DIR, "self", "standing-instructions.json"), "utf-8"));
	expect(standing).toHaveLength(1);
	expect(standing[0].text.toLowerCase()).toContain("bitbucket");
	expect(standing[0].version).toBe(2);

	// a NEW session now injects the learned preference into context automatically
	const s3 = harness();
	const result = (await s3.handlers.get("context")?.({
		type: "context",
		messages: [{ role: "user", content: [{ type: "text", text: "help me merge" }] }],
	})) as { messages?: Array<{ content: Array<{ text: string }> }> } | undefined;
	const injected = result?.messages?.at(-1)?.content?.[0]?.text ?? "";
	show("injected context block (new session)", injected);
	expect(injected).toContain("<learned-preferences>");
	expect(injected.toLowerCase()).toContain("bitbucket");

	// /self forget drops it
	await s3.cmd("forget 1", s3.ctx);
	expect(JSON.parse(readFileSync(join(AGENT_DIR, "self", "standing-instructions.json"), "utf-8"))).toHaveLength(0);
});

test("/self note records an explicit lesson that promotes from one session", async () => {
	writeFileSync(join(AGENT_DIR, "self", "corrections.jsonl"), "");
	writeFileSync(join(AGENT_DIR, "self", "standing-instructions.json"), "[]");
	const h = harness();
	await h.cmd("note always run the narrowest test before committing", h.ctx);
	await h.cmd("optimize apply", h.ctx);
	const standing = JSON.parse(readFileSync(join(AGENT_DIR, "self", "standing-instructions.json"), "utf-8"));
	expect(standing).toHaveLength(1);
	expect(standing[0].text).toContain("narrowest test");
});
