import { beforeAll, expect, test } from "vitest";
import { analyzeForEviction } from "../../../extensions/context-eviction.ts";

// --- dependency analysis (pure) ------------------------------------------

const tc = (tool: string, path: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", toolName: tool, input: { path } }],
});

test("a read superseded by a later write to the same path is stale", () => {
	const messages = [tc("read", "src/a.ts"), tc("read", "src/b.ts"), tc("edit", "src/a.ts")];
	const { staleReads, census } = analyzeForEviction(messages);
	expect(staleReads).toEqual(["src/a.ts"]);
	expect(census.reads).toBe(2);
	expect(census.writes).toBe(1);
});

test("a write BEFORE a read does not make the read stale", () => {
	expect(analyzeForEviction([tc("write", "src/a.ts"), tc("read", "src/a.ts")]).staleReads).toEqual([]);
});

// --- working compaction-steering mechanism -------------------------------

type Handler = (e: unknown, ctx: unknown) => Promise<{ cancel?: boolean } | undefined>;
let mod: { default: (pi: never) => void };

beforeAll(async () => {
	process.env.KP_EVICTION = "1"; // opt-in — enable before import
	mod = (await import("../../../extensions/context-eviction.ts")) as never;
});

function wire() {
	const handlers: Handler[] = [];
	const compactCalls: Array<{ customInstructions?: string }> = [];
	const pi = {
		on(name: string, h: Handler) {
			if (name === "session_before_compact") handlers.push(h);
		},
		registerCommand() {},
	};
	mod.default(pi as never);
	const ctx = { compact: (opts: { customInstructions?: string }) => compactCalls.push(opts) };
	return { fire: (event: unknown) => handlers[0](event, ctx), compactCalls };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("blind compaction is cancelled and re-triggered with typed instructions naming stale reads", async () => {
	const { fire, compactCalls } = wire();
	const event = {
		preparation: { messagesToSummarize: [tc("read", "src/a.ts"), tc("edit", "src/a.ts")] },
	};
	const r = await fire(event);
	expect(r).toEqual({ cancel: true }); // pi's blind compaction cancelled
	await tick(); // the re-trigger is deferred
	expect(compactCalls.length).toBe(1);
	expect(compactCalls[0].customInstructions).toContain("TYPED EVICTION");
	expect(compactCalls[0].customInstructions).toContain("src/a.ts"); // named as stale
});

test("our own re-triggered compaction passes through (no infinite loop)", async () => {
	const { fire } = wire();
	// first call flips steering=true and cancels
	await fire({ preparation: { messagesToSummarize: [tc("read", "a.ts"), tc("edit", "a.ts")] } });
	// the re-triggered compaction's before-hook must NOT cancel again
	const second = await fire({ preparation: { messagesToSummarize: [tc("read", "a.ts"), tc("edit", "a.ts")] } });
	expect(second).toBeUndefined();
});

test("fail-open: no messages, or a user's /compact instructions, leaves pi's compaction untouched", async () => {
	const { fire, compactCalls } = wire();
	expect(await fire({ preparation: { messagesToSummarize: [] } })).toBeUndefined();
	expect(
		await fire({ preparation: { messagesToSummarize: [tc("read", "a.ts")] }, customInstructions: "user said X" }),
	).toBeUndefined();
	await tick();
	expect(compactCalls.length).toBe(0); // never re-triggered in these cases
});
