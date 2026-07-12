import { expect, test } from "vitest";
import { parseLoopVerdict } from "../../../extensions/loop.ts";

// The convergence bug: the verdict lives in the orchestrator's REPLY, but the
// loop parsed PROGRESS.md and found nothing -> every round read as "continue"
// -> the loop never converged even with all criteria passing. These lock the
// parser that now reads the reply.

test("parses a done verdict from the reply (em dash or hyphen)", () => {
	expect(parseLoopVerdict("...work...\nLOOP_VERDICT: done — greet.ts created, all criteria pass")).toEqual({
		verdict: "done",
		summary: "greet.ts created, all criteria pass",
	});
	expect(parseLoopVerdict("LOOP_VERDICT: done - hyphen form")?.verdict).toBe("done");
});

test("parses continue and blocked", () => {
	expect(parseLoopVerdict("LOOP_VERDICT: continue — more work")?.verdict).toBe("continue");
	expect(parseLoopVerdict("LOOP_VERDICT: blocked — need a decision")?.verdict).toBe("blocked");
});

test("takes the LAST verdict line (reply appended after stale PROGRESS.md)", () => {
	// verdictText = progressText + reply; a stale 'continue' from PROGRESS must
	// not beat THIS round's 'done' in the reply, which comes last.
	const text = "PROGRESS: LOOP_VERDICT: continue — round 3\n---reply---\nLOOP_VERDICT: done — finished";
	expect(parseLoopVerdict(text)?.verdict).toBe("done");
});

test("returns null when there is no verdict line (caller defaults to continue)", () => {
	expect(parseLoopVerdict("just some progress notes, no verdict")).toBeNull();
	expect(parseLoopVerdict("")).toBeNull();
});

test("is case-insensitive on the marker", () => {
	expect(parseLoopVerdict("loop_verdict: Done — ok")?.verdict).toBe("done");
});
