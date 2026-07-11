import { expect, test } from "vitest";
import evictionExt, { analyzeForEviction } from "../../../extensions/context-eviction.ts";

// --- dependency analysis -------------------------------------------------

const tc = (tool: string, path: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", toolName: tool, input: { path } }],
});

test("a read superseded by a later write to the same path is stale", () => {
	const messages = [
		tc("read", "src/a.ts"),
		tc("read", "src/b.ts"),
		tc("edit", "src/a.ts"), // supersedes the read of a.ts
	];
	const { staleReads, census } = analyzeForEviction(messages);
	expect(staleReads).toEqual(["src/a.ts"]);
	expect(census.reads).toBe(2);
	expect(census.writes).toBe(1);
});

test("a write BEFORE a read does not make the read stale", () => {
	const messages = [tc("write", "src/a.ts"), tc("read", "src/a.ts")];
	expect(analyzeForEviction(messages).staleReads).toEqual([]);
});

test("reads with no later write are not stale", () => {
	const messages = [tc("read", "src/a.ts"), tc("hread", "src/b.ts")];
	expect(analyzeForEviction(messages).staleReads).toEqual([]);
});

// --- compaction steering -------------------------------------------------

test("session_before_compact appends typed eviction guidance naming stale reads", async () => {
	const handlers: Array<(e: unknown) => Promise<unknown>> = [];
	const pi = {
		on(name: string, h: (e: unknown) => Promise<unknown>) {
			if (name === "session_before_compact") handlers.push(h);
		},
		registerCommand() {},
	};
	evictionExt(pi as never);

	const event = {
		preparation: {
			messagesToSummarize: [tc("read", "src/a.ts"), tc("edit", "src/a.ts")],
		},
		customInstructions: "prior steer",
	};
	await handlers[0](event);
	expect(event.customInstructions).toContain("prior steer"); // preserved
	expect(event.customInstructions).toContain("TYPED EVICTION");
	expect(event.customInstructions).toContain("src/a.ts"); // named as stale
});

test("empty compaction is a no-op that leaves instructions untouched", async () => {
	const handlers: Array<(e: unknown) => Promise<unknown>> = [];
	const pi = {
		on(name: string, h: (e: unknown) => Promise<unknown>) {
			if (name === "session_before_compact") handlers.push(h);
		},
		registerCommand() {},
	};
	evictionExt(pi as never);
	const event = { preparation: { messagesToSummarize: [] }, customInstructions: "x" };
	await handlers[0](event);
	expect(event.customInstructions).toBe("x");
});
