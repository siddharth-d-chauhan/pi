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
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createAgentMessageToolDefinition } from "../../../src/core/tools/agent-message.ts";

class FakeSession {
	prompts: string[] = [];
	followUps: string[] = [];
	reply = "fake reply";
	disposed = false;
	agent: { afterToolCall?: unknown } = {};
	private totalTokens = 0;
	private listeners = new Set<(event: { type: string }) => void>();
	private activeTools = ["read", "grep"];

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.totalTokens += 100;
		for (const listener of this.listeners) listener({ type: "turn_end" });
	}

	getSessionStats(): { tokens: { total: number }; cost: number } {
		return { tokens: { total: this.totalTokens }, cost: this.totalTokens / 100_000 };
	}

	async followUp(text: string): Promise<void> {
		this.followUps.push(text);
	}

	async steer(_text: string): Promise<void> {}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	setActiveToolsByName(names: string[]): void {
		this.activeTools = [...names];
	}

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
		expect(receipt).toMatchObject({ status: "replied", reply: "fake reply" });
		expect(receipt.status === "replied" && receipt.usage?.tokens).toBe(100);
		expect(fake.prompts[0]).toContain('<agent-message from="main">');
		expect(fake.prompts[0]).toContain("hello there");
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("idle");
	});

	it("queues in the lifecycle while running and drains on idle", async () => {
		const { id, fake } = registerFake({ sessionFile: "/tmp/fake.jsonl" });
		const onQueuedReply = vi.fn();
		const receipt = await deliverToAgent(id, "note this", { from: "main", onQueuedReply });
		expect(receipt).toEqual({ status: "queued" });
		// Queued in the lifecycle, NOT the session — a park cannot drop it.
		expect(fake.followUps).toHaveLength(0);
		expect(fake.prompts).toHaveLength(0);
		expect(getAgentLifecycle(id)?.queue).toHaveLength(1);

		markAgentIdle(id);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fake.prompts).toHaveLength(1);
		expect(fake.prompts[0]).toContain("note this");
		expect(getAgentLifecycle(id)?.queue).toHaveLength(0);
		expect(onQueuedReply).toHaveBeenCalledWith({ reply: "fake reply", usage: { tokens: 100, costUsd: 0.001 } });
	});

	it("returns a drained busy-agent reply visibly and to the parent model", async () => {
		const { id } = registerFake({ sessionFile: "/tmp/fake.jsonl" });
		const sendCustomMessage = vi.fn(async () => {});
		const senderSession = { isStreaming: false, sendCustomMessage } as unknown as AgentSession;
		const tool = createAgentMessageToolDefinition({ selfLabel: "main", senderSession });

		const result = await tool.execute(
			"call-1",
			{ to: id, message: "say hello", wait: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.details).toMatchObject({ receipt: "queued" });
		markAgentIdle(id);
		await vi.waitFor(() => expect(sendCustomMessage).toHaveBeenCalledOnce());
		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "agent-message",
				display: true,
				content: expect.stringContaining("fake reply"),
			}),
			{ triggerTurn: true },
		);
	});

	it("shows an explicit agent input request in the main transcript without auto-running main", async () => {
		const registry = getBackgroundProcessRegistry();
		const id = registry.register({ kind: "subagent", label: "reviewer", agentType: "reviewer" });
		const sendCustomMessage = vi.fn(async () => {});
		const parentSession = { isStreaming: false, sendCustomMessage } as unknown as AgentSession;
		const tool = createAgentMessageToolDefinition({
			selfLabel: `reviewer(${id})`,
			selfRegistryId: id,
			parentSession,
		});

		await tool.execute(
			"call-question",
			{ to: "main", message: "Which deployment region should I use?", requiresInput: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(registry.get(id)?.inputRequest).toBe("Which deployment region should I use?");
		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "agent-question", display: true }),
			{ triggerTurn: false },
		);
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
		expect(receipt).toMatchObject({ status: "replied", reply: "revived reply" });
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
