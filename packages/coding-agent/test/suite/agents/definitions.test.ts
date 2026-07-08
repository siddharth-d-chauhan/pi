import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	canOmitProjectContext,
	formatAgentDefinitionsForPrompt,
	isReadOnlyToolSet,
	loadAgentDefinitions,
} from "../../../src/core/agents/index.ts";

describe("agent definitions", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const tempDir = join(tmpdir(), `pi-agent-defs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	function writeAgent(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	it("loads project, user, package, and bundled definitions with first-wins precedence", () => {
		const root = makeTempDir();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const packageDir = join(root, "pkg-agents");

		writeAgent(
			join(cwd, ".pi", "agents", "Reviewer.md"),
			`---
name: Reviewer
description: Project reviewer
tools: read, grep
unknownField: ignored
---
Review from project.
`,
		);
		writeAgent(
			join(agentDir, "agents", "reviewer.md"),
			`---
name: reviewer
description: User reviewer
---
Review from user.
`,
		);
		writeAgent(
			join(packageDir, "research.md"),
			`---
name: research
description: Package research
tools:
  - read
  - find
---
Research prompt.
`,
		);

		const registry = loadAgentDefinitions({ cwd, agentDir, packageAgentDirs: [packageDir] });

		expect(registry.get("reviewer")?.description).toBe("Project reviewer");
		expect(registry.get("REVIEWER")?.systemPrompt).toBe("Review from project.");
		expect(registry.get("research")?.source).toBe("package");
		expect(registry.get("worker")?.source).toBe("bundled");
		expect(registry.diagnostics.some((diagnostic) => diagnostic.message.includes("unknownField"))).toBe(true);
		expect(registry.diagnostics.some((diagnostic) => diagnostic.message.includes("already defined"))).toBe(true);
	});

	it("parses frontmatter fields and skips malformed user files", () => {
		const root = makeTempDir();
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");

		writeAgent(
			join(cwd, ".pi", "agents", "ops.md"),
			`---
name: ops
description: Ops workflow
tools: "*"
disallowedTools:
  - write
permissionMode: bubble
spawns: explore, reviewer
model: pi/slow
thinkingLevel: high
maxTurns: 12
background: true
isolation: worktree
omitProjectContext: true
output:
  type: object
color: cyan
---
Ops prompt.
`,
		);
		writeAgent(
			join(agentDir, "agents", "bad.md"),
			`---
name: bad
description: [broken
---
Bad prompt.
`,
		);

		const registry = loadAgentDefinitions({ cwd, agentDir });
		const ops = registry.get("ops");

		expect(ops).toMatchObject({
			name: "ops",
			description: "Ops workflow",
			tools: "*",
			disallowedTools: ["write"],
			permissionMode: "bubble",
			spawns: ["explore", "reviewer"],
			model: "pi/slow",
			thinkingLevel: "high",
			maxTurns: 12,
			background: true,
			isolation: "worktree",
			omitProjectContext: true,
			color: "cyan",
		});
		expect(ops?.output).toEqual({ type: "object" });
		expect(registry.get("bad")).toBeUndefined();
		expect(registry.diagnostics.some((diagnostic) => diagnostic.path?.endsWith("bad.md"))).toBe(true);
	});

	it("formats a bounded prompt roster and gates omitProjectContext", () => {
		const registry = loadAgentDefinitions({ cwd: makeTempDir(), agentDir: makeTempDir() });
		const definitions = registry.list();
		const prompt = formatAgentDefinitionsForPrompt(definitions, 2);

		expect(prompt).toContain("Available subagents:");
		expect(prompt).toContain("more available via agent_list");
		expect(canOmitProjectContext(registry.get("explore")!)).toBe(true);
		expect(canOmitProjectContext(registry.get("worker")!)).toBe(false);
		expect(isReadOnlyToolSet(["read", "grep"], undefined)).toBe(true);
		expect(isReadOnlyToolSet(["read", "write"], undefined)).toBe(false);
		expect(isReadOnlyToolSet([], undefined)).toBe(true);
		expect(isReadOnlyToolSet(["read"], ["read"])).toBe(true);
	});
});
