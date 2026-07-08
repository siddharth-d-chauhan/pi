import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHandleStore } from "../../../src/core/agents/index.ts";
import { createAgentPullTool } from "../../../src/core/tools/index.ts";

describe("agent_pull tool", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const tempDir = join(tmpdir(), `pi-agent-pull-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	it("pulls spilled agent artifacts from the runtime artifact directory", async () => {
		const cwd = makeTempDir();
		const agentDir = join(cwd, "agent");
		const store = new AgentHandleStore({ artifactDir: join(agentDir, "artifacts"), inlineCapChars: 1 });
		store.capReturn("review", JSON.stringify({ summary: "ok", findings: [{ file: "a.ts" }] }));

		const tool = createAgentPullTool(cwd, agentDir);
		const result = await tool.execute("call-1", { ref: "agent://review/findings.0.file" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toBe("a.ts");
		expect(result.details).toEqual({ ref: "agent://review/findings.0.file" });
	});
});
