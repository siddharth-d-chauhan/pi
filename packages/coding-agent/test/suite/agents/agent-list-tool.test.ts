import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentListTool, createTool, createToolDefinition } from "../../../src/core/tools/index.ts";
import { createHarness } from "../harness.ts";

describe("agent_list tool", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const tempDir = join(tmpdir(), `pi-agent-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	function writeAgent(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	it("searches loaded agent definitions without mutating the schema", async () => {
		const root = makeTempDir();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		writeAgent(
			join(cwd, ".pi", "agents", "ops.md"),
			`---
name: ops
description: Investigate operational incidents and runbooks
tools: read, grep
---
Ops prompt.
`,
		);

		const tool = createAgentListTool(cwd, agentDir);
		const result = await tool.execute("call-1", { q: "incident", limit: 5 });

		expect(result.content[0]?.type).toBe("text");
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("ops");
		expect(result.details?.agents).toHaveLength(1);
		expect(result.details?.agents[0]).toMatchObject({
			name: "ops",
			source: "project",
			tools: ["read", "grep"],
		});
	});

	it("includes package-provided agent definitions", async () => {
		const root = makeTempDir();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "package-agents");
		writeAgent(
			join(packageDir, "research.md"),
			`---
name: package_research
description: Package supplied research specialist
tools: read
---
Research prompt.
`,
		);

		const tool = createAgentListTool(cwd, agentDir, [packageDir]);
		const result = await tool.execute("call-1", { q: "package supplied", limit: 5 });

		expect(result.details?.agents).toHaveLength(1);
		expect(result.details?.agents[0]).toMatchObject({
			name: "package_research",
			source: "package",
		});
	});

	it("is active by default and remains allowlist controlled", async () => {
		const defaultHarness = await createHarness();
		const restrictedHarness = await createHarness({ allowedToolNames: ["read"] });
		try {
			expect(defaultHarness.session.getActiveToolNames()).toContain("agent_list");
			expect(defaultHarness.session.getActiveToolNames()).toContain("agent_pull");
			expect(defaultHarness.session.getAllTools().map((tool) => tool.name)).toContain("agent_list");
			expect(defaultHarness.session.getAllTools().map((tool) => tool.name)).toContain("agent_pull");
			expect(restrictedHarness.session.getActiveToolNames()).toEqual(["read"]);
			expect(restrictedHarness.session.getAllTools().map((tool) => tool.name)).toEqual(["read"]);
		} finally {
			defaultHarness.cleanup();
			restrictedHarness.cleanup();
		}
	});

	it("creates a safe unavailable agent tool without an AgentSession context", async () => {
		const definition = createToolDefinition("agent", "/tmp");
		const tool = createTool("agent", "/tmp");

		expect(definition.name).toBe("agent");
		expect(definition.description).toContain("unavailable");
		await expect(tool.execute("call-1", { tasks: [] })).rejects.toThrow(/AgentSession context/);
	});
});
