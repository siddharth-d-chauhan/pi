import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { getBackgroundProcessRegistry, resetForTests } from "../../src/core/background-process-registry.ts";
import {
	type BashBackgroundHost,
	type BashOperations,
	createBashTool,
	looksLikePrompt,
	resetBackgroundNotifierForTests,
} from "../../src/core/tools/bash.ts";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

function makeHost() {
	const messages: Array<{ message: { content: string; customType: string }; options?: { deliverAs?: string } }> = [];
	const host: BashBackgroundHost = {
		async sendCustomMessage(message, options) {
			messages.push({ message: message as { content: string; customType: string }, options });
			return undefined;
		},
	};
	return { host, messages };
}

// Longer than the 200ms notification batch window so completions flush.
const tick = () => new Promise((r) => setTimeout(r, 260));

describe("bash run_in_background", () => {
	beforeEach(() => {
		resetForTests();
		resetBackgroundNotifierForTests();
	});

	it("launches detached, streams to the registry, and notifies on completion", async () => {
		let resolveExec: (v: { exitCode: number | null }) => void = () => {};
		const operations: BashOperations = {
			exec: async (_cmd, _cwd, { onData, signal }) => {
				onData(Buffer.from("line1\n", "utf-8"));
				onData(Buffer.from("line2\n", "utf-8"));
				return await new Promise((res) => {
					resolveExec = res;
					signal?.addEventListener("abort", () => res({ exitCode: null }));
				});
			},
		};
		const { host, messages } = makeHost();
		const bash = createBashTool(process.cwd(), { operations, backgroundHost: host });

		// Returns immediately, before exec resolves.
		const result = await bash.execute("bg1", { command: "sleep 100", run_in_background: true });
		expect(getTextOutput(result)).toContain("Background command started");

		const reg = getBackgroundProcessRegistry();
		const list = reg.list();
		expect(list).toHaveLength(1);
		expect(list[0].kind).toBe("shell");
		expect(list[0].status).toBe("running");

		const entry = reg.get(list[0].id);
		expect(entry?.log).toContain("line1");
		expect(entry?.log).toContain("line2");
		expect(messages).toHaveLength(0); // not notified while running

		resolveExec({ exitCode: 0 });
		await tick();

		expect(reg.get(list[0].id)?.status).toBe("completed");
		expect(messages).toHaveLength(1);
		expect(messages[0].message.customType).toBe("task-notification");
		expect(messages[0].message.content).toContain('status="completed"');
		expect(messages[0].options?.deliverAs).toBe("nextTurn");
	});

	it("marks a nonzero exit as failed", async () => {
		let resolveExec: (v: { exitCode: number | null }) => void = () => {};
		const operations: BashOperations = {
			exec: async () =>
				new Promise((res) => {
					resolveExec = res;
				}),
		};
		const { host, messages } = makeHost();
		const bash = createBashTool(process.cwd(), { operations, backgroundHost: host });
		await bash.execute("bg-fail", { command: "false", run_in_background: true });
		const id = getBackgroundProcessRegistry().list()[0].id;
		resolveExec({ exitCode: 3 });
		await tick();
		expect(getBackgroundProcessRegistry().get(id)?.status).toBe("failed");
		expect(messages[0].message.content).toContain('status="failed"');
		expect(messages[0].message.content).toContain('exit="3"');
	});

	it("kill() aborts the command and marks it cancelled", async () => {
		const operations: BashOperations = {
			exec: async (_c, _cwd, { signal }) =>
				new Promise((res) => signal?.addEventListener("abort", () => res({ exitCode: null }))),
		};
		const { host, messages } = makeHost();
		const bash = createBashTool(process.cwd(), { operations, backgroundHost: host });
		await bash.execute("bg-kill", { command: "watch ls", run_in_background: true });
		const reg = getBackgroundProcessRegistry();
		const id = reg.list()[0].id;
		expect(reg.kill(id)).toBe(true);
		await tick();
		expect(reg.get(id)?.status).toBe("cancelled");
		expect(messages[0].message.content).toContain('status="cancelled"');
	});

	it("persists full output to a file that can be read back", async () => {
		let resolveExec: (v: { exitCode: number | null }) => void = () => {};
		const operations: BashOperations = {
			exec: async (_c, _cwd, { onData }) => {
				onData(Buffer.from("hello world\n", "utf-8"));
				return new Promise((res) => {
					resolveExec = res;
				});
			},
		};
		const { host } = makeHost();
		const bash = createBashTool(process.cwd(), { operations, backgroundHost: host });
		const result = (await bash.execute("bg-file", { command: "echo hi", run_in_background: true })) as {
			details?: { fullOutputPath?: string };
		};
		const path = result.details?.fullOutputPath;
		expect(path).toBeTruthy();
		resolveExec({ exitCode: 0 });
		await tick();
		expect(readFileSync(path as string, "utf-8")).toContain("hello world");
	});

	it("collapses consecutive completed commands into one notification", async () => {
		const resolvers: Array<(v: { exitCode: number | null }) => void> = [];
		const operations: BashOperations = {
			exec: async () => new Promise((res) => resolvers.push(res)),
		};
		const { host, messages } = makeHost();
		const bash = createBashTool(process.cwd(), { operations, backgroundHost: host });
		await bash.execute("bg-a", { command: "buildA", run_in_background: true });
		await bash.execute("bg-b", { command: "buildB", run_in_background: true });
		// Both finish close together, within the batch window.
		resolvers[0]({ exitCode: 0 });
		resolvers[1]({ exitCode: 0 });
		await tick();
		expect(messages).toHaveLength(1);
		expect(messages[0].message.content).toContain("2 background commands completed");
		expect(messages[0].message.content).toContain("buildA");
		expect(messages[0].message.content).toContain("buildB");
	});

	it("does not collapse a failure into the success batch", async () => {
		const resolvers: Array<(v: { exitCode: number | null }) => void> = [];
		const operations: BashOperations = {
			exec: async () => new Promise((res) => resolvers.push(res)),
		};
		const { host, messages } = makeHost();
		const bash = createBashTool(process.cwd(), { operations, backgroundHost: host });
		await bash.execute("bg-ok", { command: "ok", run_in_background: true });
		await bash.execute("bg-bad", { command: "bad", run_in_background: true });
		resolvers[0]({ exitCode: 0 }); // queued (completed)
		resolvers[1]({ exitCode: 1 }); // failure → flushes queue then sends itself
		await tick();
		expect(messages).toHaveLength(2);
		expect(messages.some((m) => m.message.content.includes('status="failed"'))).toBe(true);
		expect(messages.some((m) => m.message.content.includes('status="completed"'))).toBe(true);
	});

	it("detects interactive-prompt tails", () => {
		expect(looksLikePrompt("Password: ")).toBe(true);
		expect(looksLikePrompt("Continue? ")).toBe(true);
		expect(looksLikePrompt("Overwrite (y/n) ")).toBe(true);
		expect(looksLikePrompt("Press ENTER to continue")).toBe(true);
		expect(looksLikePrompt("Building module 3 of 10")).toBe(false);
		expect(looksLikePrompt("")).toBe(false);
	});

	it("streams a real shell command end to end and notifies on completion", async () => {
		const { host, messages } = makeHost();
		// No mocked operations → exercises the real local shell spawn/stream path.
		const bash = createBashTool(process.cwd(), { backgroundHost: host });
		const result = (await bash.execute("bg-real", {
			command: "printf 'hello\\nworld\\n'; sleep 0.1",
			run_in_background: true,
		})) as { details?: { fullOutputPath?: string } };

		const reg = getBackgroundProcessRegistry();
		const id = reg.list()[0].id;
		await new Promise((r) => setTimeout(r, 700));

		const entry = reg.get(id);
		expect(entry?.status).toBe("completed");
		expect(entry?.log).toContain("hello");
		expect(entry?.log).toContain("world");
		expect(messages).toHaveLength(1);
		expect(messages[0].message.content).toContain('status="completed"');
		expect(readFileSync(result.details?.fullOutputPath as string, "utf-8")).toContain("hello");
	});

	it("runs without a backgroundHost (no notification, no throw)", async () => {
		let resolveExec: (v: { exitCode: number | null }) => void = () => {};
		const operations: BashOperations = {
			exec: async () =>
				new Promise((res) => {
					resolveExec = res;
				}),
		};
		const bash = createBashTool(process.cwd(), { operations });
		const result = await bash.execute("bg-nohost", { command: "x", run_in_background: true });
		expect(getTextOutput(result)).toContain("Background command started");
		resolveExec({ exitCode: 0 });
		await tick();
		expect(getBackgroundProcessRegistry().list()[0].status).toBe("completed");
	});
});
