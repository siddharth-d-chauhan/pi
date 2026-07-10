import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import autoLearn from "../../../extensions/auto-learn.ts";

type RegisteredTool = { execute: (...args: any[]) => Promise<unknown> };
type RegisteredCommand = { handler: (args: string | undefined, ctx: any) => Promise<void> };

function installAutoLearn() {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	autoLearn({
		registerTool: (tool: { name: string } & RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
		on: () => {},
	} as any);
	return { tools, commands };
}

describe("auto-learn containment", () => {
	it("queues model memories without authority evidence and preserves scope", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({
				callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
					calls.push(request);
					return { content: [{ type: "text", text: JSON.stringify({ candidate: {} }) }] };
				},
			}),
		};
		const { tools } = installAutoLearn();

		await tools
			.get("remember")!
			.execute("id", { kind: "rule", summary: "Never force-push", scope: "repo" }, undefined, undefined, {
				cwd: "/work/repository",
			});

		expect(calls).toEqual([
			{
				name: "pi.memory_writeback",
				arguments: { kind: "rule", summary: "Never force-push", text: undefined, repository: "repository" },
			},
		]);
	});

	it("preserves file scope without adding authority evidence", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({
				callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
					calls.push(request);
					return { content: [{ type: "text", text: JSON.stringify({ candidate: {} }) }] };
				},
			}),
		};
		const { tools } = installAutoLearn();

		await tools
			.get("remember")!
			.execute(
				"id",
				{ kind: "pitfall", summary: "Keep tests narrow", scope: "file", file: "src/cache.ts" },
				undefined,
				undefined,
				{},
			);

		expect(calls[0]?.arguments).toEqual({
			kind: "pitfall",
			summary: "Keep tests narrow",
			text: undefined,
			file: "src/cache.ts",
		});
	});

	it("rejects model-supplied authority fields before writeback", async () => {
		const calls: unknown[] = [];
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({
				callTool: async (request: unknown) => {
					calls.push(request);
					return { content: [{ type: "text", text: JSON.stringify({ candidate: {} }) }] };
				},
			}),
		};
		const { tools } = installAutoLearn();

		await expect(
			tools
				.get("remember")!
				.execute("id", { kind: "rule", summary: "Never force-push", from_user: true }, undefined, undefined, {}),
		).rejects.toThrow("authority fields");
		expect(calls).toEqual([]);
	});

	it("queues /remember command input as a proposal without authority evidence", async () => {
		const calls: unknown[] = [];
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({
				callTool: async (request: unknown) => {
					calls.push(request);
					return { content: [{ type: "text", text: JSON.stringify({ candidate: {} }) }] };
				},
			}),
		};
		const { commands } = installAutoLearn();
		const notifications: Array<[string, string]> = [];

		await commands.get("remember")!.handler("never force-push", {
			ui: { notify: (text: string, level: string) => notifications.push([text, level]) },
		});

		expect(calls).toEqual([
			{ name: "pi.memory_writeback", arguments: { kind: "rule", summary: "never force-push" } },
		]);
		expect(notifications).toEqual([[expect.stringContaining("proposal queued"), "info"]]);
	});

	it("does not report success when the private writeback call is denied", async () => {
		(globalThis as Record<string, unknown>).__pi_kp__ = {
			connect: async () => ({
				callTool: async () => ({
					isError: true,
					content: [{ type: "text", text: JSON.stringify({ error: "disabled by profile" }) }],
				}),
			}),
		};
		const { tools } = installAutoLearn();

		const result = (await tools
			.get("remember")!
			.execute("id", { kind: "rule", summary: "Never force-push" }, undefined, undefined, {})) as {
			content: Array<{ text: string }>;
		};

		expect(result.content[0]?.text).toContain("not recorded");
		expect(result.content[0]?.text).not.toContain("remembered as undefined");
	});
});

describe("knowledge extension containment", () => {
	it("keeps writeback and maintenance tools out of the model allowlist", () => {
		const source = readFileSync(fileURLToPath(new URL("../../../extensions/knowledge.ts", import.meta.url)), "utf8");
		for (const name of [
			"pi_memory_writeback",
			"pi_semantic_backfill",
			"pi_warm_mirror_sync",
			"pi_knowledge_refresh",
			"pi_inject_backfill",
		]) {
			expect(source).not.toMatch(new RegExp(`\\"${name}\\"`));
		}
	});
});
