import { expect, test } from "vitest";
import { compactKnowledgeContextEpochs } from "../../../extensions/context-broker.ts";

function packetResult(id: string, epoch: number, workFrame: string, padding = "") {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: epoch === 1 ? "pi_context_task" : "pi_context_shift",
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					packet_id: id,
					epoch,
					work_frame_id: workFrame,
					candidates: [{ memory: { text: `fact-${id}${padding}` } }],
				}),
			},
		],
		details: {},
		isError: false,
		timestamp: epoch,
	};
}

test("only the newest KP task epoch remains active while old tool results stay paired", () => {
	const oldPacket = packetResult("packet-old", 1, "wf-old", "x".repeat(8_000));
	const currentPacket = packetResult("packet-current", 2, "wf-current");
	const unrelated = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "continue" }],
		timestamp: 3,
	};
	const result = compactKnowledgeContextEpochs([oldPacket, currentPacket, unrelated]);

	expect(result.superseded).toBe(1);
	expect(result.activeEpoch).toBe(2);
	expect(result.charsRemoved).toBeGreaterThan(7_000);
	const replaced = result.messages[0];
	expect(replaced.role).toBe("toolResult");
	if (replaced.role !== "toolResult") throw new Error("old packet lost its tool-result role");
	expect(replaced.toolCallId).toBe("packet-old");
	expect(replaced.content[0]?.type === "text" ? replaced.content[0].text : "").toContain(
		"use active epoch 2, WorkFrame wf-current",
	);
	expect(result.messages[1]).toEqual(currentPacket);
	expect(result.messages[2]).toEqual(unrelated);
});

test("a single current packet is left byte-identical", () => {
	const packet = packetResult("only", 4, "wf-current");
	const messages = [packet];
	const result = compactKnowledgeContextEpochs(messages);
	expect(result).toMatchObject({ messages, superseded: 0, charsRemoved: 0 });
	expect(result.messages).toBe(messages);
});

test("the broker's current WorkFrame wins over a later stale packet", () => {
	const current = packetResult("current", 3, "wf-current");
	const stale = packetResult("late-stale", 2, "wf-old");
	const result = compactKnowledgeContextEpochs([current, stale], { workFrameId: "wf-current", epoch: 3 });

	expect(result.activeEpoch).toBe(3);
	expect(result.messages[0]).toEqual(current);
	const replaced = result.messages[1];
	expect(
		replaced.role === "toolResult" && replaced.content[0]?.type === "text" ? replaced.content[0].text : "",
	).toContain("use active epoch 3, WorkFrame wf-current");
});
