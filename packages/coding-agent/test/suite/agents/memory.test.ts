import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatMemorySection, loadAgentMemory } from "../../../src/core/agents/memory.ts";

describe("agent memory", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pi-agent-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		return dir;
	}

	function writeMemory(path: string, content: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	it("returns undefined for a missing memory file", () => {
		const root = makeTempDir();
		const memory = loadAgentMemory({
			agentType: "reviewer",
			scope: "user",
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});
		expect(memory).toBeUndefined();
	});

	it("returns undefined for an empty/whitespace-only memory file", () => {
		const root = makeTempDir();
		writeMemory(join(root, "agent", "agent-memory", "reviewer", "MEMORY.md"), "  \n\n\t\n");
		const memory = loadAgentMemory({
			agentType: "reviewer",
			scope: "user",
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});
		expect(memory).toBeUndefined();
	});

	it("round-trips user-scope memory content", () => {
		const root = makeTempDir();
		const filePath = join(root, "agent", "agent-memory", "reviewer", "MEMORY.md");
		writeMemory(filePath, "\n- prefer tabs\n- run biome before returning\n");

		const memory = loadAgentMemory({
			agentType: "reviewer",
			scope: "user",
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		expect(memory).toBeDefined();
		expect(memory?.content).toBe("- prefer tabs\n- run biome before returning");
		expect(memory?.filePath).toBe(filePath);
		expect(memory?.scope).toBe("user");
	});

	it("reads project-scope memory from <cwd>/.pi/agent-memory", () => {
		const root = makeTempDir();
		const filePath = join(root, "project", ".pi", "agent-memory", "planner", "MEMORY.md");
		writeMemory(filePath, "project notes\n");

		const memory = loadAgentMemory({
			agentType: "planner",
			scope: "project",
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		expect(memory?.content).toBe("project notes");
		expect(memory?.filePath).toBe(filePath);
		expect(memory?.scope).toBe("project");
	});

	it("truncates from the front at the cap, keeping newest content", () => {
		const root = makeTempDir();
		const oldest = `OLDEST ${"x".repeat(6000)}`;
		const newest = `NEWEST ${"y".repeat(6000)}`;
		writeMemory(join(root, "agent", "agent-memory", "reviewer", "MEMORY.md"), `${oldest}\n${newest}`);

		const memory = loadAgentMemory({
			agentType: "reviewer",
			scope: "user",
			cwd: join(root, "project"),
			agentDir: join(root, "agent"),
		});

		expect(memory).toBeDefined();
		const content = memory?.content ?? "";
		expect(content.length).toBeLessThanOrEqual(8000);
		expect(content.startsWith("…earlier memory truncated…")).toBe(true);
		expect(content).not.toContain("OLDEST");
		expect(content.endsWith(newest)).toBe(true);
	});

	it("formatMemorySection includes the write-back instruction only when canWrite", () => {
		const memory = {
			content: "- remembered fact",
			filePath: "/home/user/.pi/agent/agent-memory/reviewer/MEMORY.md",
			scope: "user" as const,
		};

		const readOnly = formatMemorySection(memory, false);
		expect(readOnly).toContain("## MEMORY (persistent)");
		expect(readOnly).toContain("- remembered fact");
		expect(readOnly).not.toContain("write/edit tools");

		const writable = formatMemorySection(memory, true);
		expect(writable).toContain("## MEMORY (persistent)");
		expect(writable).toContain("- remembered fact");
		expect(writable).toContain(memory.filePath);
		expect(writable).toContain("write/edit tools");
		expect(writable).toContain("prune stale entries");
	});
});
