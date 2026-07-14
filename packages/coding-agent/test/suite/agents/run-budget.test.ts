import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { capAgentToolResultContent, enforceAgentRunBudget } from "../../../src/core/agents/run-budget.ts";

function fakeSession(options: { sessionFile?: string; sessionId?: string } = {}) {
	let listener: ((event: { type: string }) => void) | undefined;
	const session = {
		agent: { afterToolCall: undefined as AgentSession["agent"]["afterToolCall"] },
		sessionFile: options.sessionFile,
		sessionId: options.sessionId ?? "test-child-session",
		getActiveToolNames: vi.fn(() => ["read", "grep"]),
		setActiveToolsByName: vi.fn(),
		steer: vi.fn(async () => {}),
		abort: vi.fn(),
		subscribe: vi.fn((candidate: (event: { type: string }) => void) => {
			listener = candidate;
			return vi.fn();
		}),
	};
	return { session: session as unknown as AgentSession, raw: session, emit: (type: string) => listener?.({ type }) };
}

describe("agent run budget", () => {
	it("bounds oversized child tool results while preserving their head and tail", () => {
		const original = `${"a".repeat(10_000)}TAIL`;
		const capped = capAgentToolResultContent([{ type: "text", text: original }], 1_000);
		const text = capped[0]?.type === "text" ? capped[0].text : "";

		expect(text.length).toBeLessThanOrEqual(1_000);
		expect(text).toContain("Subagent tool output truncated");
		expect(text.startsWith("aaaa")).toBe(true);
		expect(text.endsWith("TAIL")).toBe(true);
	});

	it("spills omitted child output so a narrow read can recover it without rerunning the tool", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-run-budget-"));
		try {
			const original = `${"a".repeat(10_000)}TAIL`;
			const { session } = fakeSession({ sessionFile: join(directory, "child.jsonl") });
			const dispose = enforceAgentRunBudget(session, { maxTurns: 8, maxResultChars: 1_000 });
			const hook = session.agent.afterToolCall;
			const result = await hook?.({
				toolCall: { type: "toolCall", id: "call/1", name: "read", arguments: {} },
				result: { content: [{ type: "text", text: original }], details: {} },
			} as Parameters<NonNullable<typeof hook>>[0]);
			dispose();

			const text = result?.content?.[0]?.type === "text" ? result.content[0].text : "";
			const outputPath = text.match(/Full output: ([^\]]+?)\. Search/)?.[1];
			expect(outputPath).toBeDefined();
			expect(readFileSync(outputPath!, "utf8")).toBe(original);
			expect(text.length).toBeLessThanOrEqual(1_000);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("removes tools after the call limit and restores them after the run", () => {
		const { session, raw, emit } = fakeSession();
		const dispose = enforceAgentRunBudget(session, { maxTurns: 8, maxToolCalls: 2 });
		emit("tool_execution_start");
		emit("tool_execution_start");

		expect(raw.setActiveToolsByName).toHaveBeenCalledWith([]);
		expect(raw.steer).toHaveBeenCalledWith(expect.stringContaining("Tool budget reached"));
		dispose();
		expect(raw.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "grep"]);
	});

	it("steers broad discovery back to the delegated scope before the hard limit", () => {
		const { session, raw, emit } = fakeSession();
		const dispose = enforceAgentRunBudget(session, { maxTurns: 8, maxToolCalls: 5, scopeCheckpoint: 3 });
		emit("tool_execution_start");
		emit("tool_execution_start");
		emit("tool_execution_start");

		expect(raw.steer).toHaveBeenCalledWith(expect.stringContaining("stay strictly inside the delegated goal"));
		expect(raw.setActiveToolsByName).not.toHaveBeenCalled();
		dispose();
	});

	it("steers at the turn ceiling and aborts a run that continues", () => {
		const { session, raw, emit } = fakeSession();
		const dispose = enforceAgentRunBudget(session, { maxTurns: 2 });
		emit("turn_end");
		emit("turn_end");
		expect(raw.steer).toHaveBeenCalledWith(expect.stringContaining("Turn budget reached"));
		emit("turn_end");
		expect(raw.abort).toHaveBeenCalledOnce();
		dispose();
	});
});
