import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	activeStateFile,
	directivePending,
	humanWaitState,
	parseDirective,
	tokenizeArgs,
} from "../../../extensions/aidlc.ts";

describe("aidlc directive parsing", () => {
	it("parses the engine's single JSON directive", () => {
		const d = parseDirective('{"kind":"ask","question":"Confirm scope?"}\n');
		expect(d).toEqual({ kind: "ask", question: "Confirm scope?" });
	});

	it("takes the last JSON line and tolerates non-JSON noise", () => {
		const out =
			'advisory: sensors fired\n{"kind":"print","message":"a"}\nnoise\n{"kind":"run-stage","stage":"intent-capture"}';
		expect(parseDirective(out)?.kind).toBe("run-stage");
		expect(parseDirective(out)?.stage).toBe("intent-capture"); // field is `stage`, not stage_slug
	});

	it("returns undefined for garbage", () => {
		expect(parseDirective("boom\nnot json")).toBeUndefined();
	});

	it("tokenizes /aidlc arguments shell-like so the compose verb stays a leading token", () => {
		expect(tokenizeArgs('compose "brownfield feature: skip ideation"')).toEqual([
			"compose",
			"brownfield feature: skip ideation",
		]);
		expect(tokenizeArgs("--scope bugfix fix the CSV bug")).toEqual(["--scope", "bugfix", "fix", "the", "CSV", "bug"]);
		expect(tokenizeArgs("")).toEqual([]);
	});

	it("classifies pending vs human-turn directive kinds", () => {
		expect(directivePending("run-stage")).toBe(true);
		expect(directivePending("invoke-swarm")).toBe(true);
		expect(directivePending("print")).toBe(true);
		for (const kind of ["ask", "parked", "done", "error"]) expect(directivePending(kind)).toBe(false);
	});
});

describe("aidlc workspace state probing", () => {
	function scaffold(state: string): string {
		const cwd = mkdtempSync(join(tmpdir(), "aidlc-hw-"));
		const intents = join(cwd, "aidlc", "spaces", "default", "intents");
		mkdirSync(join(intents, "260714-x"), { recursive: true });
		writeFileSync(join(cwd, "aidlc", "active-space"), "default\n");
		writeFileSync(join(intents, "active-intent"), "260714-x\n");
		writeFileSync(join(intents, "260714-x", "aidlc-state.md"), state);
		return cwd;
	}

	it("detects an open gate ([?]) in the active intent's state file", () => {
		const cwd = scaffold("- [?] 1.1 intent-capture\n");
		expect(humanWaitState(cwd)).toBe(true);
		expect(activeStateFile(cwd)).toContain("aidlc-state.md");
	});

	it("treats an in-progress stage as not human-wait", () => {
		expect(humanWaitState(scaffold("- [-] 1.1 intent-capture\n"))).toBe(false);
	});

	it("fails open to false without a workspace", () => {
		const empty = mkdtempSync(join(tmpdir(), "aidlc-empty-"));
		expect(humanWaitState(empty)).toBe(false);
		expect(activeStateFile(empty)).toBeUndefined();
	});
});

// Real-engine smoke: runs only where the central install + bun exist (dev
// boxes). CI without bun skips — the contract above is still covered.
const home = process.env.PI_AIDLC_HOME ?? join(homedir(), ".pi", "aidlc-workflows");
const engine = join(home, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
const auditLib = join(home, "dist", "claude", ".claude", "tools", "aidlc-audit.ts");
const utility = join(home, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");
const bun = process.env.PI_BUN ?? join(homedir(), ".bun", "bin", "bun");
const engineAvailable = existsSync(engine) && existsSync(bun);

describe.skipIf(!engineAvailable)("aidlc extension loop guard (real engine)", () => {
	it("re-issues the conductor contract after compaction while a workflow is active", async () => {
		const aidlcExtension = (await import("../../../extensions/aidlc.ts")).default;
		const sent: string[] = [];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				command = def.handler;
			},
			on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
				handlers.set(event, handler);
			},
			sendUserMessage(content: string) {
				sent.push(content);
			},
		};
		aidlcExtension(pi as never);
		const cwd = mkdtempSync(join(tmpdir(), "aidlc-compact-"));
		const ctx = { cwd, ui: { notify: () => {} } };

		await command?.("fix the CSV export bug", ctx); // launch → contract + first directive
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("<aidlc-conductor>");
		expect(sent[0]).toContain("already ran the first NEXT");

		await handlers.get("session_compact")?.({ type: "session_compact" }, ctx);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("<aidlc-conductor>");
		expect(sent[1]).toContain("compacted mid-workflow");

		// inactive sessions pay nothing: after /aidlc stop, compaction is free
		await command?.("stop", ctx);
		await handlers.get("session_compact")?.({ type: "session_compact" }, ctx);
		expect(sent).toHaveLength(2);
	});
});

describe.skipIf(!engineAvailable)("aidlc engine smoke (real awslabs engine)", () => {
	function run(cwd: string, tool: string, args: string[]): string {
		return runArgv(cwd, [tool, ...args]);
	}

	function runArgv(cwd: string, argv: string[]): string {
		return execFileSync(bun, argv, {
			cwd,
			encoding: "utf-8",
			timeout: 120_000,
			// CLAUDE_PROJECT_DIR is the load-bearing seam: without it the engine
			// resolves the project module-relative and writes state into the
			// CENTRAL INSTALL (verified failure mode). bun must be on PATH too —
			// the engine's report subcommand spawns `bun` itself.
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: cwd,
				PATH: `${join(bun, "..")}:${process.env.PATH ?? ""}`,
			},
		});
	}

	it("routes the compose verb to the composer (never a --scope value)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aidlc-compose-"));
		const tokens = tokenizeArgs('compose "brownfield feature: skip ideation, keep reverse-engineering"');
		const directive = parseDirective(run(cwd, engine, ["next", ...tokens]));
		expect(directive?.kind).toBe("print");
		expect(directive?.message).toContain("composer");
	});

	it("keeps workflow state in the project and enforces the human-presence gate", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aidlc-engine-"));

		// fresh workspace → typed error; new intent → scope ask
		expect(parseDirective(run(cwd, engine, ["next"]))?.kind).toBe("error");
		const asked = parseDirective(run(cwd, engine, ["next", "fix the CSV export bug"]));
		expect(asked?.kind).toBe("ask");
		expect(asked?.question).toContain("bugfix");

		// confirmed scope → print directive naming intent-birth; run it
		const birth = parseDirective(run(cwd, engine, ["next", "--scope", "bugfix", "fix the CSV export bug"]));
		expect(birth?.kind).toBe("print");
		expect(birth?.message).toContain("intent-birth");
		run(cwd, utility, [
			"intent-birth",
			"--scope",
			"bugfix",
			"--arguments",
			"fix the CSV export bug",
			"--label",
			"csv-fix",
		]);

		// state landed in the PROJECT, not the central install
		expect(activeStateFile(cwd)).toContain(cwd);

		// first stage directive uses the `stage` field and declares produces
		const stage = parseDirective(run(cwd, engine, ["next"]));
		expect(stage?.kind).toBe("run-stage");
		expect(stage?.stage).toBe("requirements-analysis");

		// produce the artifact, then approve WITHOUT a human turn → refused
		const record = join(cwd, "aidlc", "spaces", "default", "intents");
		const intent = readFileSync(join(record, "active-intent"), "utf-8").trim();
		const stageDir = join(record, intent, "inception", "requirements-analysis");
		mkdirSync(stageDir, { recursive: true });
		writeFileSync(
			join(stageDir, "requirements.md"),
			"## Requirements\n\nR1: valid CSV.\n\n## Acceptance\n\nA1: 200 text/csv.\n",
		);
		const refused = parseDirective(
			run(cwd, engine, ["report", "--stage", "requirements-analysis", "--result", "approved"]),
		);
		expect(refused?.kind).toBe("error");
		expect(refused?.message).toContain("human has not acted");

		// mint HUMAN_TURN (what the pi extension does on every user input) → approved
		runArgv(cwd, [
			"-e",
			`const a=await import(${JSON.stringify(auditLib)});a.appendAuditEntry("HUMAN_TURN",{},process.env.CLAUDE_PROJECT_DIR);`,
		]);
		const approved = parseDirective(
			run(cwd, engine, ["report", "--stage", "requirements-analysis", "--result", "approved"]),
		);
		expect(approved?.kind).toBe("done");
		expect(approved?.reason).toContain("Committed approve");
	});
});
