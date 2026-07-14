import { expect, test } from "vitest";
import planExtension from "../../../extensions/plan.ts";

test("a long mutation run receives one bounded hidden plan-reconciliation checkpoint", async () => {
	const handlers = new Map<string, (event: never, context: never) => Promise<unknown>>();
	let planTool:
		| {
				execute: (
					id: string,
					input: { tasks: Array<{ id: string; subject: string; status: string }> },
				) => Promise<unknown>;
		  }
		| undefined;
	planExtension({
		registerTool(tool: typeof planTool) {
			planTool = tool;
		},
		on(event: string, handler: (value: never, context: never) => Promise<unknown>) {
			handlers.set(event, handler);
		},
	} as never);
	if (!planTool) throw new Error("update_plan tool was not registered");

	await planTool.execute("plan-1", {
		tasks: [{ id: "implement", subject: "Implement the change", status: "in_progress" }],
	});
	const toolResult = handlers.get("tool_result");
	const context = handlers.get("context");
	if (!toolResult || !context) throw new Error("plan reconciliation handlers were not registered");
	for (let index = 0; index < 8; index += 1) {
		await toolResult({ toolName: "apply_patch", isError: false } as never, {} as never);
	}

	const result = (await context({ messages: [] } as never, {} as never)) as
		| { messages: Array<{ content: Array<{ text: string }> }> }
		| undefined;
	expect(result?.messages.at(-1)?.content[0]?.text).toContain("Plan checkpoint");
	expect(await context({ messages: [] } as never, {} as never)).toBeUndefined();
});
