import { expect, test } from "vitest";
import cacheRecovery from "../../../extensions/cache-recovery.ts";

function harness() {
	const handlers = new Map<string, Array<(event: never, context: never) => Promise<unknown>>>();
	const sent: unknown[] = [];
	cacheRecovery({
		on(event: string, handler: (value: never, context: never) => Promise<unknown>) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	} as never);
	const emit = async (event: string, value: unknown, context: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(value as never, context as never);
	};
	return { emit, sent };
}

function assistant(input: number, cacheRead: number) {
	return {
		message: {
			role: "assistant",
			stopReason: "toolUse",
			usage: { input, cacheRead, cacheWrite: 0 },
		},
	};
}

test("compacts and resumes when a healthy large cache collapses during a tool loop", async () => {
	const { emit, sent } = harness();
	let compactOptions:
		| { onComplete?: () => void; onError?: (error: Error) => void; customInstructions?: string }
		| undefined;
	const statuses: Array<string | undefined> = [];
	const context = {
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			notify() {},
		},
		compact(options: typeof compactOptions) {
			compactOptions = options;
		},
	};

	await emit("message_end", assistant(10_000, 90_000));
	await emit("message_end", assistant(100_000, 0));
	await emit("turn_end", {}, context);

	expect(compactOptions?.customInstructions).toContain("Prompt-cache continuity was lost");
	expect(statuses).toContain("prompt cache lost · compacting");
	compactOptions?.onComplete?.();
	expect(sent).toHaveLength(1);
	expect(JSON.stringify(sent[0])).toContain("without repeating completed discovery");
});

test("does not treat a provider without prior cache hits as a collapse", async () => {
	const { emit } = harness();
	let compacted = false;
	await emit("message_end", assistant(100_000, 0));
	await emit(
		"turn_end",
		{},
		{
			getContextUsage: () => undefined,
			ui: { setStatus() {}, notify() {} },
			compact() {
				compacted = true;
			},
		},
	);
	expect(compacted).toBe(false);
});

test("compacts a large context after an explicit task-direction shift", async () => {
	const { emit } = harness();
	let compactOptions: { customInstructions?: string } | undefined;
	const context = {
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 372_000, percent: 0.27 }),
		ui: { setStatus() {}, notify() {} },
		compact(options: typeof compactOptions) {
			compactOptions = options;
		},
	};
	await emit("tool_execution_end", { toolName: "pi_context_shift", isError: false }, context);
	await emit("turn_end", {}, context);
	expect(compactOptions?.customInstructions).toContain("changed task direction");
});

test("compacts and resumes when one active tool loop crosses the context ceiling", async () => {
	const { emit, sent } = harness();
	let compactOptions:
		| { onComplete?: () => void; onError?: (error: Error) => void; customInstructions?: string }
		| undefined;
	const statuses: Array<string | undefined> = [];
	const context = {
		getContextUsage: () => ({ tokens: 193_000, contextWindow: 1_000_000, percent: 0.193 }),
		ui: {
			setStatus(_key: string, value: string | undefined) {
				statuses.push(value);
			},
			notify() {},
		},
		compact(options: typeof compactOptions) {
			compactOptions = options;
		},
	};

	await emit("turn_end", {}, context);
	expect(compactOptions?.customInstructions).toContain("configured context ceiling");
	expect(statuses).toContain("context ceiling reached · compacting");
	compactOptions?.onComplete?.();
	expect(JSON.stringify(sent)).toContain("without rereading completed evidence");
});

test("keeps a warm active loop intact below the context ceiling", async () => {
	const { emit } = harness();
	let compacted = false;
	await emit(
		"turn_end",
		{},
		{
			getContextUsage: () => ({ tokens: 159_999, contextWindow: 1_000_000, percent: 0.159999 }),
			ui: { setStatus() {}, notify() {} },
			compact() {
				compacted = true;
			},
		},
	);
	expect(compacted).toBe(false);
});
