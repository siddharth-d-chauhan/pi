import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getBackgroundProcessRegistry, resetForTests } from "../../../src/core/background-process-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createAgentTool } from "../../../src/core/tools/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("agent tool", () => {
	const harnesses: Harness[] = [];
	const tempRoots: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempRoots.length > 0) {
			rmSync(tempRoots.pop()!, { recursive: true, force: true });
		}
		resetForTests();
	});

	function writeProjectAgent(harness: Harness, name: string, frontmatter: string, body = "Agent prompt."): void {
		const path = join(harness.tempDir, ".pi", "agents", `${name}.md`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\n${frontmatter.trim()}\n---\n${body}\n`);
	}

	async function waitForBackgroundStatus(id: string, status: string): Promise<void> {
		for (let i = 0; i < 30; i++) {
			const snapshot = getBackgroundProcessRegistry()
				.list()
				.find((entry) => entry.id === id);
			if (snapshot?.status === status) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const snapshot = getBackgroundProcessRegistry()
			.list()
			.find((entry) => entry.id === id);
		if (snapshot) {
			throw new Error(
				`background task ${id} did not reach ${status}; status=${snapshot.status}; log=${snapshot.logTail.join("\n")}`,
			);
		}
		throw new Error(`background task ${id} did not reach ${status}`);
	}

	async function waitForSessionFile(id: string): Promise<string> {
		for (let i = 0; i < 30; i++) {
			const snapshot = getBackgroundProcessRegistry()
				.list()
				.find((entry) => entry.id === id);
			if (snapshot?.sessionFile) return snapshot.sessionFile;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`background task ${id} did not publish a session file`);
	}

	it("includes the available agent roster in the tool description", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		writeProjectAgent(
			harness,
			"ops",
			`
name: ops
description: Investigate incidents
tools: read
`,
		);

		const tool = createAgentTool({
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			parentSession: harness.session,
		});

		expect(tool.description).toContain("Available subagents:");
		expect(tool.description).toContain("ops (project): Investigate incidents");
	});

	it("honors a definition's background default when the task omits background", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		writeProjectAgent(
			harness,
			"async_ops",
			`
name: async_ops
description: Background ops
tools: read
background: true
permissionMode: read-only
`,
		);
		harness.setResponses([fauxAssistantMessage("done in background")]);

		const tool = createAgentTool({
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			parentSession: harness.session,
		});
		const result = await tool.execute("call-1", {
			tasks: [{ agent: "async_ops", prompt: "run async" }],
		});

		const backgroundId = result.details?.background[0];
		expect(backgroundId).toMatch(/^bg-/);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Background agent launched");
		await waitForBackgroundStatus(backgroundId!, "completed");
	});

	it("persists child session lineage to the parent session file", async () => {
		const root = join("/tmp", `pi-agent-tool-lineage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		tempRoots.push(root);
		const parentSessionManager = SessionManager.create(root, join(root, "parent-sessions"));
		const harness = await createHarness({ sessionManager: parentSessionManager });
		harnesses.push(harness);
		writeProjectAgent(
			harness,
			"lineage",
			`
name: lineage
description: Lineage check
tools: read
permissionMode: read-only
`,
		);
		harness.setResponses([fauxAssistantMessage("lineage done")]);

		const tool = createAgentTool({
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			parentSession: harness.session,
		});
		const result = await tool.execute("call-1", {
			tasks: [{ agent: "lineage", prompt: "check lineage", background: true }],
		});

		const task = result.details?.tasks[0];
		const childSessionFile = await waitForSessionFile(task!.registryId);
		const firstLine = readFileSync(childSessionFile, "utf-8").split("\n")[0];
		const header = JSON.parse(firstLine) as { parentSession?: string };
		expect(header.parentSession).toBe(harness.session.sessionFile);
		await waitForBackgroundStatus(task!.registryId, "completed");
	});
});
