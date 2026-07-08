import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getBackgroundProcessRegistry, resetForTests } from "../../../src/core/background-process-registry.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

/**
 * Phase 0 concurrent-session spike. The audit found no proof two
 * AgentSessions ever ran concurrently in one process. This test creates
 * two sessions with the faux provider, runs overlapping prompt() calls,
 * and asserts:
 *   - interleaved events do not cross streams,
 *   - both sessions complete,
 *   - getSessionStats() is independent per session,
 *   - background registry entries do not collide.
 *
 * Children in Phase 1 load no extensions (per the plan's locked decision),
 * so extension-runtime invalidation is not exercised here.
 */
describe("concurrent agent sessions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		resetForTests();
	});

	it("runs two AgentSessions concurrently without event stream cross-contamination", async () => {
		const a = await createHarness();
		const b = await createHarness();
		harnesses.push(a, b);

		a.setResponses([fauxAssistantMessage("from-a")]);
		b.setResponses([fauxAssistantMessage("from-b")]);

		await Promise.all([a.session.prompt("hi a"), b.session.prompt("hi b")]);

		expect(getAssistantTexts(a)).toEqual(["from-a"]);
		expect(getAssistantTexts(b)).toEqual(["from-b"]);

		// Independent stats.
		const statsA = a.session.getSessionStats();
		const statsB = b.session.getSessionStats();
		expect(statsA.sessionId).not.toBe(statsB.sessionId);
		expect(statsA.assistantMessages).toBe(1);
		expect(statsB.assistantMessages).toBe(1);
	});

	it("does not collide when both sessions register against the background registry singleton", async () => {
		const a = await createHarness();
		const b = await createHarness();
		harnesses.push(a, b);

		const reg = getBackgroundProcessRegistry();
		const idA = reg.register({ kind: "subagent", label: "alpha" });
		const idB = reg.register({ kind: "subagent", label: "beta" });

		expect(idA).not.toBe(idB);
		expect(
			reg
				.list()
				.map((s) => s.id)
				.sort(),
		).toEqual([idA, idB].sort());

		reg.setStatus(idA, "completed");
		reg.setStatus(idB, "failed");

		const snap = reg.list();
		const aSnap = snap.find((s) => s.id === idA);
		const bSnap = snap.find((s) => s.id === idB);
		expect(aSnap?.status).toBe("completed");
		expect(bSnap?.status).toBe("failed");
	});

	it("supports optional registry control callbacks and metrics", () => {
		const reg = getBackgroundProcessRegistry();
		const calls: string[] = [];
		const id = reg.register({
			kind: "subagent",
			label: "review",
			agentType: "reviewer",
			parentId: "parent-session",
			onKill: () => calls.push("kill"),
			onSteer: (text) => calls.push(`steer:${text}`),
		});

		reg.update(id, {
			metrics: { tokens: 123, costUsd: 0.0123, requests: 2, contextPct: 4.5 },
			resultHandle: "agent://review",
			sessionFile: "/tmp/session.jsonl",
		});

		expect(reg.kill(id)).toBe(true);
		expect(reg.steer(id, "wrap up")).toBe(true);
		expect(calls).toEqual(["kill", "steer:wrap up"]);

		const snapshot = reg.list()[0];
		expect(snapshot.agentType).toBe("reviewer");
		expect(snapshot.parentId).toBe("parent-session");
		expect(snapshot.canKill).toBe(true);
		expect(snapshot.canSteer).toBe(true);
		expect(snapshot.metrics?.tokens).toBe(123);
		expect(snapshot.resultHandle).toBe("agent://review");
		expect(reg.kill("missing")).toBe(false);
		expect(reg.steer("missing", "x")).toBe(false);
	});
});
