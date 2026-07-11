import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const AGENT_DIR = mkdtempSync(`${tmpdir()}/memsys-agent-`);
vi.mock("@earendil-works/pi-coding-agent", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, getAgentDir: () => AGENT_DIR };
});

const { default: intentsExt } = await import("../../../extensions/intents.ts");
const { default: recallExt } = await import("../../../extensions/recall.ts");
const { default: episodesExt } = await import("../../../extensions/episodes.ts");
const { markDelivered, isDelivered, resetDelivered } = await import("../../../extensions/lib/kp-bridge.ts");

const g = globalThis as Record<string, unknown>;

function harness(ext: (pi: never) => void) {
	const handlers = new Map<string, (e: unknown) => Promise<unknown>>();
	let cmd: ((a: string, c: unknown) => Promise<void>) | undefined;
	let tool:
		| { execute: (id: string, input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
		| undefined;
	const sent: Array<{
		msg: { customType: string; content: string; details?: Record<string, unknown> };
		opts?: Record<string, unknown>;
	}> = [];
	const notes: string[] = [];
	const pi = {
		on(e: string, h: (x: unknown) => Promise<unknown>) {
			handlers.set(e, h);
		},
		registerCommand(_n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) {
			cmd = d.handler;
		},
		registerTool(t: never) {
			tool = t;
		},
		registerMessageRenderer() {},
		sendMessage(msg: never, opts?: Record<string, unknown>) {
			sent.push({ msg, opts });
		},
	};
	ext(pi as never);
	return {
		handlers,
		cmd,
		tool,
		sent,
		notes,
		ctx: (cwd: string) => ({ cwd, ui: { notify: (t: string) => notes.push(t) } }),
	};
}

test("intents: record -> fires ONCE on path touch -> archived; prompt trigger too", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/memsys-repo-`);
	const h = harness(intentsExt);
	const ctx = h.ctx(cwd);

	await h.cmd?.("licensing :: migrate LicenseGuard before touching entitlements", ctx);
	expect(readFileSync(join(cwd, ".pi", "intents.json"), "utf-8")).toContain("LicenseGuard");

	// unrelated tool touch -> silent
	const origCwd = process.cwd();
	process.chdir(cwd);
	try {
		await h.handlers.get("tool_execution_start")?.({
			toolName: "edit",
			args: { file_path: `${cwd}/src/billing/x.ts` },
		});
		expect(h.sent.length).toBe(0);
		// licensing file touch -> steered reminder, one-shot
		await h.handlers.get("tool_execution_start")?.({
			toolName: "edit",
			args: { file_path: `${cwd}/src/licensing/guard.ts` },
		});
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].msg.customType).toBe("intent-reminder");
		expect(h.sent[0].msg.content).toContain("LicenseGuard");
		expect(h.sent[0].opts?.deliverAs).toBe("steer");
		// second touch does NOT re-fire
		await h.handlers.get("tool_execution_start")?.({
			toolName: "edit",
			args: { file_path: `${cwd}/src/licensing/api.ts` },
		});
		expect(h.sent.length).toBe(1);
	} finally {
		process.chdir(origCwd);
	}
	// archived on disk
	const stored = JSON.parse(readFileSync(join(cwd, ".pi", "intents.json"), "utf-8"));
	expect(stored[0].firedAt).toBeTruthy();
	// __pi_intents__ exposes only pending
	const pending = (g.__pi_intents__ as (c: string) => unknown[])(cwd);
	expect(pending.length).toBe(0);
});

test("recall: merges KP + preferences + loop lessons + intents; registers delivered facts", async () => {
	resetDelivered();
	const cwd = mkdtempSync(`${tmpdir()}/memsys-recall-`);
	// local stores
	mkdirSync(join(AGENT_DIR, "self"), { recursive: true });
	writeFileSync(
		join(AGENT_DIR, "self", "standing-instructions.json"),
		JSON.stringify([{ text: "use bitbucket not github for merges", sessions: 2, version: 2 }]),
	);
	mkdirSync(join(cwd, ".pi", "loops", "_optimizer"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "loops", "_optimizer", "baseline-steps.json"),
		JSON.stringify([
			{ cls: "criteria", text: "verify criteria via bitbucket pipeline before done", runs: 3, version: 2 },
		]),
	);
	mkdirSync(join(cwd, ".pi", "loops", "fix-x"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "loops", "fix-x", "GUARDRAILS.md"), "# g\n- bitbucket webhook needs manual retry\n");
	// intents seam (registered by intents extension normally)
	g.__pi_intents__ = () => [{ trigger: "bitbucket", remind: "rotate the app password" }];
	// KP stub
	g.__pi_kp__ = {
		timeoutMs: 4000,
		connect: async () => ({
			callTool: async () => ({
				isError: false,
				content: [
					{
						type: "text",
						text: JSON.stringify({
							hits: [
								{
									fact_id: "f-123",
									kind: "Preference",
									text: "Merges happen on bitbucket, never github",
									score: 0.9,
								},
							],
						}),
					},
				],
			}),
		}),
	};

	const h = harness(recallExt);
	const origCwd = process.cwd();
	process.chdir(cwd);
	let text = "";
	try {
		const result = await h.tool?.execute("t1", { query: "bitbucket merge rules" });
		text = result?.content[0].text ?? "";
	} finally {
		process.chdir(origCwd);
	}
	expect(text).toContain("[kp:Preference]");
	expect(text).toContain("[pref:Preference] use bitbucket not github");
	expect(text).toContain("[loop:StandingLesson]");
	expect(text).toContain("[loop:Guardrail(fix-x)]");
	expect(text).toContain("[intent:Intent]");
	// the KP fact is now registered as delivered (other channels will skip it)
	expect(isDelivered("f-123")).toBe(true);

	// command path emits the rich panel message
	await h.cmd?.("bitbucket merge rules", h.ctx(cwd));
	const panel = h.sent.find((s) => s.msg.customType === "recall-results");
	expect(panel?.msg.details?.kpUp).toBe(true);
	expect((panel?.msg.details?.hits as unknown[]).length).toBeGreaterThanOrEqual(4);
	delete g.__pi_kp__;
	delete g.__pi_intents__;
});

test("episodes: digest -> shutdown writes one episode to KP; trivial sessions skipped", async () => {
	const calls: Array<Record<string, unknown>> = [];
	g.__pi_kp__ = {
		timeoutMs: 4000,
		connect: async () => ({
			callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
				calls.push({ name: req.name, ...req.arguments });
				return {
					isError: false,
					content: [{ type: "text", text: JSON.stringify({ decision: "supported", queued: true }) }],
				};
			},
		}),
	};
	// trivial session -> no episode
	const trivial = harness(episodesExt);
	await trivial.handlers.get("session_shutdown")?.({});
	expect(calls.length).toBe(0);
	// real session -> one episode with digest content
	const h = harness(episodesExt);
	await h.handlers.get("before_agent_start")?.({ prompt: "fix the CSV export bug" });
	await h.handlers.get("before_agent_start")?.({ prompt: "now add tests for it" });
	await h.handlers.get("before_agent_start")?.({ prompt: "commit and push" });
	await h.handlers.get("tool_execution_start")?.({ toolName: "edit", args: { file_path: "src/export/csv.ts" } });
	await h.handlers.get("session_shutdown")?.({});
	expect(calls.length).toBe(1);
	expect(calls[0].name).toBe("pi.memory_writeback");
	expect(calls[0].kind).toBe("episode");
	expect(String(calls[0].summary)).toContain("fix the CSV export bug");
	expect(String(calls[0].text)).toContain("src/export/csv.ts");
	// double shutdown does not double-write
	await h.handlers.get("session_shutdown")?.({});
	expect(calls.length).toBe(1);
	delete g.__pi_kp__;
});

test("delivered-facts registry basics", () => {
	resetDelivered();
	expect(isDelivered("x")).toBe(false);
	markDelivered(["x", undefined, "y"]);
	expect(isDelivered("x")).toBe(true);
	expect(isDelivered("y")).toBe(true);
	resetDelivered();
	expect(isDelivered("x")).toBe(false);
});
