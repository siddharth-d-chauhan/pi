import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	deliverToAgent,
	getAgentLifecycle,
	markAgentIdle,
	parkAgent,
	registerRunningAgent,
	releaseAgent,
	resetLifecycleForTests,
} from "../../../src/core/agents/lifecycle.ts";
import {
	getBackgroundProcessRegistry,
	resetForTests as resetRegistry,
} from "../../../src/core/background-process-registry.ts";

class FakeSession {
	prompts: string[] = [];
	followUps: string[] = [];
	reply = "fake reply";
	disposed = false;
	private listeners = new Set<(event: { type: string }) => void>();

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		for (const listener of this.listeners) listener({ type: "turn_end" });
	}

	async followUp(text: string): Promise<void> {
		this.followUps.push(text);
	}

	async steer(_text: string): Promise<void> {}

	abort(): void {}

	subscribe(listener: (event: { type: string }) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getLastAssistantText(): string {
		return this.reply;
	}

	dispose(): void {
		this.disposed = true;
	}
}

function asSession(fake: FakeSession): AgentSession {
	return fake as unknown as AgentSession;
}

function registerFake(opts: {
	sessionFile?: string;
	revive?: () => Promise<{ session: AgentSession; dispose: () => void }>;
	idleTtlMs?: number;
}): { id: string; fake: FakeSession } {
	const registry = getBackgroundProcessRegistry();
	const id = registry.register({ kind: "subagent", label: "fake", agentType: "worker" });
	const fake = new FakeSession();
	registerRunningAgent({
		registryId: id,
		agentType: "worker",
		session: asSession(fake),
		dispose: () => fake.dispose(),
		sessionFile: opts.sessionFile,
		revive: opts.revive,
		idleTtlMs: opts.idleTtlMs,
	});
	return { id, fake };
}

afterEach(() => {
	resetLifecycleForTests();
	resetRegistry();
	vi.useRealTimers();
});

describe("agent lifecycle", () => {
	it("adopts a finished agent as idle and delivers with a reply", async () => {
		const { id, fake } = registerFake({ sessionFile: "/tmp/fake.jsonl" });
		expect(markAgentIdle(id)).toBe(true);
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("idle");

		const receipt = await deliverToAgent(id, "hello there", { from: "main", awaitReply: true });
		expect(receipt).toEqual({ status: "replied", reply: "fake reply" });
		expect(fake.prompts[0]).toContain('<agent-message from="main">');
		expect(fake.prompts[0]).toContain("hello there");
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("idle");
	});

	it("queues via followUp while the agent is running", async () => {
		const { id, fake } = registerFake({});
		const receipt = await deliverToAgent(id, "note this", { from: "main" });
		expect(receipt).toEqual({ status: "queued" });
		expect(fake.followUps[0]).toContain("note this");
		expect(fake.prompts).toHaveLength(0);
	});

	it("parks idle agents after the TTL and revives on delivery", async () => {
		vi.useFakeTimers();
		const revived = new FakeSession();
		revived.reply = "revived reply";
		const revive = vi.fn(async () => ({ session: asSession(revived), dispose: () => revived.dispose() }));
		const { id, fake } = registerFake({ sessionFile: "/tmp/fake.jsonl", revive, idleTtlMs: 50 });
		markAgentIdle(id);

		vi.advanceTimersByTime(80);
		expect(getAgentLifecycle(id)?.state).toBe("parked");
		expect(fake.disposed).toBe(true);
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("parked");
		vi.useRealTimers();

		const receipt = await deliverToAgent(id, "wake up", { from: "main", awaitReply: true });
		expect(revive).toHaveBeenCalledOnce();
		expect(receipt).toEqual({ status: "replied", reply: "revived reply" });
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("idle");
	});

	it("disposes file-less agents at park time and reports delivery failure", async () => {
		vi.useFakeTimers();
		const { id, fake } = registerFake({ idleTtlMs: 50 });
		markAgentIdle(id);
		vi.advanceTimersByTime(80);
		vi.useRealTimers();

		expect(fake.disposed).toBe(true);
		expect(getAgentLifecycle(id)).toBeUndefined();
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("completed");

		const receipt = await deliverToAgent(id, "anyone home?", { from: "main" });
		expect(receipt.status).toBe("failed");
	});

	it("releaseAgent drops the entry entirely (kill path)", () => {
		const { id, fake } = registerFake({});
		releaseAgent(id);
		expect(fake.disposed).toBe(true);
		expect(getAgentLifecycle(id)).toBeUndefined();
	});

	it("parkAgent is a no-op for running agents", () => {
		const { id } = registerFake({ sessionFile: "/tmp/fake.jsonl" });
		parkAgent(id);
		expect(getAgentLifecycle(id)?.state).toBe("running");
	});
});
