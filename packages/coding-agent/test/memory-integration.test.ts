/**
 * ALL-TOGETHER integration: one shared fake KP + the real extensions, driven
 * through a realistic multi-session story. Verifies the details actually reach
 * the LLM at the right moment and never twice:
 *
 *  session 1  boot delivers a fact -> area drift skips it (dedup) but adds new
 *             ones; correction journaled
 *  session 2  same correction rephrased -> /self optimize apply -> KP writeback;
 *             preference STILL injected locally this session (boot predated it)
 *  session 3  local block silent (KP owns it now); /new resets the delivered
 *             registry; intent fires once on file touch; recall sees everything
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const AGENT_DIR = mkdtempSync(`${tmpdir()}/memint-agent-`);
vi.mock("@earendil-works/pi-coding-agent", async (orig) => {
	const actual = (await orig()) as Record<string, unknown>;
	return { ...actual, getAgentDir: () => AGENT_DIR };
});

const { default: selfOptimize } = await import("../../../extensions/self-optimize.ts");
const { default: areaContext } = await import("../../../extensions/area-context.ts");
const { default: intentsExt } = await import("../../../extensions/intents.ts");
const { default: recallExt } = await import("../../../extensions/recall.ts");
const { markDelivered, isDelivered } = await import("../../../extensions/lib/kp-bridge.ts");

const g = globalThis as Record<string, unknown>;

// ---- one fake KP behind the shared seam, serving every tool the system uses
const kpFacts: Array<{ fact_id: string; kind: string; text: string }> = [];
const kpLog: string[] = [];
function installKp() {
	g.__pi_kp__ = {
		timeoutMs: 4000,
		connect: async () => ({
			callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
				kpLog.push(req.name);
				const ok = (obj: unknown) => ({
					isError: false,
					content: [{ type: "text", text: JSON.stringify(obj) }],
				});
				if (req.name === "pi.embed_texts") {
					// deterministic fake embedder: same first-two-chars bucket -> same direction
					const texts = req.arguments.texts as string[];
					return ok({
						vectors: texts.map((t) => {
							const bucket = t.toLowerCase().includes("bitbucket") ? [1, 0, 0] : [0, 0, 1];
							return bucket;
						}),
						dim: 3,
					});
				}
				if (req.name === "pi.memory_writeback") {
					const id = `f-wb-${kpFacts.length}`;
					kpFacts.push({ fact_id: id, kind: "Preference", text: String(req.arguments.summary) });
					return ok({ decision: "confirmed", queued: true });
				}
				if (req.name === "pi.context_area") {
					return ok({
						candidates: [
							{ memory: { fact_id: "f-boot-1", kind: "Pitfall", text: "already delivered by boot" } },
							{ memory: { fact_id: "f-area-1", kind: "Knowledge", text: "area-only broker fact" } },
						],
						freshness: { area: String(req.arguments.area) },
					});
				}
				if (req.name === "knowledge.search") {
					return ok({ hits: kpFacts.map((f) => ({ ...f, score: 0.9 })) });
				}
				return ok({});
			},
		}),
	};
}

interface Harness {
	handlers: Map<string, (e: unknown) => Promise<unknown>>;
	cmds: Map<string, (a: string, c: unknown) => Promise<void>>;
	tools: Map<
		string,
		{ execute: (id: string, i: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }
	>;
	sent: Array<{ msg: { customType: string; content: string }; opts?: Record<string, unknown> }>;
	notes: string[];
	ctx: { cwd: string; ui: { notify: (t: string) => void } };
	turnContext: () => Promise<string>;
	/** fire EVERY registered handler for an event (all four extensions). */
	fireAll: (event: string, payload: unknown) => Promise<void>;
}

/** A "session": all four extensions loaded into one stub pi. */
function session(cwd: string): Harness {
	const handlers = new Map<string, Array<(e: unknown) => Promise<unknown>>>();
	const cmds = new Map<string, (a: string, c: unknown) => Promise<void>>();
	const tools = new Map<string, never>();
	const sent: Harness["sent"] = [];
	const notes: string[] = [];
	const pi = {
		on(e: string, h: (x: unknown) => Promise<unknown>) {
			handlers.set(e, [...(handlers.get(e) ?? []), h]);
		},
		registerCommand(n: string, d: { handler: (a: string, c: unknown) => Promise<void> }) {
			cmds.set(n, d.handler);
		},
		registerTool(t: { name: string }) {
			tools.set(t.name, t as never);
		},
		registerMessageRenderer() {},
		sendMessage(msg: never, opts?: Record<string, unknown>) {
			sent.push({ msg, opts });
		},
	};
	for (const ext of [selfOptimize, areaContext, intentsExt, recallExt]) ext(pi as never);
	const fireAll = async (event: string, payload: unknown) => {
		for (const h of handlers.get(event) ?? []) await h(payload);
	};
	return {
		handlers: new Map([...handlers.entries()].map(([k, v]) => [k, v[0]])),
		cmds,
		tools: tools as unknown as Harness["tools"],
		sent,
		notes,
		ctx: { cwd, ui: { notify: (t: string) => notes.push(t) } },
		// what the LLM would see appended this turn (context-event blocks)
		turnContext: async () => {
			let out: Array<{ content: Array<{ text: string }> }> = [];
			for (const h of handlers.get("context") ?? []) {
				const r = (await h({ type: "context", messages: out })) as { messages?: typeof out } | undefined;
				if (r?.messages) out = r.messages;
			}
			return out.map((m) => m.content?.[0]?.text ?? "").join("\n---\n");
		},
		fireAll,
	};
}

test("the whole memory system works together across sessions", async () => {
	installKp();
	const cwd = mkdtempSync(`${tmpdir()}/memint-repo-`);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "context-areas.json"), JSON.stringify({ areas: { broker: ["src/broker/"] } }));
	const origCwd = process.cwd();
	process.chdir(cwd);
	try {
		// ================= SESSION 1 =================
		const s1 = session(cwd);
		await s1.fireAll("session_start", {}); // resets delivered registry
		// boot channel delivers f-boot-1 (simulating context-broker's parsePacket registration)
		markDelivered(["f-boot-1"]);
		// area drift: packet has f-boot-1 (already delivered) + f-area-1 (new)
		await s1.fireAll("tool_execution_start", { toolName: "edit", args: { file_path: `${cwd}/src/broker/x.ts` } });
		await new Promise((r) => setTimeout(r, 30));
		const areaMsg = s1.sent.find((m) => m.msg.customType === "area-context");
		expect(areaMsg?.msg.content).toContain("area-only broker fact");
		expect(areaMsg?.msg.content).not.toContain("already delivered by boot"); // cross-channel dedup
		expect(isDelivered("f-area-1")).toBe(true); // area registered its own delivery
		// a correction lands in the journal
		await s1.fireAll("before_agent_start", { prompt: "no, don't auto-merge on github, we use bitbucket" });

		// ================= SESSION 2 =================
		const s2 = session(cwd);
		await s2.fireAll("session_start", {});
		expect(isDelivered("f-area-1")).toBe(false); // /new reset the registry
		await s2.fireAll("before_agent_start", { prompt: "stop trying to merge on github, it's bitbucket" });
		// promote: semantic clustering (fake embedder), writeback to KP
		await s2.cmds.get("self")?.("optimize apply", s2.ctx);
		expect(s2.notes.some((n) => n.includes("1 into the knowledge platform"))).toBe(true);
		expect(kpFacts.some((f) => f.text.includes("bitbucket"))).toBe(true);
		// CRITICAL: this session's boot predated the promotion -> the local block
		// must STILL carry the preference for the rest of this session.
		const ctxS2 = await s2.turnContext();
		expect(ctxS2).toContain("<learned-preferences>");
		expect(ctxS2.toLowerCase()).toContain("bitbucket");

		// ================= SESSION 3 =================
		const s3 = session(cwd);
		await s3.fireAll("session_start", {});
		// KP owns the preference now; a fresh session's boot serves it -> local silent
		const ctxS3 = await s3.turnContext();
		expect(ctxS3).not.toContain("<learned-preferences>");
		// prospective memory: record an intent...
		await s3.cmds.get("intend")?.("licensing :: migrate LicenseGuard first", s3.ctx);
		// ...unified recall sees it WHILE PENDING, alongside the KP preference
		const recallOut = await s3.tools.get("recall")?.execute("t", { query: "bitbucket merge licensing" });
		const recallText = recallOut?.content[0].text ?? "";
		expect(recallText).toContain("[kp:Preference]");
		expect(recallText).toContain("[intent:Intent]");
		// then the intent fires once when the trigger is actually touched...
		await s3.fireAll("tool_execution_start", { toolName: "edit", args: { file_path: `${cwd}/src/licensing/g.ts` } });
		const reminder = s3.sent.find((m) => m.msg.customType === "intent-reminder");
		expect(reminder?.msg.content).toContain("LicenseGuard");
		// ...and, having fired, is no longer part of the pending retrieval surface
		const recallAfter = await s3.tools.get("recall")?.execute("t", { query: "licensing migrate" });
		expect(recallAfter?.content[0].text ?? "").not.toContain("[intent:Intent]");
	} finally {
		process.chdir(origCwd);
		delete g.__pi_kp__;
	}
});
