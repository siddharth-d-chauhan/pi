import type {
	BackgroundProcessSnapshot,
	ExtensionContext,
	ExtensionUICustomOptions,
} from "@earendil-works/pi-coding-agent";
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHubComponent,
	activityKind,
	activitySection,
	groupActivity,
	openHub,
} from "../../../extensions/agent-hub.ts";

const registeredIds: string[] = [];

afterEach(() => {
	for (const id of registeredIds.splice(0)) getBackgroundProcessRegistry().unregister(id);
});

function snapshot(
	id: string,
	kind: BackgroundProcessSnapshot["kind"],
	status: BackgroundProcessSnapshot["status"],
	startedAt: number,
): BackgroundProcessSnapshot {
	return {
		id,
		kind,
		label: id,
		status,
		startedAt,
		canKill: status === "running",
		canSteer: kind === "subagent",
		logSize: 0,
		logTail: [],
	};
}

describe("agent hub activity grouping", () => {
	it("uses the shared 40% bottom-drawer surface", async () => {
		let options: ExtensionUICustomOptions | undefined;
		const ctx = {
			ui: {
				custom: (_factory: unknown, customOptions: ExtensionUICustomOptions | undefined) => {
					options = customOptions;
					return Promise.resolve(undefined);
				},
			},
		} as unknown as ExtensionContext;

		await openHub(ctx);

		expect(options).toEqual({ drawer: { height: "40%" } });
	});

	it("maps registry states to Claude-style sections", () => {
		expect(activitySection(snapshot("running", "subagent", "running", 1))).toBe("working");
		expect(activitySection(snapshot("idle", "subagent", "idle", 1))).toBe("completed");
		expect(activitySection(snapshot("failed", "shell", "failed", 1))).toBe("completed");
		expect(
			activitySection({ ...snapshot("question", "subagent", "running", 1), inputRequest: "Which region?" }),
		).toBe("needs-input");
		expect(activitySection(snapshot("done", "shell", "completed", 1))).toBe("completed");
	});

	it("shows loop delegations as loops and keeps them in the agent filter", () => {
		const loop = {
			...snapshot("loop", "delegation", "parked", 5),
			label: "↻ orchestrate finish-auth",
		};

		expect(activityKind(loop)).toBe("loop");
		expect(groupActivity([loop], "agents").completed).toEqual([loop]);
		expect(groupActivity([loop], "processes")["needs-input"]).toEqual([]);
	});

	it("accepts a message while viewing agent detail", () => {
		const onSteer = vi.fn();
		const id = getBackgroundProcessRegistry().register({
			kind: "subagent",
			label: "reviewer",
			agentType: "reviewer",
			onSteer,
		});
		registeredIds.push(id);
		const component = new AgentHubComponent(
			{ requestRender: vi.fn() } as never,
			{} as never,
			new KeybindingsManager(TUI_KEYBINDINGS),
			vi.fn(),
		);

		component.handleInput("\r");
		component.handleInput("s");
		component.handleInput("Use the existing capability");
		component.handleInput("\r");

		expect(onSteer).toHaveBeenCalledWith("Use the existing capability");
		component.dispose();
	});

	it("filters agents and processes while keeping newest entries first", () => {
		const snapshots = [
			snapshot("old-agent", "subagent", "running", 1),
			snapshot("shell", "shell", "running", 3),
			snapshot("new-agent", "delegation", "running", 2),
			snapshot("done", "shell", "completed", 4),
		];

		expect(groupActivity(snapshots, "all").working.map((entry) => entry.id)).toEqual([
			"shell",
			"new-agent",
			"old-agent",
		]);
		expect(groupActivity(snapshots, "agents").working.map((entry) => entry.id)).toEqual(["new-agent", "old-agent"]);
		expect(groupActivity(snapshots, "processes").completed.map((entry) => entry.id)).toEqual(["done"]);
	});
});
