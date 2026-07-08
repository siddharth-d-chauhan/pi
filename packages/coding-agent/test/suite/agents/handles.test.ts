import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHandleStore, capReturn, pullHandle } from "../../../src/core/agents/index.ts";

describe("agent handles", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeArtifactDir(): string {
		const tempDir = join(tmpdir(), `pi-agent-handles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		return tempDir;
	}

	it("returns small outputs inline and spills large outputs to agent handles", () => {
		const artifactDir = makeArtifactDir();
		const small = capReturn("small", "short", { artifactDir, inlineCapChars: 10 });
		const large = capReturn("large", "abcdefghijklmnopqrstuvwxyz", { artifactDir, inlineCapChars: 8 });

		expect(small).toEqual({ inline: "short" });
		expect(large.handle).toBe("agent://large");
		expect(large.inline).toContain("agent output truncated");
		expect(pullHandle("agent://large", { artifactDir })).toBe("abcdefghijklmnopqrstuvwxyz");
	});

	it("pulls JSON subpaths from spilled structured output", () => {
		const store = new AgentHandleStore({ artifactDir: makeArtifactDir(), inlineCapChars: 1 });
		store.capReturn(
			"review",
			JSON.stringify({
				summary: "done",
				findings: [{ file: "a.ts", severity: "high" }],
			}),
		);

		expect(store.pull("agent://review/summary")).toBe("done");
		expect(store.pull("agent://review/findings.0.file")).toBe("a.ts");
		expect(store.pull("agent://review/findings.0")).toBe(JSON.stringify({ file: "a.ts", severity: "high" }, null, 2));
	});

	it("pulls regex windows from spilled text output", () => {
		const store = new AgentHandleStore({ artifactDir: makeArtifactDir(), inlineCapChars: 1 });
		store.capReturn("log", `alpha\n${"x".repeat(600)}\nERROR: failed\nomega`);

		const window = store.pull("agent://log?q=/ERROR: failed/");

		expect(window).toContain("ERROR: failed");
		expect(window.length).toBeLessThan(1_100);
	});
});
