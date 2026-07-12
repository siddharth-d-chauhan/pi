import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { loopPanelModel } from "../../../extensions/loop.ts";

// The pure data model behind the live /loop panel — what the drawer renders.
// (The TUI component itself needs a live session to verify; this locks the data.)

let root: string;
beforeEach(() => {
	root = join(tmpdir(), `panel-${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(slug: string, state: object, criteria: object[]) {
	const dir = join(root, ".pi", "loops", slug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify(state));
	writeFileSync(join(dir, "criteria.json"), JSON.stringify(criteria));
}

test("no loops dir → empty model", () => {
	expect(loopPanelModel(root)).toEqual([]);
});

test("reads a loop's state, criteria (passes), and verdicts", () => {
	seed(
		"my_goal",
		{
			goal: "my real goal",
			status: "completed",
			round: 2,
			budget: 8,
			rejections: 1,
			verdicts: [{ round: 1, verdict: "done", summary: "x", took: 40 }],
		},
		[
			{ id: "c1", desc: "exists", verify: "test -f x", passes: true },
			{ id: "c2", desc: "compiles", verify: "tsc", passes: false },
		],
	);
	const [loop] = loopPanelModel(root);
	expect(loop.goal).toBe("my real goal");
	expect(loop.status).toBe("completed");
	expect(loop.round).toBe(2);
	expect(loop.budget).toBe(8);
	expect(loop.rejections).toBe(1);
	expect(loop.criteria).toEqual([
		{ id: "c1", desc: "exists", passes: true },
		{ id: "c2", desc: "compiles", passes: false },
	]);
	expect(loop.verdicts).toHaveLength(1);
});

test("running loops sort first; the _optimizer dir is ignored", () => {
	seed("done_one", { goal: "done one", status: "completed", round: 1, budget: 3, verdicts: [] }, []);
	seed("live_one", { goal: "live one", status: "running", round: 2, budget: 5, verdicts: [] }, []);
	// _optimizer is loop-internal state, not a loop
	mkdirSync(join(root, ".pi", "loops", "_optimizer"), { recursive: true });
	writeFileSync(join(root, ".pi", "loops", "_optimizer", "state.json"), "{}");
	const loops = loopPanelModel(root);
	expect(loops.map((l) => l.status)).toEqual(["running", "completed"]);
	expect(loops.map((l) => l.goal)).not.toContain("_optimizer");
});
