import { expect, test } from "vitest";
import { EmissionGuard } from "../../../extensions/advisor.ts";

test("a real concern is admitted and normalized to a tagged note", () => {
	const g = new EmissionGuard(12);
	expect(g.admit("BLOCKER: this drops the error path")).toBe("BLOCKER: this drops the error path");
	// an untagged concern gets a default severity tag
	expect(g.admit("the retry has no backoff")).toBe("CONCERN: the retry has no backoff");
});

test("content-free / LGTM chatter is dropped (never injected)", () => {
	const g = new EmissionGuard(12);
	for (const noise of ["OK", "lgtm", "looks good", "no concerns", "all good.", "nothing", "N/A"]) {
		expect(g.admit(noise)).toBeNull();
	}
	expect(g.droppedEmpty).toBe(7);
	expect(g.droppedDuplicate).toBe(0);
});

test("duplicates are FIFO-deduped so a chatty reviewer can't flood", () => {
	const g = new EmissionGuard(12);
	expect(g.admit("CONCERN: unbounded recursion in walk()")).not.toBeNull();
	// same concern again, and a paraphrase that normalizes identically (tag/punct-insensitive)
	expect(g.admit("CONCERN: unbounded recursion in walk()")).toBeNull();
	expect(g.admit("unbounded recursion in walk")).toBeNull();
	expect(g.droppedDuplicate).toBe(2);
});

test("only the first non-empty line is taken (contract is one line)", () => {
	const g = new EmissionGuard(12);
	expect(g.admit("\n\nCONCERN: off-by-one in slice\nplus some rambling second line")).toBe(
		"CONCERN: off-by-one in slice",
	);
});

test("empty input is dropped as empty, not admitted", () => {
	const g = new EmissionGuard(12);
	expect(g.admit("")).toBeNull();
	expect(g.admit("   ")).toBeNull();
	expect(g.droppedEmpty).toBe(2);
});
