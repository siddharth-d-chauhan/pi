import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ChainValidationError, parseChain, runChain } from "../../../src/core/agents/chains.ts";
import type { AgentDefinition, AgentDefinitionRegistry } from "../../../src/core/agents/definitions.ts";
import { resetLifecycleForTests } from "../../../src/core/agents/lifecycle.ts";
import type { CreateChildSessionInput, CreateChildSessionResult, SpawnDeps } from "../../../src/core/agents/spawn.ts";
import { resetForTests as resetRegistry } from "../../../src/core/background-process-registry.ts";
import { createHarness, type Harness } from "../harness.ts";

function makeDefinition(name: string): AgentDefinition {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: `You are ${name}.`,
		tools: ["read"],
		spawns: "none",
		model: "pi/smol",
		thinkingLevel: "off",
		maxTurns: 5,
		background: false,
		isolation: "none",
		omitProjectContext: true,
		source: "bundled",
		permissionMode: "read-only",
	} as AgentDefinition;
}

function fakeRegistry(names: string[]): AgentDefinitionRegistry {
	const map = new Map(names.map((name) => [name, makeDefinition(name)]));
	return {
		get: (name) => map.get(name.toLowerCase()),
		list: () => [...map.values()],
		diagnostics: [],
	};
}

const VALID_CHAIN = `
name: flow
description: two stages
stages:
  - id: plan
    agent: planner
    prompt: "Plan: {{input}}"
  - id: build
    agent: builder
    prompt: "Build from: {{plan.result}}"
`;

describe("parseChain", () => {
	it("parses a valid chain with sequential default needs", () => {
		const chain = parseChain(VALID_CHAIN, "flow.yaml", "project");
		expect(chain.name).toBe("flow");
		expect(chain.stages.map((stage) => stage.id)).toEqual(["plan", "build"]);
		expect(chain.stages[0].needs).toEqual([]);
		expect(chain.stages[1].needs).toEqual(["plan"]);
		expect(chain.stages[1].maxIters).toBe(2);
		expect(chain.stages[1].onFail).toBe("stop");
	});

	it("rejects duplicate stage ids", () => {
		const bad = VALID_CHAIN.replace("id: build", "id: plan");
		expect(() => parseChain(bad, "flow.yaml", "project")).toThrow(ChainValidationError);
		expect(() => parseChain(bad, "flow.yaml", "project")).toThrow(/duplicate stage id/);
	});

	it("rejects unknown needs", () => {
		const bad = `${VALID_CHAIN}    needs: [ghost]\n`;
		expect(() => parseChain(bad, "flow.yaml", "project")).toThrow(/unknown stage "ghost"/);
	});

	it("rejects dependency cycles", () => {
		const bad = `
name: loop
stages:
  - id: a
    agent: x
    prompt: p
    needs: [b]
  - id: b
    agent: x
    prompt: p
    needs: [a]
`;
		expect(() => parseChain(bad, "loop.yaml", "project")).toThrow(/cycle/);
	});
});

describe("runChain", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		resetLifecycleForTests();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
		resetRegistry();
	});

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	async function makeParent(): Promise<Harness> {
		const parent = await createHarness();
		harnesses.push(parent);
		return parent;
	}

	/** Factory that hands out pre-configured child harnesses in call order. */
	function stagedFactory(children: Harness[], captured: CreateChildSessionInput[] = []) {
		let index = 0;
		return async (input: CreateChildSessionInput): Promise<CreateChildSessionResult> => {
			captured.push(input);
			const child = children[index++];
			if (!child) throw new Error("factory exhausted");
			return { session: child.session, dispose: () => {} };
		};
	}

	it("runs stages sequentially and interpolates prior results", async () => {
		const parent = await makeParent();
		const planChild = await createHarness();
		const buildChild = await createHarness();
		harnesses.push(planChild, buildChild);
		planChild.setResponses([fauxAssistantMessage("THE PLAN: do X")]);
		buildChild.setResponses([fauxAssistantMessage("built it")]);

		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([planChild, buildChild], captured),
		};

		const updates: string[][] = [];
		const result = await runChain({
			definition: parseChain(VALID_CHAIN, "flow.yaml", "project"),
			input: "ship feature",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["planner", "builder"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
			onUpdate: (stages) => updates.push(stages.map((stage) => `${stage.id}:${stage.status}`)),
		});

		expect(result.status).toBe("completed");
		expect(result.stages.map((stage) => stage.status)).toEqual(["completed", "completed"]);
		expect(result.stages[1].inline).toContain("built it");
		// {{input}} and {{plan.result}} interpolation reached the children.
		expect(captured).toHaveLength(2);
		expect(updates.at(-1)).toEqual(["plan:completed", "build:completed"]);
	});

	it("stops the chain and skips dependents when a stage fails (on_fail: stop)", async () => {
		const parent = await makeParent();
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: async () => {
				throw new Error("boom: provider down");
			},
		};

		const result = await runChain({
			definition: parseChain(VALID_CHAIN, "flow.yaml", "project"),
			input: "x",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["planner", "builder"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});

		expect(result.status).toBe("failed");
		expect(result.stages[0].status).toBe("failed");
		expect(result.stages[0].error).toContain("boom");
		expect(result.stages[1].status).toBe("skipped");
	});

	it("feeds verify failures back to the SAME agent and passes on retry", async () => {
		const parent = await makeParent();
		const child = await createHarness();
		harnesses.push(child);
		// First response: the stage run. Second: the verify-feedback delivery reply.
		child.setResponses([fauxAssistantMessage("first attempt"), fauxAssistantMessage("fixed it")]);

		const cwd = makeTempDir("pi-chain-verify-");
		const marker = join(cwd, "marker");
		// Fails on first run (creates the marker), passes on the second.
		const chainYaml = `
name: verified
stages:
  - id: work
    agent: worker
    prompt: "Do the thing: {{input}}"
    verify: "test -f ${marker} || { touch ${marker}; exit 1; }"
    max_iters: 2
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([child]),
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "verified.yaml", "project"),
			input: "task",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd,
		});

		expect(result.status).toBe("completed");
		expect(result.stages[0].verifyAttempts).toBe(2);
		expect(result.stages[0].inline).toContain("fixed it");
		expect(existsSync(marker)).toBe(true);
	});

	it("runs independent stages in the same wave in parallel", async () => {
		const parent = await makeParent();
		const childA = await createHarness();
		const childB = await createHarness();
		harnesses.push(childA, childB);
		childA.setResponses([fauxAssistantMessage("A done")]);
		childB.setResponses([fauxAssistantMessage("B done")]);

		const chainYaml = `
name: par
stages:
  - id: a
    agent: worker
    prompt: pa
    needs: []
  - id: b
    agent: worker
    prompt: pb
    needs: []
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([childA, childB]),
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "par.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});

		expect(result.status).toBe("completed");
		expect(result.stages.map((stage) => stage.status)).toEqual(["completed", "completed"]);
	});
});
