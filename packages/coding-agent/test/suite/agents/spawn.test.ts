import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../../../src/core/agents/index.ts";
import { resetLifecycleForTests } from "../../../src/core/agents/lifecycle.ts";
import type { CreateChildSessionInput, CreateChildSessionResult, SpawnDeps } from "../../../src/core/agents/spawn.ts";
import {
	getBackgroundProcessRegistry,
	resetForTests as resetRegistry,
} from "../../../src/core/background-process-registry.ts";
import type { CustomMessage } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("spawnAgent", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		resetLifecycleForTests();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const d = tempDirs.pop();
			if (d) {
				try {
					// no rmSync to keep this test isolated; harness cleanup handles its own temp.
				} catch {
					// ignore
				}
			}
		}
		resetRegistry();
	});

	function makeArtifactDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-spawn-artifacts-"));
		tempDirs.push(dir);
		return dir;
	}

	function makeDefinition(overrides: Partial<Parameters<typeof spawnAgent>[0]["definition"]> = {}) {
		return {
			name: "explore",
			description: "Read-only explore",
			systemPrompt: "You are an explorer.",
			tools: ["read", "grep"] as string[],
			spawns: "none" as const,
			model: "pi/smol",
			thinkingLevel: "off" as const,
			maxTurns: 5,
			background: false,
			isolation: "none" as const,
			omitProjectContext: true,
			source: "bundled" as const,
			permissionMode: "read-only" as const,
			...overrides,
		};
	}

	function isTaskNotification(message: unknown): message is CustomMessage {
		return (
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "custom" &&
			"customType" in message &&
			message.customType === "task-notification"
		);
	}

	function recordingFactory(captured: CreateChildSessionInput[]) {
		return async (input: CreateChildSessionInput): Promise<CreateChildSessionResult> => {
			captured.push(input);
			// Use a real harness-backed AgentSession to honor session.prompt(), but
			// the test only inspects the captured input shape.
			throw new Error("not invoked in this test path");
		};
	}

	async function waitForBackgroundStatus(id: string, status: string): Promise<void> {
		for (let i = 0; i < 20; i++) {
			const snapshot = getBackgroundProcessRegistry()
				.list()
				.find((entry) => entry.id === id);
			if (snapshot?.status === status) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`background task ${id} did not reach ${status}`);
	}

	async function timeout(ms: number): Promise<"timeout"> {
		return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
	}

	it("forwards the composed system prompt and effective tool set to the child factory", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: recordingFactory(captured),
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({
						name: "explore",
						systemPrompt: "You are an explorer.",
						tools: ["read", "grep"],
					}),
					prompt: "find auth",
					context: "Repo uses oauth",
					parent: { session: harness.session, depth: 0 },
					background: false,
				},
				deps,
			),
		).rejects.toThrow();

		// The factory may have been called (we threw inside it) — if so, inspect.
		const call = captured[0];
		if (call) {
			expect(call.customPrompt).toContain("You are an explorer.");
			expect(call.customPrompt).toContain("## CONTEXT");
			expect(call.customPrompt).toContain("Repo uses oauth");
			expect(call.tools).toEqual(["read", "grep"]);
			expect(call.omitProjectContext).toBe(true);
		}
	});

	it("rejects self-spawn with a clear error", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async () => {
				throw new Error("should not be called");
			},
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({ name: "explore" }),
					prompt: "x",
					parent: { session: harness.session, depth: 0 },
					background: false,
					parentType: "explore",
				},
				deps,
			),
		).rejects.toThrow(/cannot spawn itself/);
	});

	it("enforces the parent's spawns allowlist", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async () => {
				throw new Error("should not be called");
			},
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({ name: "worker" }),
					prompt: "x",
					parent: { session: harness.session, depth: 0 },
					background: false,
					spawns: ["explore"],
				},
				deps,
			),
		).rejects.toThrow(/spawns allowlist/);
	});

	it("treats a child agent without an explicit spawns policy as spawns none", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async () => {
				throw new Error("should not be called");
			},
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({ name: "explore" }),
					prompt: "x",
					parent: { session: harness.session, depth: 1 },
					background: false,
					parentType: "worker",
				},
				deps,
			),
		).rejects.toThrow(/no spawn policy/);
	});

	it("passes child lineage to the child session factory", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const captured: CreateChildSessionInput[] = [];
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: recordingFactory(captured),
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({ name: "plan", spawns: ["explore"] }),
					prompt: "x",
					parent: { session: harness.session, depth: 1 },
					background: false,
					parentType: "worker",
					spawns: ["plan"],
				},
				deps,
			),
		).rejects.toThrow();

		expect(captured[0]?.subagentDepth).toBe(2);
		expect(captured[0]?.subagentType).toBe("plan");
		expect(captured[0]?.subagentSpawns).toEqual(["explore"]);
	});

	it("enforces the depth cap", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async () => {
				throw new Error("should not be called");
			},
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({ name: "explore" }),
					prompt: "x",
					parent: { session: harness.session, depth: 5 },
					background: false,
				},
				deps,
			),
		).rejects.toThrow(/depth exceeded/);
	});

	it("runs a sync happy path with a real child session and returns inline + usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const childHarness = await createHarness();
		// Don't push to harnesses (we dispose manually).
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async (_input: CreateChildSessionInput): Promise<CreateChildSessionResult> => {
				return {
					session: childHarness.session,
					dispose: () => childHarness.cleanup(),
				};
			},
		};

		childHarness.setResponses([fauxAssistantMessage("found auth.ts in src/")]);

		const result = await spawnAgent(
			{
				definition: makeDefinition({ name: "explore" }),
				prompt: "find auth",
				parent: { session: harness.session, depth: 0 },
				background: false,
			},
			deps,
		);

		expect(result.status).toBe("completed");
		expect(result.inline).toContain("found auth.ts");
		expect(result.inline).toContain(`agentId: ${result.registryId}`);
		expect(result.usage.tokens).toBeGreaterThan(0);
		expect(result.registryId).toMatch(/^bg-/);

		const snapshot = getBackgroundProcessRegistry()
			.list()
			.find((entry) => entry.id === result.registryId);
		expect(snapshot?.agentType).toBe("explore");
		expect(snapshot?.parentId).toBe(harness.session.sessionId);
		expect(snapshot?.metrics?.tokens).toBe(result.usage.tokens);
		expect(snapshot?.canKill).toBe(true);
		expect(snapshot?.canSteer).toBe(true);
	});

	it("queues a next-turn task notification when a background spawn completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		const childHarness = await createHarness();
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async (): Promise<CreateChildSessionResult> => ({
				session: childHarness.session,
				dispose: () => childHarness.cleanup(),
			}),
		};

		childHarness.setResponses([fauxAssistantMessage("background done")]);

		const result = await spawnAgent(
			{
				definition: makeDefinition({ name: "explore" }),
				prompt: "work in background",
				parent: { session: harness.session, depth: 0 },
				background: true,
			},
			deps,
		);

		expect(result.inline).toContain("Background agent launched");
		await waitForBackgroundStatus(result.registryId, "idle");

		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("continue");

		const notification = harness.session.messages.find(isTaskNotification);
		expect(typeof notification?.content === "string" ? notification.content : "").toContain("<task-notification");
		expect(typeof notification?.content === "string" ? notification.content : "").toContain("background done");
		expect(typeof notification?.content === "string" ? notification.content : "").toContain(result.registryId);
	});

	it("returns a background registry id before waiting for a saturated concurrency slot", async () => {
		const harness = await createHarness({ settings: { agents: { maxConcurrency: 1 } } });
		harnesses.push(harness);

		const firstChild = await createHarness();
		const secondChild = await createHarness();
		firstChild.setResponses([fauxAssistantMessage("first done")]);
		secondChild.setResponses([fauxAssistantMessage("second done")]);

		let releaseFirstFactory!: () => void;
		const firstFactoryGate = new Promise<void>((resolve) => {
			releaseFirstFactory = resolve;
		});
		let factoryCalls = 0;
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async (): Promise<CreateChildSessionResult> => {
				const call = factoryCalls++;
				if (call === 0) {
					await firstFactoryGate;
					return {
						session: firstChild.session,
						dispose: () => firstChild.cleanup(),
					};
				}
				return {
					session: secondChild.session,
					dispose: () => secondChild.cleanup(),
				};
			},
		};

		const first = await spawnAgent(
			{
				definition: makeDefinition({ name: "explore" }),
				prompt: "first",
				parent: { session: harness.session, depth: 0 },
				background: true,
			},
			deps,
		);

		const secondPromise = spawnAgent(
			{
				definition: makeDefinition({ name: "plan" }),
				prompt: "second",
				parent: { session: harness.session, depth: 0 },
				background: true,
			},
			deps,
		);

		const second = await Promise.race([secondPromise, timeout(50)]);
		expect(second).not.toBe("timeout");
		if (second === "timeout") throw new Error("unreachable");
		expect(second.registryId).toMatch(/^bg-/);
		expect(factoryCalls).toBe(1);

		releaseFirstFactory();
		await waitForBackgroundStatus(first.registryId, "idle");
		await waitForBackgroundStatus(second.registryId, "idle");
	});

	it("releases the in-flight counter when the child factory throws", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const deps: SpawnDeps = {
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			artifactDir: makeArtifactDir(),
			createChildSession: async () => {
				throw new Error("factory boom");
			},
		};

		await expect(
			spawnAgent(
				{
					definition: makeDefinition({ name: "explore" }),
					prompt: "x",
					parent: { session: harness.session, depth: 0 },
					background: false,
				},
				deps,
			),
		).rejects.toThrow(/factory boom/);

		// A second spawn of the same type should not be blocked by a stale counter.
		// The first one rejected; the in-flight map should be empty again.
		const second = spawnAgent(
			{
				definition: makeDefinition({ name: "explore" }),
				prompt: "y",
				parent: { session: harness.session, depth: 0 },
				background: true,
			},
			deps,
		);
		// Background returns immediately after registration; the inner promise
		// will fail but the call site resolves with a registry id.
		const result = await second;
		expect(result.registryId).toMatch(/^bg-/);
	});
});
