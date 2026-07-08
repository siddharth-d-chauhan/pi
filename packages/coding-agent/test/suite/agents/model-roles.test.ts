import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentModel } from "../../../src/core/agents/index.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("agent model roles", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function makeHarness() {
		const harness = await createHarness({
			models: [
				{ id: "faux-parent", name: "Parent", reasoning: true },
				{ id: "faux-small", name: "Small", reasoning: false },
				{ id: "faux-slow", name: "Slow", reasoning: true },
			],
			settings: {
				agents: {
					roles: {
						smol: ["faux-small"],
						slow: ["missing-model", "faux-slow"],
						review: ["pi/slow"],
						cycleA: ["pi/cycleB"],
						cycleB: ["pi/cycleA"],
					},
					modelOverrides: {
						Reviewer: "pi/review",
					},
				},
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it("inherits parent when spec is empty or role is unconfigured", async () => {
		const harness = await makeHarness();
		const parent = harness.getModel("faux-parent")!;

		expect(
			resolveAgentModel({
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}),
		).toEqual({ model: parent, inherited: true });
		expect(
			resolveAgentModel({
				spec: "pi/unconfigured",
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}),
		).toEqual({ model: parent, inherited: true });
	});

	it("resolves role chains, configured fallbacks, and per-agent overrides", async () => {
		const harness = await makeHarness();
		const parent = harness.getModel("faux-parent")!;
		const small = harness.getModel("faux-small")!;
		const slow = harness.getModel("faux-slow")!;

		expect(
			resolveAgentModel({
				spec: "pi/smol",
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}),
		).toEqual({ model: small, inherited: false });
		expect(
			resolveAgentModel({
				spec: "pi/slow",
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}),
		).toEqual({ model: slow, inherited: false });
		expect(
			resolveAgentModel({
				spec: "pi/smol",
				agentType: "reviewer",
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}),
		).toEqual({ model: slow, inherited: false });
	});

	it("resolves explicit provider/model and plain model ids", async () => {
		const harness = await makeHarness();
		const parent = harness.getModel("faux-parent")!;
		const small = harness.getModel("faux-small")!;

		expect(
			resolveAgentModel({
				spec: `${small.provider}/${small.id}`,
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}).model,
		).toMatchObject({ provider: small.provider, id: small.id });
		expect(
			resolveAgentModel({
				spec: "faux-small",
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}).model,
		).toMatchObject({ provider: small.provider, id: small.id });
	});

	it("detects role alias cycles", async () => {
		const harness = await makeHarness();
		const parent = harness.getModel("faux-parent")!;

		expect(() =>
			resolveAgentModel({
				spec: "pi/cycleA",
				parent,
				registry: harness.session.modelRegistry,
				settings: harness.settingsManager,
			}),
		).toThrow(/cycle/i);
	});
});
