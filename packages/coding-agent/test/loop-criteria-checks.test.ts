import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runCriteriaChecks } from "../../../extensions/loop.ts";

// The SOTA fix: the loop converges on VERIFIABLE CHECKS it runs itself, not on
// the model's self-assessment. runCriteriaChecks executes each criterion's
// `verify` command in the project root and sets `passes` from the exit code.

let root: string;
let dir: string;
const loop = () => ({ dir }) as never;

beforeEach(() => {
	root = join(tmpdir(), `crit-${Date.now()}-${Math.floor(process.hrtime()[1] % 1e6)}`);
	dir = join(root, ".pi", "loops", "t");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "criteria.json"),
		JSON.stringify([
			{ id: "c1", desc: "target exists", verify: "test -f target.txt", passes: false },
			{ id: "c2", desc: "target says hello", verify: "grep -q hello target.txt", passes: false },
		]),
	);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("all criteria fail when the work isn't there yet", async () => {
	const r = await runCriteriaChecks(loop());
	expect(r).toEqual({ total: 2, passed: 0, allPass: false, failing: ["c1", "c2"] });
	// persisted objectively (passes stays false)
	const items = JSON.parse(readFileSync(join(dir, "criteria.json"), "utf-8"));
	expect(items.every((c: { passes: boolean }) => c.passes === false)).toBe(true);
});

test("criteria flip to pass once the work objectively satisfies them", async () => {
	writeFileSync(join(root, "target.txt"), "hello world\n"); // the "work" lands in the project root
	const r = await runCriteriaChecks(loop());
	expect(r).toEqual({ total: 2, passed: 2, allPass: true, failing: [] });
	const items = JSON.parse(readFileSync(join(dir, "criteria.json"), "utf-8"));
	expect(items.every((c: { passes: boolean }) => c.passes === true)).toBe(true);
});

test("partial: one pass, one fail is reported precisely", async () => {
	writeFileSync(join(root, "target.txt"), "goodbye\n"); // exists (c1) but no 'hello' (c2)
	const r = await runCriteriaChecks(loop());
	expect(r).toEqual({ total: 2, passed: 1, allPass: false, failing: ["c2"] });
});

test("a model-set pass is OVERRULED by the real check (no self-assessment)", async () => {
	// model lied: passes=true but the file doesn't exist
	writeFileSync(
		join(dir, "criteria.json"),
		JSON.stringify([{ id: "c1", desc: "exists", verify: "test -f nope.txt", passes: true }]),
	);
	const r = await runCriteriaChecks(loop());
	expect(r?.allPass).toBe(false); // objective check wins
	expect(JSON.parse(readFileSync(join(dir, "criteria.json"), "utf-8"))[0].passes).toBe(false);
});
