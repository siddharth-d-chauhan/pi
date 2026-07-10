import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	ChainValidationError,
	parseChain,
	resolveChainInputs,
	runChain,
	splitForeachItems,
} from "../../../src/core/agents/chains.ts";
import type { AgentDefinition, AgentDefinitionRegistry } from "../../../src/core/agents/definitions.ts";
import { resetLifecycleForTests } from "../../../src/core/agents/lifecycle.ts";
import type { CreateChildSessionInput, CreateChildSessionResult, SpawnDeps } from "../../../src/core/agents/spawn.ts";
import { resetForTests as resetRegistry } from "../../../src/core/background-process-registry.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
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
		expect(result.stages.map((stage) => stage.verifyAttempts)).toEqual([0, 0]);
		expect(result.stages.map((stage) => stage.gateConfigured)).toEqual([false, false]);
		expect(result.stages.map((stage) => stage.gatePassed)).toEqual([undefined, undefined]);
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
		expect(result.stages[0]).toMatchObject({ gateConfigured: true, gateKind: "verify", gatePassed: true });
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

	it("named inputs: JSON object resolves, defaults apply, missing required throws", () => {
		const chainYaml = `
name: named
inputs:
  topic: { description: "what" }
  area: { default: "src" }
stages:
  - id: s
    agent: worker
    prompt: "{{inputs.topic}} in {{inputs.area}}"
`;
		const definition = parseChain(chainYaml, "named.yaml", "project");
		const resolved = resolveChainInputs(definition, '{"topic": "auth"}');
		expect(resolved.inputs).toEqual({ topic: "auth", area: "src" });
		expect(() => resolveChainInputs(definition, "")).toThrow(/missing required input/);
		expect(() => resolveChainInputs(definition, "")).toThrow(/topic/);
	});

	it("splitForeachItems: JSON arrays and line lists, capped", () => {
		expect(splitForeachItems('["a", "b"]', 10)).toEqual(["a", "b"]);
		expect(splitForeachItems("one\ntwo\n\nthree", 10)).toEqual(["one", "two", "three"]);
		expect(splitForeachItems("a\nb\nc", 2)).toEqual(["a", "b"]);
	});

	it("foreach fans out one spawn per item and combines results", async () => {
		const parent = await makeParent();
		const children = [await createHarness(), await createHarness(), await createHarness()];
		harnesses.push(...children);
		children[0].setResponses([fauxAssistantMessage("did alpha")]);
		children[1].setResponses([fauxAssistantMessage("did beta")]);
		children[2].setResponses([fauxAssistantMessage("did gamma")]);

		const chainYaml = `
name: fan
stages:
  - id: work
    agent: worker
    foreach: |
      alpha
      beta
      gamma
    prompt: "Handle: {{item}}"
`;
		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory(children, captured),
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "fan.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});

		expect(result.status).toBe("completed");
		expect(captured).toHaveLength(3);
		expect(result.stages[0].itemsTotal).toBe(3);
		expect(result.stages[0].itemsDone).toBe(3);
		expect(result.stages[0].inline).toContain("did alpha");
		expect(result.stages[0].inline).toContain("did gamma");
	});

	it("judge gate: FAIL verdict feeds back to the same agent, then passes", async () => {
		const parent = await makeParent();
		const worker = await createHarness();
		const judge1 = await createHarness();
		const judge2 = await createHarness();
		harnesses.push(worker, judge1, judge2);
		// Worker: first run, then the gate-feedback reply.
		worker.setResponses([fauxAssistantMessage("half-done work"), fauxAssistantMessage("now complete")]);
		judge1.setResponses([fauxAssistantMessage("VERDICT: FAIL — the work is superficial")]);
		judge2.setResponses([fauxAssistantMessage("VERDICT: PASS — looks real now")]);

		const chainYaml = `
name: judged
stages:
  - id: work
    agent: worker
    prompt: "Do it: {{input}}"
    judge: "Is the work real?"
    max_iters: 2
`;
		// Factory order: worker spawn, judge #1, judge #2 (delivery reuses the live worker).
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([worker, judge1, judge2]),
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "judged.yaml", "project"),
			input: "task",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});

		expect(result.status).toBe("completed");
		expect(result.stages[0].verifyAttempts).toBe(2);
		expect(result.stages[0]).toMatchObject({ gateConfigured: true, gateKind: "judge", gatePassed: true });
		expect(result.stages[0].inline).toContain("now complete");
	});

	it("records a final verify failure as a failed gate", async () => {
		const parent = await makeParent();
		const worker = await createHarness();
		harnesses.push(worker);
		worker.setResponses([fauxAssistantMessage("done")]);

		const chainYaml = `
name: verify-fails
stages:
  - id: work
    agent: worker
    prompt: "Do it"
    verify: "false"
    max_iters: 0
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([worker]),
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "verify-fails.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});

		expect(result.status).toBe("failed");
		expect(result.stages[0]).toMatchObject({
			status: "failed",
			verifyAttempts: 1,
			gateConfigured: true,
			gateKind: "verify",
			gatePassed: false,
		});
	});

	it("fails an unparseable judge verdict instead of accepting it as evidence", async () => {
		const parent = await makeParent();
		const worker = await createHarness();
		const judge = await createHarness();
		harnesses.push(worker, judge);
		worker.setResponses([fauxAssistantMessage("work complete")]);
		judge.setResponses([fauxAssistantMessage("I cannot determine a verdict.")]);

		const chainYaml = `
name: judge-unparseable
stages:
  - id: work
    agent: worker
    prompt: "Do it"
    judge: "Is the work real?"
    max_iters: 0
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([worker, judge]),
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "judge-unparseable.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});

		expect(result.status).toBe("failed");
		expect(result.stages[0]).toMatchObject({
			status: "failed",
			verifyAttempts: 1,
			gateConfigured: true,
			gateKind: "judge",
			gatePassed: false,
		});
	});

	it("budget: a zero runtime budget fails stages before spawning", async () => {
		const parent = await makeParent();
		const chainYaml = `
name: capped
stages:
  - id: one
    agent: worker
    prompt: p1
  - id: two
    agent: worker
    prompt: p2
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: async () => {
				throw new Error("should not spawn under a blown budget");
			},
		};

		const result = await runChain({
			definition: parseChain(chainYaml, "capped.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
			budgetUsd: 0,
		});

		expect(result.status).toBe("failed");
		expect(result.stages[0].status).toBe("failed");
		expect(result.stages[0].error).toContain("budget exhausted");
		expect(result.stages[1].status).toBe("skipped");
	});

	it("resume: seeded stages skip their spawns and feed interpolation", async () => {
		const parent = await makeParent();
		const buildChild = await createHarness();
		harnesses.push(buildChild);
		buildChild.setResponses([fauxAssistantMessage("built from seed")]);

		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([buildChild], captured),
		};

		const settled: string[] = [];
		const result = await runChain({
			definition: parseChain(VALID_CHAIN, "flow.yaml", "project"),
			input: "x",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["planner", "builder"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
			seedStages: { plan: { inline: "SEEDED PLAN" } },
			onStageSettled: (stage) => settled.push(`${stage.id}:${stage.status}`),
		});

		expect(result.status).toBe("completed");
		// Only the build stage spawned; the plan stage came from the seed.
		expect(captured).toHaveLength(1);
		expect(captured[0].customPrompt ?? "").not.toContain("Plan:");
		expect(result.stages[0].inline).toBe("SEEDED PLAN");
		expect(result.stages[1].inline).toContain("built from seed");
		expect(settled).toEqual(["build:completed"]);
	});

	it("interpolates inputs into verify commands", async () => {
		const parent = await makeParent();
		const child = await createHarness();
		harnesses.push(child);
		child.setResponses([fauxAssistantMessage("done")]);

		const cwd = makeTempDir("pi-chain-vcmd-");
		const chainYaml = `
name: vcmd
inputs:
  marker: { description: "file that must exist" }
stages:
  - id: work
    agent: worker
    prompt: "touch nothing: {{inputs.marker}}"
    verify: "test -e {{inputs.marker}}"
    max_iters: 0
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([child]),
		};

		// cwd itself exists, so verify "test -e <cwd>" passes only via interpolation.
		const result = await runChain({
			definition: parseChain(chainYaml, "vcmd.yaml", "project"),
			input: JSON.stringify({ marker: cwd }),
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd,
		});
		expect(result.status).toBe("completed");
	});

	it("serial foreach runs items one at a time", async () => {
		const parent = await makeParent();
		const children = [await createHarness(), await createHarness(), await createHarness()];
		harnesses.push(...children);
		for (const child of children) child.setResponses([fauxAssistantMessage("ok")]);

		let inFlight = 0;
		let maxInFlight = 0;
		let index = 0;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: async () => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				const child = children[index++];
				return {
					session: child.session,
					dispose: () => {
						inFlight -= 1;
					},
				};
			},
		};

		const chainYaml = `
name: ser
stages:
  - id: work
    agent: worker
    serial: true
    foreach: |
      a
      b
      c
    prompt: "do {{item}}"
`;
		const result = await runChain({
			definition: parseChain(chainYaml, "ser.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});
		expect(result.status).toBe("completed");
		expect(maxInFlight).toBe(1);
	});

	it("injects an anti-re-exploration digest of completed stages into later stages", async () => {
		const parent = await makeParent();
		const children = [await createHarness(), await createHarness(), await createHarness()];
		harnesses.push(...children);
		children[0].setResponses([fauxAssistantMessage("auth code lives in src/auth.ts (scout findings)")]);
		children[1].setResponses([fauxAssistantMessage("patched src/auth.ts")]);
		children[2].setResponses([fauxAssistantMessage("looks good")]);

		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory(children, captured),
		};
		const chainYaml = `
name: digest
stages:
  - id: scout
    agent: worker
    prompt: "find things"
  - id: fix
    agent: worker
    needs: [scout]
    prompt: "fix things"
  - id: review
    agent: worker
    needs: [fix]
    prompt: "review things"
`;
		const result = await runChain({
			definition: parseChain(chainYaml, "digest.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});
		expect(result.status).toBe("completed");
		// First stage: nothing to reuse yet.
		expect(captured[0]?.customPrompt).not.toContain("## CHAIN CONTEXT");
		// Second stage reuses scout's findings; third sees both.
		expect(captured[1]?.customPrompt).toContain("## CHAIN CONTEXT");
		expect(captured[1]?.customPrompt).toContain("do not re-explore");
		expect(captured[1]?.customPrompt).toContain("scout findings");
		expect(captured[2]?.customPrompt).toContain("### scout (worker)");
		expect(captured[2]?.customPrompt).toContain("### fix (worker)");
	});

	it("applies per-stage effort as the child thinking level", async () => {
		const parent = await makeParent();
		const child = await createHarness();
		harnesses.push(child);
		child.setResponses([fauxAssistantMessage("done")]);

		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: stagedFactory([child], captured),
		};
		const chainYaml = `
name: eff
stages:
  - id: think
    agent: worker
    effort: high
    prompt: p
`;
		expect(() =>
			parseChain(
				"name: bad\nstages:\n  - id: a\n    agent: worker\n    effort: turbo\n    prompt: p",
				"b.yaml",
				"project",
			),
		).toThrow(/effort must be one of/);
		const result = await runChain({
			definition: parseChain(chainYaml, "eff.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});
		expect(result.status).toBe("completed");
		expect(captured[0]?.thinkingLevel).toBe("high");
	});

	it("stage isolation: worktree forwards to spawn (fails clearly outside git)", async () => {
		// Parent cwd must NOT be a git repo, or spawn would create a real worktree.
		const parent = await createHarness({
			sessionManager: SessionManager.inMemory(makeTempDir("pi-chain-parent-")),
		});
		harnesses.push(parent);
		const chainYaml = `
name: iso
stages:
  - id: work
    agent: worker
    isolation: worktree
    prompt: p
`;
		const deps: SpawnDeps = {
			settingsManager: parent.settingsManager,
			modelRegistry: parent.session.modelRegistry,
			artifactDir: makeTempDir("pi-chain-artifacts-"),
			createChildSession: async () => {
				throw new Error("factory should not be reached");
			},
		};
		const result = await runChain({
			definition: parseChain(chainYaml, "iso.yaml", "project"),
			input: "",
			parent: { session: parent.session, depth: 0 },
			definitions: fakeRegistry(["worker"]),
			deps,
			cwd: makeTempDir("pi-chain-cwd-"),
		});
		expect(result.status).toBe("failed");
		expect(result.stages[0].error).toContain("git repository");
	});
});
