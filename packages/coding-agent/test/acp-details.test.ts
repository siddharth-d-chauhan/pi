import { expect, test, vi } from "vitest";

import acpDetails, { formatRunSummary } from "../../../extensions/acp-details.ts";

function harness() {
	const handlers = new Map<string, Array<(event: never, context: never) => Promise<void>>>();
	acpDetails({
		on(event: string, handler: (event: never, context: never) => Promise<void>) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as never);
	const notify = vi.fn();
	const context = { mode: "rpc", cwd: "/home/siddharth/pi", ui: { notify } };
	const emit = async (name: string, event: unknown, override: unknown = context) => {
		for (const handler of handlers.get(name) ?? []) await handler(event as never, override as never);
	};
	return { emit, notify, context };
}

test("ACP receives full tool labels and visible thinking summaries", async () => {
	const { emit, notify, context } = harness();
	await emit("tool_execution_start", {
		toolName: "find",
		args: { pattern: "*.ts", path: "/home/siddharth/pi", limit: 10 },
	});
	await emit("message_update", {
		assistantMessageEvent: { type: "thinking_end", content: "Inspect callers before editing" },
	});
	expect(notify).toHaveBeenCalledWith("find *.ts in ~/pi (limit 10)");
	expect(notify).toHaveBeenCalledWith("thinking: Inspect callers before editing");

	notify.mockClear();
	await emit("tool_execution_start", { toolName: "find", args: {} }, { ...context, mode: "tui" });
	expect(notify).not.toHaveBeenCalled();
});

test("ACP run summary reports usage and cache", () => {
	vi.useFakeTimers();
	vi.setSystemTime(2_000);
	expect(
		formatRunSummary({
			input: 1_000,
			output: 200,
			cacheRead: 9_000,
			cacheWrite: 0,
			cost: 0.0123,
			turns: 2,
			startedAt: 1_000,
		}),
	).toBe("run complete: 2 model turns | in 1.0k | out 200 | cache 90.0% | $0.0123 | 1.0s");
	vi.useRealTimers();
});
