import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import tokenBudget from "../../../extensions/token-budget.ts";

function registerAll() {
	const handlers = new Map<string, (event: never, context: never) => Promise<unknown>>();
	tokenBudget({
		on(event: string, candidate: (value: never, context: never) => Promise<unknown>) {
			handlers.set(event, candidate);
		},
	} as never);
	return handlers;
}

function register() {
	const handler = registerAll().get("tool_result");
	if (!handler) throw new Error("tool_result handler was not registered");
	return handler;
}

function context(root: string) {
	return {
		sessionManager: {
			getSessionFile: () => join(root, "session.jsonl"),
			getSessionId: () => "session-1",
		},
	};
}

test("large discovery results are bounded with an actionable notice", async () => {
	const handler = register();
	const root = mkdtempSync(join(tmpdir(), "token-budget-"));
	const sessionFile = join(root, "session.jsonl");
	const result = (await handler(
		{
			toolName: "grep",
			toolCallId: "grep-1",
			input: { pattern: "result" },
			isError: false,
			content: [{ type: "text", text: `${"matching result\n".repeat(3_000)}` }],
		} as never,
		context(root) as never,
	)) as { content: Array<{ type: string; text: string }> };
	const text = result.content[0].text;
	expect(text.length).toBeLessThanOrEqual(12_000);
	expect(text).toContain("Discovery output truncated");
	const outputDirectory = `${sessionFile}.tool-output`;
	expect(existsSync(outputDirectory)).toBe(true);
	const saved = readFileSync(join(outputDirectory, readdirSync(outputDirectory)[0]), "utf-8");
	expect(saved.length).toBeGreaterThan(30_000);
	rmSync(root, { recursive: true });
});

test("small and mutation results are unchanged while all oversized text results are bounded", async () => {
	const handler = register();
	const root = mkdtempSync(join(tmpdir(), "token-budget-"));
	const base = { toolCallId: "call-1", input: {} };
	const small = { ...base, toolName: "grep", isError: false, content: [{ type: "text", text: "small" }] };
	const error = {
		...base,
		toolName: "grep",
		isError: true,
		content: [{ type: "text", text: "x".repeat(30_000) }],
	};
	const read = { ...base, toolName: "read", isError: false, content: [{ type: "text", text: "x".repeat(30_000) }] };
	const bash = { ...base, toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(30_000) }] };
	const edit = { ...base, toolName: "edit", isError: false, content: [{ type: "text", text: "x".repeat(30_000) }] };
	const editError = { ...edit, isError: true };
	expect(await handler(small as never, context(root) as never)).toBeUndefined();
	for (const event of [error, read, bash, editError]) {
		const result = (await handler(event as never, context(root) as never)) as { content: Array<{ text: string }> };
		expect(result.content[0].text.length).toBeLessThanOrEqual(12_000);
		expect(result.content[0].text).toContain("output truncated");
	}
	expect(await handler(edit as never, context(root) as never)).toBeUndefined();
	rmSync(root, { recursive: true });
});

test("oversized shell output preserves both the beginning and final diagnostics", async () => {
	const handler = register();
	const root = mkdtempSync(join(tmpdir(), "token-budget-"));
	const result = (await handler(
		{
			toolName: "bash",
			toolCallId: "bash-1",
			input: { command: "npm run check" },
			isError: false,
			content: [{ type: "text", text: `START\n${"middle output\n".repeat(3_000)}FINAL ERROR` }],
		} as never,
		context(root) as never,
	)) as { content: Array<{ text: string }> };
	expect(result.content[0].text).toContain("START");
	expect(result.content[0].text).toContain("FINAL ERROR");
	expect(result.content[0].text.length).toBeLessThanOrEqual(12_000);
	rmSync(root, { recursive: true });
});

test("identical repeated reads return a short pointer instead of the same payload", async () => {
	const handler = register();
	const root = mkdtempSync(join(tmpdir(), "token-budget-"));
	const first = {
		toolName: "read",
		toolCallId: "read-1",
		input: { path: "src/example.ts", offset: 1, limit: 200 },
		isError: false,
		content: [{ type: "text", text: "const value = true;\n".repeat(100) }],
	};
	expect(await handler(first as never, context(root) as never)).toBeUndefined();
	const duplicate = (await handler({ ...first, toolCallId: "read-2" } as never, context(root) as never)) as {
		content: Array<{ text: string }>;
	};
	expect(duplicate.content[0].text).toContain("Duplicate read result suppressed");
	expect(duplicate.content[0].text.length).toBeLessThan(300);
	rmSync(root, { recursive: true });
});

test("the discovery checkpoint asks the model to synthesize and act", async () => {
	const handler = register();
	const root = mkdtempSync(join(tmpdir(), "token-budget-"));
	let last: { content: Array<{ text: string }> } | undefined;
	for (let index = 1; index <= 12; index += 1) {
		last = (await handler(
			{
				toolName: "grep",
				toolCallId: `grep-${index}`,
				input: { pattern: `pattern-${index}` },
				isError: false,
				content: [{ type: "text", text: `result ${index}` }],
			} as never,
			context(root) as never,
		)) as typeof last;
	}
	expect(last?.content[0].text).toContain("Discovery checkpoint");
	rmSync(root, { recursive: true });
});

test("a long mixed tool loop receives one non-blocking finish checkpoint", async () => {
	const handler = register();
	const root = mkdtempSync(join(tmpdir(), "token-budget-"));
	let checkpointCount = 0;
	for (let index = 1; index <= 30; index += 1) {
		const result = (await handler(
			{
				toolName: "bash",
				toolCallId: `bash-${index}`,
				input: { command: `command-${index}` },
				isError: false,
				content: [{ type: "text", text: `result ${index}` }],
			} as never,
			context(root) as never,
		)) as { content: Array<{ text: string }> } | undefined;
		if (result?.content.some((block) => block.text.includes("Tool-loop checkpoint"))) checkpointCount += 1;
	}
	expect(checkpointCount).toBe(1);
	rmSync(root, { recursive: true });
});

test("subagents are hard-stopped after the advertised tool budget", async () => {
	const handlers = registerAll();
	const sessionStart = handlers.get("session_start");
	const agentStart = handlers.get("agent_start");
	const toolCall = handlers.get("tool_call");
	const turnStart = handlers.get("turn_start");
	if (!sessionStart || !agentStart || !toolCall || !turnStart) throw new Error("budget handlers were not registered");
	const abort = vi.fn();
	const ctx = {
		sessionManager: {
			getHeader: () => ({ parentSession: "/tmp/parent.jsonl" }),
		},
		abort,
	};
	await sessionStart({} as never, ctx as never);
	await agentStart({} as never, ctx as never);
	for (let index = 0; index < 14; index += 1) {
		expect(
			await toolCall(
				{ toolName: "read", toolCallId: `read-${index}`, input: { path: `${index}.ts` } } as never,
				ctx as never,
			),
		).toBeUndefined();
	}

	await turnStart({} as never, ctx as never);
	const blocked = await toolCall(
		{ toolName: "read", toolCallId: "read-blocked", input: { path: "blocked.ts" } } as never,
		ctx as never,
	);
	expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("best evidence-backed result") });
	expect(abort).not.toHaveBeenCalled();

	await turnStart({} as never, ctx as never);
	await toolCall({ toolName: "grep", toolCallId: "grep-blocked", input: { pattern: "more" } } as never, ctx as never);
	expect(abort).toHaveBeenCalledOnce();
});

test("primary runs cannot expand into unbounded tool loops", async () => {
	const handlers = registerAll();
	const sessionStart = handlers.get("session_start");
	const agentStart = handlers.get("agent_start");
	const toolCall = handlers.get("tool_call");
	if (!sessionStart || !agentStart || !toolCall) throw new Error("budget handlers were not registered");
	const ctx = {
		sessionManager: { getHeader: () => undefined },
		abort: vi.fn(),
	};
	await sessionStart({} as never, ctx as never);
	await agentStart({} as never, ctx as never);
	for (let index = 0; index < 32; index += 1) {
		expect(
			await toolCall(
				{ toolName: "read", toolCallId: `read-${index}`, input: { path: `${index}.ts` } } as never,
				ctx as never,
			),
		).toBeUndefined();
	}
	await expect(
		toolCall({ toolName: "grep", toolCallId: "blocked", input: { pattern: "more" } } as never, ctx as never),
	).resolves.toMatchObject({ block: true });
});
