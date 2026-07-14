/**
 * AIDLC Workflows Extension — drives the REAL awslabs/aidlc-workflows v2
 * deterministic engine from pi. The engine (a bun-run TypeScript CLI) owns all
 * between-stage routing, workflow state, audit, and approval gates; the model
 * is only the conductor: ask the engine what's next, do that one move well,
 * report, repeat. `/aidlc <intent>` starts the forwarding loop; an
 * `agent_settled` guard re-arms it (bounded) when the model stops mid-loop —
 * pi's equivalent of the upstream Stop hook.
 *
 * Verified against the real engine end-to-end (confirm → intent-birth →
 * run-stage → artifact → gate approve → skeleton-stance → presence refusal):
 * - CLAUDE_PROJECT_DIR must ride EVERY engine invocation — the engine resolves
 *   the project module-relative otherwise and writes workflow state into the
 *   central install instead of the project.
 * - Gate approval REFUSES unless a HUMAN_TURN audit event was minted since the
 *   last gate resolution (upstream mints it via a UserPromptSubmit hook); pi
 *   mints it on the `input` event, preserving the "a model cannot approve its
 *   own gate" property.
 * - Relative `.claude/...` paths in directives resolve under the ENGINE HOME,
 *   not the project; `aidlc/...` paths resolve in the project.
 *
 * Token posture: ZERO context cost while no workflow is active — no context
 * handlers, no system-prompt additions; the settle guard and the mint
 * early-return. Engine install is central (`~/.pi/aidlc-workflows`, override
 * PI_AIDLC_HOME); one install serves every project.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Consecutive same-directive nudges before the guard lets go (upstream
 *  interactive BLOCK_CAP=2 — a human who wants to pause is released fast). */
const NUDGE_CAP = 2;
const ENGINE_TIMEOUT_MS = 30_000;

function aidlcHome(): string {
	return process.env.PI_AIDLC_HOME ?? join(homedir(), ".pi", "aidlc-workflows");
}

/** The harness root the engine ships in — directives' relative `.claude/...`
 *  paths resolve HERE, not in the project. */
function engineRoot(): string {
	return join(aidlcHome(), "dist", "claude");
}

function enginePath(): string {
	return join(engineRoot(), ".claude", "tools", "aidlc-orchestrate.ts");
}

function auditLibPath(): string {
	return join(engineRoot(), ".claude", "tools", "aidlc-audit.ts");
}

function bunBin(): string {
	if (process.env.PI_BUN) return process.env.PI_BUN;
	const local = join(homedir(), ".bun", "bin", "bun");
	return existsSync(local) ? local : "bun";
}

export interface AidlcDirective {
	kind: string;
	stage?: string;
	gate?: boolean | string;
	question?: string;
	message?: string;
	reason?: string;
	stage_file?: string;
}

/** Parse the single JSON directive the engine prints on stdout (last JSON
 *  line wins — advisory noise on earlier lines is tolerated). */
export function parseDirective(stdout: string): AidlcDirective | undefined {
	const lines = stdout.trim().split("\n").reverse();
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed) as AidlcDirective;
			if (typeof parsed.kind === "string") return parsed;
		} catch {
			// keep scanning earlier lines
		}
	}
	return undefined;
}

/** Directive kinds that mean the conductor still owes work this session.
 *  ask/parked/done/error wait on the human (or ended), so a stop is fine. */
export function directivePending(kind: string): boolean {
	return kind === "run-stage" || kind === "invoke-swarm" || kind === "print";
}

/** Path of the active intent's state file inside a project, or undefined. */
export function activeStateFile(cwd: string): string | undefined {
	try {
		// active-space exists only once a non-default space is used
		let space = "default";
		try {
			space = readFileSync(join(cwd, "aidlc", "active-space"), "utf-8").trim() || "default";
		} catch {
			// keep default
		}
		const intentsDir = join(cwd, "aidlc", "spaces", space, "intents");
		const intent = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
		if (!intent) return undefined;
		const state = join(intentsDir, intent, "aidlc-state.md");
		return existsSync(state) ? state : undefined;
	} catch {
		return undefined;
	}
}

/** True when the active intent's state file shows a stage positively waiting
 *  on the human ([?] gate open / [R] revising) — the upstream Stop hook's
 *  human-wait carve-out. Fail-open to false (the nudge cap still bounds us). */
export function humanWaitState(cwd: string): boolean {
	try {
		const state = activeStateFile(cwd);
		if (!state) return false;
		return /\[(\?|R)\]/.test(readFileSync(state, "utf-8"));
	} catch {
		return false;
	}
}

/** Every engine invocation carries CLAUDE_PROJECT_DIR so workflow state lands
 *  in the project, never in the central install (verified failure mode), and
 *  bun's dir on PATH — the engine's report subcommand spawns `bun` itself. */
function engineEnv(cwd: string): NodeJS.ProcessEnv {
	const bunDir = join(bunBin(), "..");
	const path = process.env.PATH ?? "";
	return {
		...process.env,
		CLAUDE_PROJECT_DIR: cwd,
		PATH: path.includes(bunDir) ? path : `${bunDir}:${path}`,
	};
}

function runEngine(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile(
			bunBin(),
			[enginePath(), ...args],
			{ cwd, env: engineEnv(cwd), timeout: ENGINE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				resolve({ ok: !error, out: `${stdout ?? ""}${stdout ? "" : (stderr ?? "")}` });
			},
		);
	});
}

/** Mirror of upstream's aidlc-mint-presence UserPromptSubmit hook: on a real
 *  human prompt, append a HUMAN_TURN event to the active intent's audit ledger
 *  so gate approvals can commit. Fail-open, fire-and-forget, and gated on
 *  workflow state existing — zero cost in projects that never ran /aidlc. */
function mintHumanTurn(cwd: string): void {
	if (!activeStateFile(cwd) || !existsSync(auditLibPath())) return;
	const script = `const a=await import(${JSON.stringify(auditLibPath())});a.appendAuditEntry("HUMAN_TURN",{},process.env.CLAUDE_PROJECT_DIR);`;
	execFile(bunBin(), ["-e", script], { cwd, env: engineEnv(cwd), timeout: ENGINE_TIMEOUT_MS }, () => {
		// non-fatal — a mint failure must never block the human's turn
	});
}

function installReady(): boolean {
	return existsSync(enginePath());
}

/** Shell-like tokenizer for /aidlc arguments (double/single quotes group). */
export function tokenizeArgs(raw: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match = re.exec(raw);
	while (match) {
		tokens.push(match[1] ?? match[2] ?? match[3]);
		match = re.exec(raw);
	}
	return tokens;
}

/** The conductor contract. Covers the ROUTING the engine cannot inject itself
 *  (everything between directives); stage-execution depth arrives via the
 *  engine's own conductor persona on the first run-stage directive, and each
 *  stage file loads only when named — pi does not duplicate that prose. */
function conductorKickoff(cwd: string, intentArgs: string, firstDirective?: string): string {
	// PATH carries bun for the engine's own child spawns (report → aidlc-state).
	const engine = `CLAUDE_PROJECT_DIR="${cwd}" PATH="${join(bunBin(), "..")}:$PATH" ${bunBin()} ${enginePath()}`;
	return [
		"<aidlc-conductor>",
		"You are the CONDUCTOR of an AI-DLC workflow. A deterministic engine owns ALL routing, state,",
		"audit, and gates; you own the quality of the single move it names. Engine commands (bash, from",
		"the project root — the CLAUDE_PROJECT_DIR prefix is REQUIRED on every call):",
		`  NEXT:   ${engine} next [args]`,
		`  REPORT: ${engine} report --stage <slug> --result <approved|completed> [--user-input "<text>"]`,
		`  PARK:   ${engine} park   (pause cleanly at a stage boundary; also use when context runs low)`,
		"Forwarding loop — repeat until kind=done: run NEXT, act on the ONE JSON directive, REPORT, again.",
		"Directive kinds:",
		"  - run-stage → read the directive's stage_file and execute exactly that stage: read only the",
		"    resolved `consumes` paths, write the `produces` paths. Then branch on `gate`:",
		"      gate false → REPORT --result completed (no approval needed).",
		"      gate true  → present the artifacts and an Approve / Request-Changes choice, END YOUR TURN;",
		"        on approval REPORT --result approved. A rejection is handled conductor-side (revise the",
		"        artifact, re-present) — it is never a report outcome.",
		'      gate "unresolved" → do NOT run the stage. Read the ## Walking Skeleton practice',
		"        (aidlc/spaces/<space>/memory/: org.md → team.md → project.md, most specific wins),",
		"        classify on|off|scope-dependent, REPORT --skeleton-stance <stance>, then NEXT again.",
		"  - ask → relay the question to the user VERBATIM and END YOUR TURN — no tool calls, no invented",
		'    options. Deliver the answer afterwards: for a stage question, REPORT --user-input "<answer>";',
		"    for the fresh-workspace scope confirmation, re-run NEXT with the choice — confirmed stock",
		'    scope → NEXT --scope <name> "<intent>"; a compose request → NEXT compose "<description>"',
		"    (compose is a leading VERB, never a --scope value).",
		"  - print → do exactly what the message says: run the named tool (with the same",
		"    CLAUDE_PROJECT_DIR prefix), print its output; if it ends with 're-run next' continue the loop,",
		"    otherwise stop.",
		"  - invoke-swarm → autonomous Construction fan-out: follow the directive using aidlc-swarm.ts",
		"    prepare/check/finalize as the referee (same env prefix); finalize exit 0 → NEXT again;",
		"    exit 2 → halt and ask the human.",
		"  - error → show the message; follow its recovery instruction.  - parked/done → tell the user; stop.",
		"Paths: relative `.claude/...` paths in directives resolve under the ENGINE HOME",
		`(${engineRoot()}); \`aidlc/...\` paths resolve in the project. Never edit aidlc-state.md or audit`,
		"files by hand — report owns every transition. Human presence at gates is minted automatically by",
		"pi on each real user message; never fabricate it.",
		"Question files: write stage questions to the declared *-questions.md with lettered options and",
		'blank "[Answer]:" tags; offer the user "Guide me" / "I\'ll edit the file" / "Chat" and treat the',
		"file as the source of truth.",
		"Question discipline — the human's time is the scarcest resource in this loop:",
		"  BEFORE surfacing any question, try to answer it yourself: read the code (codemap/KP first),",
		"  existing artifacts, configs, and conventions; apply engineering common sense. Questions the",
		"  evidence answers get the answer filled in as '[Answer]: <answer> (assumed from <evidence> —",
		"  veto at the gate)' and are NOT asked. Surface at most the few questions that are genuine",
		"  human judgment: business priorities, user-facing tradeoffs, irreversible/destructive choices,",
		"  or contradictions in the evidence. When presenting the gate, list your assumptions in one",
		"  short block so a wrong one costs the human a single veto, not an interview.",
		"pi capabilities — use them inside stages instead of reinventing (skip any that are unavailable):",
		"  - Understanding code (reverse-engineering, practices-discovery): query codemap/KP FIRST —",
		"    pi_context_code, knowledge_call, knowledge_search, context_recall — instead of broad file",
		"    paging; expert-cases/KP hold prior Jira/git evidence for this repo.",
		`  - Conventions (practices-discovery, design, code-generation): read the ECC rules packs at`,
		"    ~/.pi/ecc/rules/common/ and ~/.pi/ecc/rules/<language>/ and fold what applies into the",
		"    practices/design artifacts rather than inventing style guidance.",
		"  - Sub-pipelines: for a known plan→build→review sub-task inside a stage, run a chain (chain",
		"    tool; .pi/chains presets like feature/bugfix/review) instead of hand-dispatching workers.",
		"  - Workers: spawn via the agent tool (worktree isolation for write work) with a one-line role",
		"    persona; REUSE an idle agent whose prior scope matches via agent_message instead of",
		"    respawning. You are the only coordinator.",
		"  - Construction convergence: a unit with a machine-checkable check command can run as an",
		"    orchestrated loop (loop_run tool) with the unit's checks as criteria — the loop verifies",
		"    objectively and reviews independently before accepting done.",
		"  - Edits: pi's quality gate auto-typechecks this run's edited files at settle and blocks",
		"    weakening lint/ts configs — fix the code, not the gate. Mirror stage progress in the",
		"    update_plan checklist so the human sees where the workflow stands.",
		"  - Durable lessons: propose with the remember tool (human-reviewed) in ADDITION to the AIDLC",
		"    learnings ritual — KP serves them across every future session, not only aidlc runs.",
		firstDirective
			? `pi already ran the first NEXT for ${JSON.stringify(intentArgs)}. Its directive:\n${firstDirective}\n` +
				"Act on this directive now (step 2 of the loop) — do NOT re-run that first NEXT."
			: `Start now: run NEXT with the argument ${JSON.stringify(intentArgs)}.`,
		"</aidlc-conductor>",
	].join("\n");
}

export default function aidlc(pi: ExtensionAPI) {
	let active = false;
	let lastSignature = "";
	let nudges = 0;

	pi.registerCommand("aidlc", {
		description:
			"Run an AI-DLC workflow (real awslabs engine): /aidlc <intent> · --scope <s> · compose · --resume · status · park · stop · setup",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (raw === "setup") {
				if (installReady()) {
					ctx.ui.notify(`aidlc engine already installed at ${aidlcHome()}`, "info");
					return;
				}
				ctx.ui.notify("cloning awslabs/aidlc-workflows (v2)…", "info");
				const cloned = await new Promise<boolean>((resolve) => {
					execFile(
						"git",
						["clone", "--depth", "1", "-b", "v2", "https://github.com/awslabs/aidlc-workflows", aidlcHome()],
						{ timeout: 300_000 },
						(error) => resolve(!error),
					);
				});
				ctx.ui.notify(
					cloned
						? `aidlc engine installed at ${aidlcHome()} — /aidlc "<intent>" to start`
						: "clone failed — check network/git, or set PI_AIDLC_HOME to an existing checkout",
					cloned ? "info" : "error",
				);
				return;
			}
			if (raw === "stop") {
				active = false;
				ctx.ui.notify("aidlc loop guard disarmed for this session (workflow state is untouched)", "info");
				return;
			}
			if (!installReady()) {
				ctx.ui.notify(`aidlc engine not found at ${enginePath()} — run /aidlc setup (needs bun)`, "error");
				return;
			}
			if (raw === "park") {
				active = false;
				const res = await runEngine(ctx.cwd, ["park"]);
				const directive = parseDirective(res.out);
				ctx.ui.notify(
					directive?.kind === "parked" || directive?.kind === "print"
						? `aidlc parked — /aidlc --resume to continue. ${(directive.message ?? directive.reason ?? "").slice(0, 120)}`
						: `park failed: ${res.out.slice(0, 160)}`,
					"info",
				);
				return;
			}
			if (raw === "status" || raw === "") {
				const res = await runEngine(ctx.cwd, ["next", "--status"]);
				const directive = parseDirective(res.out);
				ctx.ui.notify(
					directive
						? `aidlc: ${directive.kind}${directive.stage ? ` @ ${directive.stage}` : ""} — ${
								(directive.question ?? directive.message ?? "").slice(0, 160) || "(pending stage)"
							}`
						: `aidlc engine unreadable: ${res.out.slice(0, 160)}`,
					directive ? "info" : "error",
				);
				return;
			}
			// Everything else — an intent, compose "<desc>", --scope/--stage/--phase
			// jumps, --resume, intent/space verbs — is tokenized and run through
			// the FIRST next call deterministically here (the launch routing —
			// compose verb vs --scope vs freeform — must not depend on the model),
			// and the resulting directive is handed to the conductor to act on.
			active = true;
			lastSignature = "";
			nudges = 0;
			// AIDLC subagents (composer, construction workers) legitimately need
			// more than the default 14-call budget — the composer alone reads the
			// scope registry + stage graph + 9 scope files before validate-grid.
			// Raise the shared knob for the session unless the user pinned it.
			if (!process.env.PI_SUBAGENT_MAX_TOOL_CALLS) process.env.PI_SUBAGENT_MAX_TOOL_CALLS = "48";
			const first = await runEngine(ctx.cwd, ["next", ...tokenizeArgs(raw)]);
			const firstDirective = parseDirective(first.out);
			pi.sendUserMessage(
				conductorKickoff(ctx.cwd, raw, firstDirective ? JSON.stringify(firstDirective) : undefined),
			);
		},
	});

	// Upstream's UserPromptSubmit presence hook, on pi's input event: without a
	// fresh HUMAN_TURN row the engine refuses every gate approval (verified).
	pi.on("input", async (_event, ctx) => {
		mintHumanTurn(ctx.cwd);
	});

	// Upstream's SessionStart(compact) hook: compaction can summarize away the
	// conductor contract, stalling the loop. Re-fetch the pending directive and
	// re-send the FULL contract so the workflow continues deterministically.
	pi.on("session_compact", async (_event, ctx) => {
		if (!active) return;
		const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
		const res = await runEngine(cwd, ["next"]);
		const directive = parseDirective(res.out);
		if (!directive || directive.kind === "done" || directive.kind === "parked") return;
		lastSignature = ""; // fresh contract → reset the no-progress counter
		nudges = 0;
		pi.sendUserMessage(
			`${conductorKickoff(cwd, "--resume", JSON.stringify(directive))}\n` +
				"(Context was just compacted mid-workflow — the contract above is re-issued; pick up exactly where the directive says.)",
			{ deliverAs: "followUp" },
		);
	});

	// pi's Stop-hook equivalent: when the conductor ends its turn but the
	// engine still names pending work, re-arm the loop — bounded, with the
	// upstream human-wait carve-out, and free when no workflow is active.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!active) return;
		const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
		const res = await runEngine(cwd, ["next"]);
		const directive = parseDirective(res.out);
		if (!directive) return;
		if (directive.kind === "done" || directive.kind === "parked") {
			active = false;
			ctx.ui.notify(directive.kind === "done" ? "aidlc workflow complete" : "aidlc workflow parked", "info");
			return;
		}
		if (!directivePending(directive.kind)) return; // ask/error → human's turn
		if (humanWaitState(cwd)) return; // gate open / revising → the stop is legitimate
		const signature = `${directive.kind}:${directive.stage ?? ""}:${directive.message ?? ""}`;
		nudges = signature === lastSignature ? nudges + 1 : 1;
		lastSignature = signature;
		if (nudges > NUDGE_CAP) {
			active = false;
			ctx.ui.notify(
				"aidlc loop guard let go after repeated no-progress stops — /aidlc --resume to re-arm",
				"warning",
			);
			return;
		}
		pi.sendUserMessage(
			`<aidlc-continuation>The workflow engine still has a pending directive (${directive.kind}` +
				`${directive.stage ? ` @ ${directive.stage}` : ""}). Continue the forwarding loop: ` +
				`act on it, report, and run next again — or relay its question and stop if it needs the user.</aidlc-continuation>`,
		);
	});
}
