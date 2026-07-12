import { expect, test } from "vitest";
import { parseOrchestrateGoal } from "../../../extensions/loop.ts";

test("a multi-word goal is captured whole (the truncation bug)", () => {
	expect(parseOrchestrateGoal("create a file greet.ts that exports greet(name)")).toBe(
		"create a file greet.ts that exports greet(name)",
	);
});

test("recognized flags are stripped from the goal", () => {
	expect(parseOrchestrateGoal("fix the login race rounds=3 gate=smoke review=off")).toBe("fix the login race");
	expect(parseOrchestrateGoal("rmodel=gpt-5.5 add retries criteria=off")).toBe("add retries");
});

test("a flags-only argument yields an empty goal (caller shows usage)", () => {
	expect(parseOrchestrateGoal("rounds=3")).toBe("");
	expect(parseOrchestrateGoal("   ")).toBe("");
});

test("interior whitespace is collapsed", () => {
	expect(parseOrchestrateGoal("  fix   the    thing  ")).toBe("fix the thing");
});
