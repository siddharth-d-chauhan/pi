import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directivePending, humanWaitState, parseDirective } from "../../../extensions/aidlc.ts";

describe("aidlc directive parsing", () => {
	it("parses the engine's single JSON directive", () => {
		const d = parseDirective('{"kind":"ask","question":"Confirm scope?"}\n');
		expect(d).toEqual({ kind: "ask", question: "Confirm scope?" });
	});

	it("takes the last JSON line and tolerates non-JSON noise", () => {
		const out =
			'advisory: sensors fired\n{"kind":"print","message":"a"}\nnoise\n{"kind":"run-stage","stage_slug":"intent-capture"}';
		expect(parseDirective(out)?.kind).toBe("run-stage");
	});

	it("returns undefined for garbage", () => {
		expect(parseDirective("boom\nnot json")).toBeUndefined();
	});

	it("classifies pending vs human-turn directive kinds", () => {
		expect(directivePending("run-stage")).toBe(true);
		expect(directivePending("invoke-swarm")).toBe(true);
		expect(directivePending("print")).toBe(true);
		for (const kind of ["ask", "parked", "done", "error"]) expect(directivePending(kind)).toBe(false);
	});
});

describe("aidlc human-wait carve-out", () => {
	it("detects an open gate ([?]) in the active intent's state file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aidlc-hw-"));
		const intents = join(cwd, "aidlc", "spaces", "default", "intents");
		mkdirSync(join(intents, "260714-x"), { recursive: true });
		writeFileSync(join(cwd, "aidlc", "active-space"), "default\n");
		writeFileSync(join(intents, "active-intent"), "260714-x\n");
		writeFileSync(join(intents, "260714-x", "aidlc-state.md"), "- [?] 1.1 intent-capture\n");
		expect(humanWaitState(cwd)).toBe(true);
		writeFileSync(join(intents, "260714-x", "aidlc-state.md"), "- [-] 1.1 intent-capture\n");
		expect(humanWaitState(cwd)).toBe(false);
	});

	it("fails open to false without a workspace", () => {
		expect(humanWaitState(mkdtempSync(join(tmpdir(), "aidlc-empty-")))).toBe(false);
	});
});

// Real-engine smoke: runs only where the central install + bun exist (dev
// boxes). CI without bun skips — the contract above is still covered.
const engine = join(
	process.env.PI_AIDLC_HOME ?? join(homedir(), ".pi", "aidlc-workflows"),
	"dist",
	"claude",
	".claude",
	"tools",
	"aidlc-orchestrate.ts",
);
const bun = process.env.PI_BUN ?? join(homedir(), ".bun", "bin", "bun");
const engineAvailable = existsSync(engine) && existsSync(bun);

describe.skipIf(!engineAvailable)("aidlc engine smoke (real awslabs engine)", () => {
	it("emits a typed directive on a fresh workspace and an ask for a new intent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aidlc-engine-"));
		const fresh = parseDirective(execFileSync(bun, [engine, "next"], { cwd, encoding: "utf-8", timeout: 60_000 }));
		expect(fresh?.kind).toBe("error"); // no active intent yet — typed, with guidance
		const started = parseDirective(
			execFileSync(bun, [engine, "next", "fix the CSV export bug"], { cwd, encoding: "utf-8", timeout: 60_000 }),
		);
		expect(started?.kind).toBe("ask");
		expect(started?.question).toContain("bugfix");
	});
});
