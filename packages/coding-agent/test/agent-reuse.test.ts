import type { BackgroundProcessSnapshot } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import agentReuse, { reusableAgentContext } from "../../../extensions/agent-reuse.ts";

function snapshot(
	id: string,
	status: BackgroundProcessSnapshot["status"],
	parentId: string,
	overrides: Partial<BackgroundProcessSnapshot> = {},
): BackgroundProcessSnapshot {
	return {
		id,
		kind: "subagent",
		label: `reviewer · ${id}`,
		summary: `Review ${id}`,
		status,
		startedAt: 1,
		agentType: "reviewer",
		parentId,
		canKill: false,
		canSteer: true,
		logSize: 0,
		logTail: [],
		...overrides,
	};
}

describe("parked agent reuse", () => {
	it("lists only addressable idle and parked agents owned by this session", () => {
		const context = reusableAgentContext(
			[
				snapshot("parked", "parked", "parent"),
				snapshot("idle", "idle", "parent"),
				snapshot("running", "running", "parent"),
				snapshot("other-parent", "parked", "other"),
				snapshot("not-addressable", "parked", "parent", { canSteer: false }),
				snapshot("loop", "parked", "parent", { kind: "delegation" }),
			],
			"parent",
		);

		expect(context).toContain("id=parked type=reviewer status=parked");
		expect(context).toContain("id=idle type=reviewer status=idle");
		expect(context).not.toContain("id=running");
		expect(context).not.toContain("id=other-parent");
		expect(context).not.toContain("id=not-addressable");
		expect(context).not.toContain("id=loop");
		expect(context).toContain("Reuse is based on scope, not agent type alone");
	});

	it("does not inject context when no reusable agent exists", () => {
		expect(reusableAgentContext([snapshot("running", "running", "parent")], "parent")).toBeUndefined();
	});

	it("appends the reusable inventory as transient suffix context", async () => {
		let contextHandler: ((event: never, ctx: never) => Promise<unknown>) | undefined;
		agentReuse({
			on(event: string, handler: (event: never, ctx: never) => Promise<unknown>) {
				if (event === "context") contextHandler = handler;
			},
		} as never);
		const list = vi
			.spyOn((await import("@earendil-works/pi-coding-agent")).getBackgroundProcessRegistry(), "list")
			.mockReturnValue([snapshot("parked", "parked", "parent")]);

		const original = { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 };
		const result = (await contextHandler?.(
			{ messages: [original] } as never,
			{ sessionManager: { getSessionId: () => "parent" } } as never,
		)) as { messages: Array<{ content: Array<{ text: string }> }> };

		expect(result.messages[0]).toBe(original);
		expect(result.messages.at(-1)?.content[0].text).toContain("id=parked");
		list.mockRestore();
	});
});
