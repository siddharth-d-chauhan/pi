import { afterEach, describe, expect, it } from "vitest";
import chainLearn from "../../../../../extensions/chain-learn.ts";

type ToolEndHandler = (event: {
	toolName: string;
	result?: {
		details?: {
			chain?: string;
			status?: string;
			stages?: Array<Record<string, unknown>>;
		};
	};
}) => Promise<void>;

function installChainLearn(): ToolEndHandler {
	let handler: ToolEndHandler | undefined;
	chainLearn({
		on: (event: string, listener: ToolEndHandler) => {
			if (event === "tool_execution_end") handler = listener;
		},
	} as never);
	if (!handler) throw new Error("chain-learn did not register its tool completion handler");
	return handler;
}

describe("chain-learn containment", () => {
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).__pi_kp__;
	});

	it("does not write an ungated stage even when legacy attempts are nonzero", async () => {
		const calls: unknown[] = [];
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({ callTool: async (request: unknown) => calls.push(request) }),
		};
		const onToolEnd = installChainLearn();

		await onToolEnd({
			toolName: "chain",
			result: {
				details: {
					chain: "flow",
					status: "completed",
					stages: [{ id: "work", agent: "worker", status: "completed", verifyAttempts: 1, inline: "done" }],
				},
			},
		});

		expect(calls).toEqual([]);
	});

	it("writes only a stage whose configured gate passed", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({
				callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
					calls.push(request);
					return { content: [] };
				},
			}),
		};
		const onToolEnd = installChainLearn();

		await onToolEnd({
			toolName: "chain",
			result: {
				details: {
					chain: "flow",
					status: "completed",
					stages: [
						{
							id: "verified",
							agent: "worker",
							status: "completed",
							gateConfigured: true,
							gatePassed: true,
							verifyAttempts: 1,
							inline: "done",
						},
						{
							id: "failed",
							agent: "worker",
							status: "completed",
							gateConfigured: true,
							gatePassed: false,
							verifyAttempts: 1,
							inline: "not accepted",
						},
					],
				},
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			name: "pi.memory_writeback",
			arguments: { kind: "verified_fix", summary: expect.stringContaining("verified") },
		});
	});
});
