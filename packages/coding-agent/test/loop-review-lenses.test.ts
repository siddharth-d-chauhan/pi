import { afterEach, expect, test } from "vitest";
import { REVIEW_LENSES, reviewPanelSize } from "../../../extensions/loop.ts";

afterEach(() => {
	delete process.env.PI_LOOP_REVIEW_LENSES;
});

test("three distinct verification lenses are defined", () => {
	const keys = REVIEW_LENSES.map((l) => l.key);
	expect(keys).toEqual(["correctness", "safety", "reproduce"]);
	// each lens has a non-trivial adversarial brief
	for (const l of REVIEW_LENSES) expect(l.brief.length).toBeGreaterThan(20);
});

test("panel size defaults to 1 (single reviewer, all lenses in one pass)", () => {
	delete process.env.PI_LOOP_REVIEW_LENSES;
	expect(reviewPanelSize()).toBe(1);
});

test("panel size honors the env var, clamped to the lens count", () => {
	process.env.PI_LOOP_REVIEW_LENSES = "2";
	expect(reviewPanelSize()).toBe(2);
	process.env.PI_LOOP_REVIEW_LENSES = "3";
	expect(reviewPanelSize()).toBe(3);
	// clamp: never more reviewers than lenses
	process.env.PI_LOOP_REVIEW_LENSES = "9";
	expect(reviewPanelSize()).toBe(REVIEW_LENSES.length);
});

test("invalid or <=1 values fall back to a single reviewer", () => {
	for (const v of ["0", "1", "-4", "abc", ""]) {
		process.env.PI_LOOP_REVIEW_LENSES = v;
		expect(reviewPanelSize()).toBe(1);
	}
});
