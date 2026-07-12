/**
 * Loop Extension — Ralph-style verify-loops that are VISIBLE and STEERABLE
 * inside pi, like subagents:
 *
 *   /loop <goal>                 ONE command: orchestrated loop, defaults from
 *                                <repo>/.pi/loop.json (gate/reviewModel/rounds),
 *                                budget auto-sized to criteria+2 when rounds
 *                                is not given. Overrides: rounds= gate= rmodel=
 *                                review=off criteria=off
 *   /loop verify <capability>    devbrain-gated retry loop (typed triage)
 *   /loop resume [<goal>]        re-attach after a pi restart
 *   /loop status [<goal>]        rich in-chat panel (criteria ✓/✗, verdicts)
 *   loop_run tool — the model can launch the same loops (orchestrate default).
 *
 * The loop registers in the BackgroundProcessRegistry (the same roster the
 * agent hub shows): every round streams into the live log, `x` kills it,
 * `s` steers it ("stop", "more 3", or free text appended to the next round's
 * context), and when the round budget runs out it PARKS (status "parked")
 * until you steer "more N" — the human approval gate, in the TUI.
 *
 * Verify mode (devbrain goal loop): run `devbrain flow goal` → triage:
 *   green            → done (notification)
 *   env              → doctor detour, retry — does NOT consume a round
 *   flake_suspect    → retry, consumes a round
 *   product_bug      → stop with evidence (notification) — never papered over
 *
 * Orchestrate mode — round 0 turns the goal into machine-checkable acceptance
 * criteria (criteria.json, all passes=false). A "done" claim must survive:
 *   0. the CRITERIA DATA (free, mechanical): any passes=false rejects it
 *      before a single review token is spent — done-ness is data, not prose
 *   1. independent fresh-context adversarial REVIEW of the loop's whole diff
 *      (baseline = git HEAD at start), on a DIFFERENT model when rmodel= or
 *      $PI_LOOP_REVIEW_MODEL is set (judge diversity)
 *   2. the mechanical devbrain GATE (when gate= is set)
 * Two consecutive rejected claims switch rounds to BEST-OF-N: parallel
 * candidate workers in worktrees, selected by execution evidence.
 * Rejections append a lesson to GUARDRAILS.md, which every later round and
 * reviewer reads — the loop learns from its failures (Ralph guardrails).
 * Self-optimization, two tiers:
 *   ONLINE (GEPA-lite): when a failure CLASS (criteria/review/gate) recurs
 *   within a run, the loop promotes its lesson from a passive guardrail into
 *   an explicit un-skippable step REWRITTEN INTO ITS OWN round prompt.
 *   Learned steps persist in state.json and survive /loop resume.
 *   OFFLINE (/loop optimize [apply]): every run appends a scored record to
 *   .pi/loops/_optimizer/journal.jsonl. A failure class the online tier had
 *   to re-learn across many runs is DISTILLED into a STANDING LESSON pre-
 *   loaded into every future loop's round prompt from round 1 (base-prompt
 *   versioned). The effect is measured — a promoted class should recur less.
 * State (PROGRESS.md, GUARDRAILS.md, criteria.json, state.json) lives in
 * .pi/loops/<goal>/; context dies, files don't — /loop resume re-attaches.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { copper, heatLine } from "./lib/card.ts";
import {
	type BaselineStep,
	distill,
	type Proposal,
	parseJournal,
	type RunRecord,
	recurrence,
	versionTrend,
} from "./lib/loop-optimizer.ts";

const DEVBRAIN_ROOT = process.env.PI_DEVBRAIN_ROOT ?? `${process.env.HOME}/vault/tools/devbrain`;
const DEFAULT_REPO = process.env.PI_DEVBRAIN_REPO ?? `${process.env.HOME}/projects/dev/automations/testing-automations`;

/** The orchestrate goal = the whole `/loop` argument minus recognized flags.
 *  (Using the first token truncated every multi-word goal to one word.) */
export function parseOrchestrateGoal(raw: string): string {
	return raw
		.replace(/\b(?:rounds|gate|rmodel|review|criteria)=\S+/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse the LAST `LOOP_VERDICT: done|continue|blocked — summary` line from text
 *  (the orchestrator's reply). Returns null when absent. The verdict lives in the
 *  model's REPLY, so settleRound reads it from there, not PROGRESS.md. */
export function parseLoopVerdict(text: string): { verdict: string; summary: string } | null {
	const matches = [...text.matchAll(/LOOP_VERDICT:\s*(done|continue|blocked)\s*[—-]\s*(.*)/gi)];
	const last = matches[matches.length - 1];
	if (!last) return null;
	return { verdict: last[1].toLowerCase(), summary: last[2].slice(0, 100) };
}
const ROUND_TIMEOUT_MS = Number(process.env.PI_LOOP_ROUND_TIMEOUT_MS ?? 900_000);
const MAX_ENV_DETOURS = 3;
const DEFAULT_ROUNDS = 5;
/** Auto-budget bounds: rounds = criteria + 2, clamped. */
const AUTO_BUDGET_MIN = 3;
const AUTO_BUDGET_MAX = 10;

/** Per-repo launch defaults (<repo>/.pi/loop.json) so `/loop <goal>` alone is a
 *  complete launch: {"gate": "smoke-tested", "reviewModel": "pi/smol",
 *  "rounds": 6, "review": true, "criteria": true} — all keys optional. */
function loadLoopDefaults(cwd: string): {
	gate?: string;
	reviewModel?: string;
	rounds?: number;
	review?: boolean;
	criteria?: boolean;
} {
	try {
		const parsed = JSON.parse(readFileSync(`${cwd}/.pi/loop.json`, "utf-8"));
		if (parsed && typeof parsed === "object") {
			return {
				gate: typeof parsed.gate === "string" ? parsed.gate : undefined,
				reviewModel: typeof parsed.reviewModel === "string" ? parsed.reviewModel : undefined,
				rounds: typeof parsed.rounds === "number" ? parsed.rounds : undefined,
				review: typeof parsed.review === "boolean" ? parsed.review : undefined,
				criteria: typeof parsed.criteria === "boolean" ? parsed.criteria : undefined,
			};
		}
	} catch {
		// no defaults file — built-ins apply
	}
	return {};
}

interface LoopHandle {
	steers: string[];
	killed: boolean;
	wake?: () => void;
}

function runDevbrain(args: string[], signalled: LoopHandle): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-m", "devbrain.cli", ...args], {
			env: { ...process.env, PYTHONPATH: DEVBRAIN_ROOT },
			cwd: DEVBRAIN_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), ROUND_TIMEOUT_MS);
		const poll = setInterval(() => {
			if (signalled.killed) child.kill("SIGKILL");
		}, 500);
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on("data", () => {});
		child.on("error", (err) => {
			clearTimeout(timer);
			clearInterval(poll);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearInterval(poll);
			resolve({ code, out });
		});
	});
}

/** Wait until either a steer arrives or the handle is killed. */
function waitForSteer(handle: LoopHandle): Promise<void> {
	return new Promise((resolve) => {
		handle.wake = resolve;
	});
}

async function driveLoop(opts: {
	goal: string;
	repo: string;
	rounds: number;
	notify: (text: string, level: "info" | "warning" | "error") => void;
}): Promise<void> {
	const registry = getBackgroundProcessRegistry();
	const handle: LoopHandle = { steers: [], killed: false };
	const id = registry.register({
		kind: "delegation", // shows in the agent hub roster
		label: `↻ loop ${opts.goal}`,
		summary: `verify-loop · budget ${opts.rounds} rounds · steer: "stop" | "more N" | notes`,
		onKill: () => {
			handle.killed = true;
			handle.wake?.();
		},
		onSteer: (text: string) => {
			handle.steers.push(text.trim());
			registry.appendLog(id, `⇦ steer: ${text.trim().slice(0, 80)}`);
			handle.wake?.();
		},
	});

	let budget = opts.rounds;
	let round = 0;
	let envDetours = 0;
	const notes: string[] = [];

	const consumeSteers = (): "stop" | "parked-continue" | undefined => {
		let verdict: "stop" | "parked-continue" | undefined;
		while (handle.steers.length > 0) {
			const steer = handle.steers.shift() as string;
			const more = /^more\s+(\d+)/i.exec(steer);
			if (/^stop\b/i.test(steer)) verdict = "stop";
			else if (more) {
				budget += Number(more[1]);
				verdict = verdict ?? "parked-continue";
				registry.appendLog(id, `budget +${more[1]} → ${budget} rounds`);
			} else if (steer) notes.push(steer);
		}
		return verdict;
	};

	try {
		while (!handle.killed) {
			if (consumeSteers() === "stop") {
				registry.appendLog(id, "[stopped by steer]");
				registry.setStatus(id, "cancelled");
				return;
			}
			if (round >= budget) {
				// The human gate: park until "more N" arrives via steer.
				registry.setStatus(id, "parked");
				registry.appendLog(id, `parked: budget ${budget} spent — steer "more N" to continue, "stop" to end`);
				opts.notify(`loop ${opts.goal}: parked after ${round} rounds — steer it from the agent hub`, "warning");
				await waitForSteer(handle);
				if (handle.killed) break;
				const v = consumeSteers();
				if (v === "stop" || round >= budget) {
					registry.setStatus(id, "cancelled");
					registry.appendLog(id, "[ended at budget]");
					return;
				}
				registry.setStatus(id, "running");
				continue;
			}

			round += 1;
			registry.appendLog(id, `— round ${round}/${budget}${notes.length ? ` (notes: ${notes.length})` : ""}`);
			const { out } = await runDevbrain(["--repo", opts.repo, "flow", "goal", opts.goal, "--no-journal"], handle);
			if (handle.killed) break;
			let report: {
				ok?: boolean;
				steps?: Array<{ block?: string; triage?: string; detail?: string; status?: string }>;
			};
			try {
				report = JSON.parse(out);
			} catch {
				registry.appendLog(id, "[round produced no parseable report — counting as env detour]");
				envDetours += 1;
				if (envDetours > MAX_ENV_DETOURS) break;
				continue;
			}

			if (report.ok) {
				registry.appendLog(id, `✓ GREEN after ${round} round(s)`);
				registry.setStatus(id, "completed");
				opts.notify(`loop ${opts.goal}: GREEN after ${round} round(s)`, "info");
				return;
			}
			const failed = (report.steps ?? []).find((s) => s.triage);
			const triage = failed?.triage ?? "product_bug";
			registry.appendLog(id, `✗ ${failed?.block ?? "?"} [${triage}] ${String(failed?.detail ?? "").slice(0, 70)}`);

			if (triage === "env") {
				envDetours += 1;
				round -= 1; // env failures never consume the round budget
				if (envDetours > MAX_ENV_DETOURS) {
					registry.appendLog(id, `[env broken after ${MAX_ENV_DETOURS} doctor detours — stopping]`);
					registry.setStatus(id, "failed");
					opts.notify(`loop ${opts.goal}: environment unavailable (${failed?.detail?.slice(0, 60)})`, "error");
					return;
				}
				const doctor = await runDevbrain(["--repo", opts.repo, "doctor"], handle);
				registry.appendLog(id, `↻ doctor detour ${envDetours}/${MAX_ENV_DETOURS} (exit ${doctor.code})`);
				continue;
			}
			if (triage === "flake_suspect") continue; // consume the round, rerun

			// product_bug: real signal — stop with evidence, never blind-retry.
			registry.setStatus(id, "failed");
			opts.notify(
				`loop ${opts.goal}: product signal at ${failed?.block} — ${String(failed?.detail ?? "").slice(0, 80)}`,
				"error",
			);
			return;
		}
		registry.appendLog(id, "[killed]");
		registry.setStatus(id, "cancelled");
	} catch (err) {
		registry.appendLog(id, `[loop error: ${(err as Error).message}]`);
		registry.setStatus(id, "failed");
	}
}

// ============================================================================
// Orchestrated mode (ACP/Ralph-style, in-TUI): each round, a prompt is
// injected into the MAIN session; the model reads PROGRESS.md, dispatches a
// FRESH-CONTEXT worker subagent via its own agent tool (visible in the hub),
// gates with devbrain when relevant, updates PROGRESS.md, and ends the turn
// with a verdict marker. The extension watches agent_settled, parses the
// verdict from PROGRESS.md, and drives the next round — with the same
// park/steer/kill lifecycle in the roster.
// ============================================================================

type NotifyFn = (text: string, level: "info" | "warning" | "error") => void;

interface OrchestratedLoop {
	id: string;
	goal: string;
	/** Optional devbrain capability that must pass before "done" is accepted. */
	gate?: string;
	repo: string;
	dir: string;
	budget: number;
	round: number;
	notes: string[];
	killed: boolean;
	parked: boolean;
	awaitingRound: boolean;
	/** Which dispatch we are waiting on: criteria definition, a work round, or the done-claim review. */
	phase: "criteria" | "round" | "review";
	/** Independent fresh-context review of every "done" claim (default on). */
	reviewEnabled: boolean;
	/** Round 0 generates machine-checkable acceptance criteria (default on). */
	criteriaEnabled: boolean;
	/** One retry allowed when the criteria round produces an unusable file. */
	criteriaRetried: boolean;
	/** Model the reviewer should run on (judge diversity — Amp Oracle pattern). */
	reviewModel?: string;
	/** Consecutive rejected done claims; >=2 switches rounds to best-of-n candidates. */
	rejections: number;
	/** Self-optimization (online GEPA-lite): per-failure-class repeat counts,
	 *  and the instructions the loop has rewritten into its own round prompt
	 *  once a failure class recurred. */
	failureCounts: Record<string, { count: number; evidence: string }>;
	learnedSteps: string[];
	/** Offline optimizer: steps distilled from past runs, pre-loaded into the
	 *  round prompt from round 1; and the base-prompt version this run used. */
	baselineSteps: BaselineStep[];
	promptVersion: number;
	/** Exactly-once guard: a loop journals on its FIRST terminal event only
	 *  (complete, or kill) — a later kill of an already-finished loop is a no-op. */
	recorded: boolean;
	/** No explicit rounds given: size the budget to criteria + 2 after round 0. */
	autoBudget: boolean;
	/** Verdict history for the status panel (bounded). */
	verdicts: Array<{ round: number; verdict: string; summary: string; took: number }>;
	/** git HEAD at loop start — the reviewer diffs against this. */
	baseline?: string;
	/** The orchestrator's last reply text (captured at turn_end). The verdict
	 *  line lives in the model's REPLY, not PROGRESS.md, so we parse it here. */
	lastMessage?: string;
	roundStartedAt: number;
	watchdog?: NodeJS.Timeout;
	unwatchWorkers?: () => void;
	notify: (text: string, level: "info" | "warning" | "error") => void;
}

let activeOrchestration: OrchestratedLoop | undefined;

function progressPath(loop: OrchestratedLoop): string {
	return `${loop.dir}/PROGRESS.md`;
}

function guardrailsPath(loop: OrchestratedLoop): string {
	return `${loop.dir}/GUARDRAILS.md`;
}

function criteriaPath(loop: OrchestratedLoop): string {
	return `${loop.dir}/criteria.json`;
}

interface Criterion {
	id: string;
	desc: string;
	verify?: string;
	passes?: boolean;
}

/** Read acceptance criteria; undefined when absent or unusable. */
function readCriteria(dir: string): Criterion[] | undefined {
	try {
		const parsed = JSON.parse(readFileSync(`${dir}/criteria.json`, "utf-8"));
		if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
		const items = parsed.filter((c): c is Criterion =>
			Boolean(c && typeof c.id === "string" && typeof c.desc === "string"),
		);
		return items.length > 0 ? items : undefined;
	} catch {
		return undefined;
	}
}

function criteriaStatus(loop: OrchestratedLoop): { total: number; passed: number; remaining: Criterion[] } | undefined {
	const items = readCriteria(loop.dir);
	if (!items) return undefined;
	const remaining = items.filter((c) => c.passes !== true);
	return { total: items.length, passed: items.length - remaining.length, remaining };
}

/** Run each criterion's `verify` command in the project root and set `passes`
 *  OBJECTIVELY from the exit code (0 = pass) — "verifiable automated checks, not
 *  agent self-assessment" (the SOTA loop-termination rule). This is the primary
 *  convergence signal, so the loop no longer depends on the model emitting a
 *  clean text verdict or honestly flipping passes. Criteria with no verify
 *  command keep their existing value. Persists the updated criteria.json. */
export function runCriteriaChecks(
	loop: OrchestratedLoop,
): { total: number; passed: number; allPass: boolean; failing: string[] } | undefined {
	const items = readCriteria(loop.dir);
	if (!items) return undefined;
	const cwd = loop.dir.split("/.pi/loops/")[0] || process.cwd();
	let changed = false;
	for (const c of items) {
		if (!c.verify) continue; // no command → leave the model-set value
		let ok = false;
		try {
			execFileSync("bash", ["-c", c.verify], { cwd, timeout: 60_000, stdio: "ignore" });
			ok = true; // exit 0 = pass
		} catch {
			ok = false; // non-zero / timeout = fail
		}
		if (c.passes !== ok) {
			c.passes = ok;
			changed = true;
		}
	}
	if (changed) {
		try {
			writeFileSync(criteriaPath(loop), `${JSON.stringify(items, null, 2)}\n`);
		} catch {
			// best-effort persistence
		}
	}
	const failing = items.filter((c) => c.passes !== true).map((c) => c.id);
	return { total: items.length, passed: items.length - failing.length, allPass: failing.length === 0, failing };
}

// ---- Offline optimizer state (shared across all loops in a repo) -----------
function optimizerDir(cwd: string): string {
	return `${cwd}/.pi/loops/_optimizer`;
}
function journalPath(cwd: string): string {
	return `${optimizerDir(cwd)}/journal.jsonl`;
}
function baselinePath(cwd: string): string {
	return `${optimizerDir(cwd)}/baseline-steps.json`;
}

/** Steps distilled from many past runs, pre-loaded into EVERY new loop's round
 *  prompt from round 1 (the offline optimizer's output). */
function loadBaselineSteps(cwd: string): BaselineStep[] {
	try {
		const parsed = JSON.parse(readFileSync(baselinePath(cwd), "utf-8"));
		if (Array.isArray(parsed)) return parsed.filter((b) => b && typeof b.text === "string");
	} catch {
		// none yet
	}
	return [];
}
function currentPromptVersion(steps: BaselineStep[]): number {
	return steps.reduce((max, s) => Math.max(max, s.version ?? 1), 1);
}
function loadJournal(cwd: string): RunRecord[] {
	try {
		return parseJournal(readFileSync(journalPath(cwd), "utf-8"));
	} catch {
		return [];
	}
}

/** Append this run's scored record — the offline optimizer's training data.
 *  Exactly-once: the first terminal event wins; a subsequent kill of an
 *  already-recorded loop must NOT double-count (it would skew recurrence). */
function appendRunRecord(loop: OrchestratedLoop, completed: boolean): void {
	if (loop.recorded) return;
	loop.recorded = true;
	const cwd = loop.dir.replace(/\/\.pi\/loops\/[^/]+$/, "");
	const record: RunRecord = {
		goal: loop.goal,
		promptVersion: loop.promptVersion,
		rounds: loop.round,
		rejections: loop.rejections,
		completed,
		learned: loop.learnedSteps.map((text) => ({ cls: classOfLearnedStep(text), text })),
	};
	try {
		mkdirSync(optimizerDir(cwd), { recursive: true });
		appendFileSync(journalPath(cwd), `${JSON.stringify(record)}\n`);
	} catch {
		// journal is best-effort
	}
}

/** Recover the failure class from a minted learned-step (they are 1:1). */
function classOfLearnedStep(text: string): string {
	if (text.includes("criterion's `verify`")) return "criteria";
	if (text.includes("independent review keeps")) return "review";
	if (text.includes("the gate keeps")) return "gate";
	return "other";
}

/** Persist enough state that `/loop resume <goal>` re-attaches after a pi
 *  restart — the Ralph principle: the loop's memory is the filesystem. */
function saveState(loop: OrchestratedLoop, status: string): void {
	try {
		writeFileSync(
			`${loop.dir}/state.json`,
			`${JSON.stringify(
				{
					goal: loop.goal,
					gate: loop.gate,
					repo: loop.repo,
					budget: loop.budget,
					round: loop.round,
					notes: loop.notes,
					reviewEnabled: loop.reviewEnabled,
					criteriaEnabled: loop.criteriaEnabled,
					reviewModel: loop.reviewModel,
					rejections: loop.rejections,
					failureCounts: loop.failureCounts,
					learnedSteps: loop.learnedSteps,
					verdicts: loop.verdicts.slice(-10),
					baseline: loop.baseline,
					status,
				},
				null,
				1,
			)}\n`,
		);
	} catch {
		// state is best-effort; the loop itself keeps running
	}
}

/** Append a distilled failure lesson to GUARDRAILS.md — every future round
 *  (and the reviewer) reads it, so the same mistake is not repeated. */
function addGuardrail(loop: OrchestratedLoop, lesson: string): void {
	try {
		appendFileSync(guardrailsPath(loop), `- [round ${loop.round}] ${lesson}\n`);
	} catch {
		// best-effort
	}
}

/** How many repeats of a failure class before the loop promotes its lesson
 *  from a passive guardrail into an explicit round-prompt step. */
const LEARN_THRESHOLD = Math.max(2, Number(process.env.PI_LOOP_LEARN_THRESHOLD ?? 2));

/** Online GEPA-lite: turn a recurring failure CLASS into a rewritten round-
 *  prompt instruction. A guardrail the model may skim becomes an un-skippable
 *  numbered step once the same class of failure repeats — the loop editing its
 *  own operating instructions from its own failures. Returns the minted step,
 *  or undefined when the class has not yet recurred / already produced one. */
function learnedStepFor(cls: string, evidence: string, gate?: string): string {
	switch (cls) {
		case "criteria":
			return `Before ANY "done" verdict: run each remaining criterion's \`verify\` command from criteria.json and PASTE its real output into PROGRESS.md. Only flip passes=true from pasted command output — never from assertion. (learned: repeated done claims left criteria unmet — ${evidence})`;
		case "review":
			return `Before ANY "done" verdict: self-review the FULL diff against every acceptance criterion and fix the RECURRING class of issue the reviewer keeps finding, not just the one instance. (learned: independent review keeps rejecting — ${evidence})`;
		case "gate":
			return `Before ANY "done" verdict: run \`devbrain flow goal ${gate ?? "<gate>"}\` yourself and make it GREEN, pasting the result into PROGRESS.md. Do not claim done on an unverified gate. (learned: the gate keeps rejecting — ${evidence})`;
		default:
			return `Recurring failure "${cls}" — address its root cause before the next "done" verdict. (${evidence})`;
	}
}

/** Record a rejection against its failure class; on the Nth repeat, rewrite the
 *  loop's round prompt with a learned step. Returns true when a step was minted. */
function recordFailure(loop: OrchestratedLoop, cls: string, evidence: string): boolean {
	const registry = getBackgroundProcessRegistry();
	const entry = loop.failureCounts[cls] ?? { count: 0, evidence };
	entry.count += 1;
	entry.evidence = evidence;
	loop.failureCounts[cls] = entry;
	if (entry.count < LEARN_THRESHOLD) return false;
	const step = learnedStepFor(cls, evidence, loop.gate);
	if (loop.learnedSteps.includes(step)) return false;
	loop.learnedSteps.push(step);
	registry.appendLog(
		loop.id,
		`✎ self-rewrite: '${cls}' failed ${entry.count}× — promoted a learned step into the round prompt`,
	);
	try {
		appendFileSync(guardrailsPath(loop), `- [round ${loop.round}] LEARNED STEP (${cls}×${entry.count}): ${step}\n`);
	} catch {
		// best-effort
	}
	loop.notify(`loop ${loop.goal}: rewrote its round prompt after repeated '${cls}' failures`, "info");
	return true;
}

/** Round 0: turn the one-line goal into machine-checkable acceptance criteria
 *  (Spec-Kit-style input discipline; done-ness becomes data, not prose). */
function criteriaPrompt(loop: OrchestratedLoop): string {
	const retry = loop.criteriaRetried
		? "\nYour previous attempt produced an unusable criteria.json — it MUST be a JSON array as specified below.\n"
		: "";
	return [
		`<loop-criteria loop="${loop.goal}">`,
		`You are setting up an autonomous loop. Goal: ${loop.goal}`,
		retry,
		"Before any work starts, define the acceptance criteria. Explore the code/context as needed, then",
		`write ${criteriaPath(loop)} as a JSON array of 3-8 items:`,
		'  [{ "id": "c1", "desc": "<specific, testable outcome>", "verify": "<the command/check that proves it>", "passes": false }]',
		"Rules:",
		"- Every criterion must be MACHINE-CHECKABLE (a command, test, or concrete observable) — no vibes.",
		"- Cover the goal completely: if all criteria pass, the goal is genuinely done.",
		'- All "passes" start false. They may only ever be flipped to true with verification evidence.',
		"Then end your reply with EXACTLY one line:",
		"CRITERIA_READY — <n> criteria defined",
		"</loop-criteria>",
	].join("\n");
}

/** Shared prompt sections for work rounds. */
function loopContractLines(loop: OrchestratedLoop): string[] {
	const gateLine = loop.gate
		? `A "done" verdict will be VERIFIED by running devbrain goal '${loop.gate}' — do not claim done unless that gate will pass.`
		: "";
	const reviewLine = loop.reviewEnabled
		? "A 'done' verdict triggers an INDEPENDENT fresh-context review of the whole loop's work before it is accepted — claims that don't survive scrutiny cost a round."
		: "";
	// Collaboration is done with PROMPTS, not a team construct: give each
	// worker a one-line role persona and (when useful) its own model via the
	// agent tool's model param. YOU are the only coordinator — never delegate
	// coordination to another coordinating agent (e.g. a team 'lead'); a
	// second coordinator wastes rounds and hides workers from the loop's
	// mirroring.
	const collabLine =
		"Workers: give each a one-line ROLE persona in its brief (e.g. scout: find+map only / builder: implement+test / qa: adversarial verify) and pick a per-worker model via the agent tool's model param when the role warrants it (cheap scout, strong builder). You are the ONLY coordinator — never delegate coordination to another coordinating agent.";
	const chainLine =
		"For a KNOWN multi-stage sub-task (e.g. plan→build→review), prefer running a chain (chain tool) over hand-dispatching stages — cheaper and reproducible.";
	const cs = criteriaStatus(loop);
	const criteriaLines = cs
		? [
				`Acceptance criteria: ${criteriaPath(loop)} — ${cs.passed}/${cs.total} passing.`,
				cs.remaining.length > 0
					? `Still failing: ${cs.remaining.map((c) => `${c.id} (${c.desc.slice(0, 60)})`).join("; ")}`
					: "All criteria pass.",
				"The LOOP runs each criterion's verify command ITSELF after your round and sets passes objectively — " +
					"you do NOT need to run them, paste evidence, or re-verify passing criteria. Spend the round making the " +
					"FAILING criteria true by doing the actual work; the loop handles verification and converges automatically.",
			]
		: [];
	// Promoted steps (offline optimizer): lessons distilled from MANY past runs,
	// pre-loaded from round 1 so this loop never has to re-learn them.
	const promotedLines =
		loop.baselineSteps.length > 0
			? [
					`STANDING LESSONS (v${loop.promptVersion}) — distilled from past runs, pre-loaded. Obey them from the start:`,
					...loop.baselineSteps.map((s, i) => `  P${i + 1}. ${s.text}`),
				]
			: [];
	// Learned steps (online GEPA-lite): instructions the loop rewrote into its
	// OWN prompt after a failure class recurred THIS run. Highest priority —
	// placed first, un-skippable, unlike the passive "go read the guardrails".
	const learnedLines =
		loop.learnedSteps.length > 0
			? [
					`LEARNED THIS RUN — the loop rewrote these steps into its own prompt after repeated failures. Obey them BEFORE anything else:`,
					...loop.learnedSteps.map((s, i) => `  L${i + 1}. ${s}`),
				]
			: [];
	return [
		...promotedLines,
		...learnedLines,
		`State file: ${progressPath(loop)} (read it first; it survives across rounds — context does not).`,
		`Guardrails file: ${guardrailsPath(loop)} (read it and honor EVERY rule — it is the loop's memory of past failures).`,
		...criteriaLines,
		collabLine,
		chainLine,
		gateLine,
		reviewLine,
	].filter(Boolean);
}

function roundPrompt(loop: OrchestratedLoop): string {
	const steering = loop.notes.length ? `\nOperator steering notes (honor these): ${loop.notes.join(" | ")}\n` : "";
	loop.notes = [];
	return [
		`<loop-round loop="${loop.goal}" round="${loop.round}" budget="${loop.budget}">`,
		`You are the ORCHESTRATOR of an autonomous loop. Goal: ${loop.goal}`,
		...loopContractLines(loop),
		steering,
		"This round: make ONE focused increment toward the FAILING criteria — do NOT re-verify or self-review.",
		"1. Read PROGRESS.md and GUARDRAILS.md briefly.",
		"2. Advance the failing criteria: dispatch a worker via the agent tool (worktree isolation for write",
		"   work) with a precise, self-contained brief — OR make the change directly if it is trivial.",
		"   SYNTHESIZE: read the findings yourself and give the worker exact file paths, line numbers, and the",
		"   change, plus a one-line PURPOSE. Send a failure back to the SAME worker via agent_message; spawn",
		"   FRESH for new tasks. You are the only coordinator.",
		"3. Append a SHORT note to PROGRESS.md (what changed this round). Do NOT run the criteria verify",
		"   commands, paste their output, or dispatch your own reviewer — the LOOP runs the verify commands",
		"   itself and runs an INDEPENDENT review after a done verdict. Re-verifying here wastes the round.",
		"4. End your reply with EXACTLY one line:",
		"   LOOP_VERDICT: done|continue|blocked — <short summary>",
		"   Say `done` once the failing criteria are addressed (the loop confirms objectively, then reviews);",
		"   `blocked` when a human decision is required (say what you need).",
		"Keep the round FOCUSED and SHORT: one increment, then the verdict. Do not gold-plate or re-audit.",
		"</loop-round>",
	].join("\n");
}

/** After repeated rejected done claims, single-trajectory iteration is stuck —
 *  switch to parallel candidates selected by execution evidence (CodeMonkeys/S* pattern). */
function bestOfNPrompt(loop: OrchestratedLoop): string {
	const steering = loop.notes.length ? `\nOperator steering notes (honor these): ${loop.notes.join(" | ")}\n` : "";
	loop.notes = [];
	return [
		`<loop-round loop="${loop.goal}" round="${loop.round}" budget="${loop.budget}" mode="best-of-n">`,
		`You are the ORCHESTRATOR of an autonomous loop. Goal: ${loop.goal}`,
		`${loop.rejections} consecutive "done" claims have been rejected — the current approach is stuck.`,
		"This round runs BEST-OF-N: independent candidates, selected by execution evidence.",
		...loopContractLines(loop),
		steering,
		"This round, do exactly this:",
		"1. Read PROGRESS.md and GUARDRAILS.md; identify exactly what keeps failing.",
		"2. Dispatch 2-3 workers IN PARALLEL via the agent tool, each in its OWN WORKTREE, each with a",
		"   DIFFERENT strategy for the failing part (say the strategy in each brief). Fresh context each.",
		"3. VERIFY each candidate by EXECUTION: run the failing criteria's verify checks / the devbrain",
		"   gate against each worktree. Prefer execution evidence over your own judgment; if two",
		"   candidates tie, construct a discriminating check that separates them and run it.",
		"4. Merge ONLY the winning candidate into the working tree; discard the others.",
		"5. Append to PROGRESS.md: strategies tried, per-candidate evidence, which won and why.",
		"   Add the distilled lesson from the losing candidates to GUARDRAILS.md.",
		"6. End your reply with EXACTLY one line:",
		"   LOOP_VERDICT: done|continue|blocked — <one-line summary>",
		"</loop-round>",
	].join("\n");
}

// A single DIRECT adversarial correctness review. Three defect-catch benchmarks
// (bench/defects.mjs single-file, bench/defects-multi.mjs cross-file) showed a
// capable model catches every defect, consistently, from a direct "find what's
// wrong" ask — and that an elaborate multi-lens ritual/panel added cost and
// variance without catching anything more, even on hard cross-file contract
// mismatches. So verification is one direct reviewer. (Same lesson as hashline:
// don't over-structure a strong model.)
function reviewPrompt(loop: OrchestratedLoop, claim: string): string {
	const diffLine = loop.baseline
		? `The loop started at git commit ${loop.baseline} — have the reviewer run \`git diff ${loop.baseline}\` to see ALL work the loop produced.`
		: "Have the reviewer inspect the work products listed in PROGRESS.md directly.";
	const modelLine = loop.reviewModel
		? `Spawn the reviewer with the agent tool's model parameter set to "${loop.reviewModel}" — a different model than the author, so the judge does not share the author's blind spots.`
		: "If a different model is configured for subagents, spawn the reviewer on it (the agent tool's model parameter) — a judge that does not share the author's blind spots.";
	const cs = criteriaStatus(loop);
	const criteriaLine = cs
		? `- Acceptance criteria live in ${criteriaPath(loop)}. Re-run the riskiest "verify" commands yourself against the actual deliverable and confirm they genuinely pass.`
		: "";
	return [
		`<loop-review loop="${loop.goal}" round="${loop.round}">`,
		`The loop just claimed DONE: "${claim}".`,
		"Before this claim is accepted, dispatch EXACTLY ONE fresh-context reviewer via the agent tool.",
		modelLine,
		"The reviewer is adversarial — its job is to find reasons the DELIVERABLE is wrong, not to confirm it.",
		"Give the reviewer a self-contained brief containing:",
		`- The goal: ${loop.goal}`,
		`- ${diffLine}`,
		criteriaLine,
		"- The acceptance criteria ARE the agreed definition of done, and they all PASS. Read the changed",
		"  code/artifacts and look for a CONCRETE DEFECT. You may fail this claim ONLY for one of:",
		"    (a) a real BUG in the deliverable — wrong output, crash, or a broken edge case (name the input);",
		"    (b) a criterion that passes but is GAMED — the deliverable satisfies the check without meeting",
		"        its intent (say exactly how).",
		"  You may NOT fail by re-interpreting the goal, inventing NEW requirements the criteria don't state,",
		"  or citing process / documentation / loop scaffolding (e.g. .pi/ files). If the deliverable is",
		"  correct and every criterion genuinely passes with no such defect, the verdict is PASS.",
		"  Verdict first, then at most 5 findings with file:line (concrete deliverable defects only).",
		"When the reviewer returns, append its findings to PROGRESS.md, then end your reply with EXACTLY one line:",
		"REVIEW_VERDICT: pass|fail — <one-line summary of the reviewer's verdict>",
		"Report the verdict honestly — do not soften a fail.",
		"</loop-review>",
	]
		.filter(Boolean)
		.join("\n");
}

async function startOrchestration(
	pi: ExtensionAPI,
	opts: {
		goal: string;
		rounds: number;
		cwd: string;
		gate?: string;
		repo?: string;
		review?: boolean;
		criteria?: boolean;
		reviewModel?: string;
		/** No explicit rounds: auto-size the budget to criteria + 2 after round 0. */
		autoBudget?: boolean;
		/** Resume: restore round/notes/baseline from a prior run's state.json. */
		restore?: {
			round: number;
			notes: string[];
			baseline?: string;
			rejections?: number;
			failureCounts?: Record<string, { count: number; evidence: string }>;
			learnedSteps?: string[];
		};
		notify: OrchestratedLoop["notify"];
	},
): Promise<string> {
	if (activeOrchestration && !activeOrchestration.killed) {
		return `an orchestrated loop is already running (${activeOrchestration.goal}) — kill it first`;
	}
	const registry = getBackgroundProcessRegistry();
	const dir = `${opts.cwd}/.pi/loops/${opts.goal.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 80) || "loop"}`;
	mkdirSync(dir, { recursive: true });
	if (!existsSync(`${dir}/PROGRESS.md`)) {
		writeFileSync(
			`${dir}/PROGRESS.md`,
			`# Loop: ${opts.goal}\n\nGoal: ${opts.goal}\nStarted: ${new Date().toISOString()}\n\n## Rounds\n`,
		);
	}
	if (!existsSync(`${dir}/GUARDRAILS.md`)) {
		writeFileSync(
			`${dir}/GUARDRAILS.md`,
			`# Guardrails: ${opts.goal}\n\nLessons from failed rounds — honor every rule.\n\n`,
		);
	}
	let baseline = opts.restore?.baseline;
	if (!baseline) {
		try {
			baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: opts.cwd, encoding: "utf-8" }).trim();
		} catch {
			// not a git repo — reviewer falls back to PROGRESS.md inspection
		}
	}
	const loop: OrchestratedLoop = {
		id: "",
		goal: opts.goal,
		gate: opts.gate,
		repo: opts.repo ?? DEFAULT_REPO,
		dir,
		budget: opts.rounds,
		round: opts.restore?.round ?? 0,
		notes: opts.restore?.notes ?? [],
		killed: false,
		parked: false,
		awaitingRound: false,
		phase: "round",
		reviewEnabled: opts.review !== false,
		criteriaEnabled: opts.criteria !== false,
		criteriaRetried: false,
		reviewModel: opts.reviewModel ?? process.env.PI_LOOP_REVIEW_MODEL,
		rejections: opts.restore?.rejections ?? 0,
		failureCounts: opts.restore?.failureCounts ?? {},
		learnedSteps: opts.restore?.learnedSteps ?? [],
		baselineSteps: loadBaselineSteps(opts.cwd),
		promptVersion: currentPromptVersion(loadBaselineSteps(opts.cwd)),
		recorded: false,
		autoBudget: opts.autoBudget === true && opts.restore === undefined,
		verdicts: [],
		baseline,
		roundStartedAt: 0,
		notify: opts.notify,
	};
	loop.id = registry.register({
		kind: "delegation",
		label: `↻ orchestrate ${opts.goal}`,
		summary: `orchestrated loop · ${dir}/PROGRESS.md · steer: "stop" | "more N" | notes`,
		onKill: () => {
			loop.killed = true;
			if (loop.watchdog) clearTimeout(loop.watchdog);
			loop.unwatchWorkers?.();
			registry.appendLog(loop.id, "[killed]");
			registry.setStatus(loop.id, "cancelled");
			saveState(loop, "cancelled");
			appendRunRecord(loop, false);
			activeOrchestration = undefined;
		},
		onSteer: (text: string) => {
			const t = text.trim();
			registry.appendLog(loop.id, `⇦ steer: ${t.slice(0, 80)}`);
			const more = /^more\s+(\d+)/i.exec(t);
			if (/^stop\b/i.test(t)) {
				loop.killed = true;
				if (loop.watchdog) clearTimeout(loop.watchdog);
				loop.unwatchWorkers?.();
				registry.setStatus(loop.id, "cancelled");
				saveState(loop, "cancelled");
				appendRunRecord(loop, false);
				activeOrchestration = undefined;
				return;
			}
			if (more) {
				loop.budget += Number(more[1]);
				registry.appendLog(loop.id, `budget → ${loop.budget}`);
			} else if (t) {
				loop.notes.push(t.slice(0, 200));
			}
			saveState(loop, loop.parked ? "parked" : "running");
			// Any steer wakes a parked loop (a note is often the ANSWER a
			// blocked round was waiting for), budget permitting.
			if (loop.parked && loop.round < loop.budget) {
				loop.parked = false;
				registry.setStatus(loop.id, "running");
				nextRound(pi, loop);
			}
		},
	});
	activeOrchestration = loop;
	saveState(loop, "running");
	// Round 0: define acceptance criteria first (unless disabled or already present).
	if (loop.criteriaEnabled && !readCriteria(loop.dir)) {
		dispatchCriteria(pi, loop);
	} else {
		nextRound(pi, loop);
	}
	const extras = [
		loop.gate ? `gate: ${loop.gate}` : "",
		loop.reviewEnabled ? "review: on" : "review: OFF",
		loop.criteriaEnabled ? "criteria: on" : "criteria: OFF",
		loop.reviewModel ? `review model: ${loop.reviewModel}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return `orchestrated loop '${opts.goal}' launched (${extras}) — Ctrl+Alt+A to watch/steer; state in ${dir}/PROGRESS.md`;
}

/** Re-attach a loop from a prior pi session using its state.json (Ralph:
 *  the filesystem, not the process, is the loop's memory). */
async function resumeOrchestration(
	pi: ExtensionAPI,
	opts: { goal?: string; cwd: string; notify: OrchestratedLoop["notify"] },
): Promise<string> {
	const loopsDir = `${opts.cwd}/.pi/loops`;
	let candidates: string[] = [];
	try {
		candidates = readdirSync(loopsDir).filter((d) => existsSync(`${loopsDir}/${d}/state.json`));
	} catch {
		return "no loops found (.pi/loops is empty)";
	}
	interface SavedState {
		goal: string;
		gate?: string;
		repo?: string;
		budget: number;
		round: number;
		notes: string[];
		reviewEnabled?: boolean;
		criteriaEnabled?: boolean;
		reviewModel?: string;
		rejections?: number;
		failureCounts?: Record<string, { count: number; evidence: string }>;
		learnedSteps?: string[];
		baseline?: string;
		status: string;
	}
	const states: SavedState[] = [];
	for (const d of candidates) {
		try {
			states.push(JSON.parse(readFileSync(`${loopsDir}/${d}/state.json`, "utf-8")));
		} catch {
			// unreadable state — skip
		}
	}
	// running/parked resume as-is; a COMPLETED loop can also be re-opened — that's
	// how you add a new acceptance criterion and tell the loop to keep going (the
	// added criterion fails its verify command, so the loop works to satisfy it).
	const resumable = states.filter((s) => s.status === "running" || s.status === "parked" || s.status === "completed");
	const target = opts.goal ? resumable.find((s) => s.goal === opts.goal) : resumable[0];
	if (!target) {
		const known = resumable.map((s) => s.goal).join(", ") || "none";
		return `nothing to resume${opts.goal ? ` for '${opts.goal}'` : ""} — resumable: ${known}`;
	}
	return startOrchestration(pi, {
		goal: target.goal,
		rounds: target.budget,
		cwd: opts.cwd,
		gate: target.gate,
		repo: target.repo,
		review: target.reviewEnabled !== false,
		criteria: target.criteriaEnabled !== false,
		reviewModel: target.reviewModel,
		restore: {
			round: target.round,
			notes: target.notes ?? [],
			baseline: target.baseline,
			rejections: target.rejections,
			failureCounts: target.failureCounts,
			learnedSteps: target.learnedSteps,
		},
		notify: opts.notify,
	}).then((msg) =>
		msg.startsWith("orchestrated") ? `resumed at round ${target.round}/${target.budget} — ${msg}` : msg,
	);
}

function setPhase(loop: OrchestratedLoop, phase: string): void {
	const registry = getBackgroundProcessRegistry();
	const elapsed = loop.roundStartedAt ? ` · ${Math.round((Date.now() - loop.roundStartedAt) / 1000)}s` : "";
	const cs = criteriaStatus(loop);
	const crit = cs ? ` · crit ${cs.passed}/${cs.total}` : "";
	registry.update(loop.id, {
		summary: `round ${loop.round}/${loop.budget} · ${phase}${crit}${elapsed}${loop.gate ? ` · gate: ${loop.gate}` : ""}`,
	});
}

/** Message details consumed by the rich renderers (loop-* custom messages). */
function messageDetails(loop: OrchestratedLoop, extra?: Record<string, unknown>): Record<string, unknown> {
	const cs = criteriaStatus(loop);
	return {
		loop: loop.goal,
		round: loop.round,
		budget: loop.budget,
		gate: loop.gate,
		criteria: cs ? { passed: cs.passed, total: cs.total } : undefined,
		learned: loop.learnedSteps.length,
		...extra,
	};
}

/** /loop status — a rich in-chat panel built from the loop's files, so it
 *  works for the live loop AND any saved loop after a restart. */
function sendStatusPanel(
	pi: ExtensionAPI,
	cwd: string,
	goal: string | undefined,
	notify: (text: string, level: "info" | "warning" | "error") => void,
): void {
	const loopsDir = `${cwd}/.pi/loops`;
	let dir: string | undefined;
	let name = goal;
	if (goal) {
		dir = `${loopsDir}/${goal.replace(/[^a-zA-Z0-9-]/g, "_")}`;
	} else if (activeOrchestration) {
		dir = activeOrchestration.dir;
		name = activeOrchestration.goal;
	} else {
		try {
			const dirs = readdirSync(loopsDir).filter((d) => existsSync(`${loopsDir}/${d}/state.json`));
			dir = dirs.length > 0 ? `${loopsDir}/${dirs[0]}` : undefined;
			name = dirs[0];
		} catch {
			// handled below
		}
	}
	if (!dir || !existsSync(`${dir}/state.json`)) {
		notify(`no loop state found${goal ? ` for '${goal}'` : ""} (.pi/loops)`, "error");
		return;
	}
	let state: Record<string, unknown> = {};
	try {
		state = JSON.parse(readFileSync(`${dir}/state.json`, "utf-8"));
	} catch {
		// panel renders what it can
	}
	const criteria = readCriteria(dir) ?? [];
	let guardrails = 0;
	try {
		guardrails = readFileSync(`${dir}/GUARDRAILS.md`, "utf-8")
			.split("\n")
			.filter((l) => l.startsWith("- ")).length;
	} catch {
		// zero
	}
	pi.sendMessage(
		{
			customType: "loop-status",
			content: `loop status: ${name}`,
			display: true,
			details: {
				goal: state.goal ?? name,
				status: state.status ?? "unknown",
				round: state.round ?? 0,
				budget: state.budget ?? 0,
				gate: state.gate,
				reviewModel: state.reviewModel,
				rejections: state.rejections ?? 0,
				learnedSteps: state.learnedSteps ?? [],
				verdicts: state.verdicts ?? [],
				criteria,
				guardrails,
				dir,
			},
		},
		{ triggerTurn: false },
	);
}

/** /loop optimize [apply] — the offline optimizer. Reads the run journal,
 *  distills failure classes that recurred across many runs into promotion
 *  proposals, shows the measured before/after effect of existing promotions,
 *  and (with apply) writes them into the baseline so every future loop starts
 *  pre-loaded. Cheap: distillation over recorded runs, no live re-runs. */
function runOptimizer(pi: ExtensionAPI, cwd: string, apply: boolean, notify: NotifyFn): void {
	const runs = loadJournal(cwd);
	if (runs.length === 0) {
		notify(
			"no loop runs recorded yet — run some orchestrated loops first (.pi/loops/_optimizer/journal.jsonl)",
			"info",
		);
		return;
	}
	const existing = loadBaselineSteps(cwd);
	const minRuns = Math.max(2, Number(process.env.PI_LOOP_OPTIMIZE_MIN_RUNS ?? 3));
	const proposals = distill(runs, existing, minRuns);
	const trend = versionTrend(runs);
	const effects = existing.map((step) => ({ step, ...recurrence(runs, step) }));

	let applied: Proposal[] = [];
	if (apply && proposals.length > 0) {
		const nextVersion = currentPromptVersion(existing) + 1;
		const promoted: BaselineStep[] = [
			...existing,
			...proposals.map((p) => ({ cls: p.cls, text: p.text, runs: p.runs, version: nextVersion })),
		];
		try {
			mkdirSync(optimizerDir(cwd), { recursive: true });
			writeFileSync(baselinePath(cwd), `${JSON.stringify(promoted, null, 2)}\n`);
			applied = proposals;
			notify(`optimizer: promoted ${proposals.length} step(s) into base prompt v${nextVersion}`, "info");
		} catch {
			notify("optimizer: failed to write baseline-steps.json", "error");
		}
	}

	pi.sendMessage(
		{
			customType: "loop-optimize",
			content: `loop optimizer (${runs.length} runs)`,
			display: true,
			details: {
				totalRuns: runs.length,
				minRuns,
				version: currentPromptVersion(existing),
				proposals: applied.length > 0 ? [] : proposals,
				applied,
				existing: effects,
				trend,
			},
		},
		{ triggerTurn: false },
	);
}

/** Mirror worker subagent lifecycle into the loop's own log while a round runs,
 *  so the loop entry alone tells the story (workers also appear in the hub). */
function watchWorkers(loop: OrchestratedLoop): void {
	const registry = getBackgroundProcessRegistry();
	const mine = new Set<string>();
	loop.unwatchWorkers = registry.subscribe((event) => {
		if (!loop.awaitingRound) return;
		if (event.type === "register" && event.entry.id !== loop.id && event.entry.kind === "subagent") {
			mine.add(event.entry.id);
			registry.appendLog(
				loop.id,
				`  → worker: ${event.entry.agentType ?? "agent"} — ${event.entry.label.slice(0, 60)}`,
			);
			setPhase(loop, `worker running (${event.entry.agentType ?? "agent"})`);
		}
		if (event.type === "statusChange" && mine.has(event.id)) {
			const worker = registry.get(event.id);
			if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
				registry.appendLog(loop.id, `  ← worker ${worker?.agentType ?? event.id}: ${event.status}`);
				setPhase(loop, "orchestrating");
			}
		}
	});
}

function nextRound(pi: ExtensionAPI, loop: OrchestratedLoop): void {
	const registry = getBackgroundProcessRegistry();
	if (loop.killed) return;
	if (loop.round >= loop.budget) {
		loop.parked = true;
		registry.setStatus(loop.id, "parked");
		saveState(loop, "parked");
		registry.update(loop.id, { summary: `parked at ${loop.round}/${loop.budget} — steer "more N" | "stop"` });
		registry.appendLog(loop.id, `parked: ${loop.round}/${loop.budget} rounds — steer "more N" or "stop"`);
		loop.notify(`orchestrated loop ${loop.goal}: parked after ${loop.round} rounds`, "warning");
		return;
	}
	loop.round += 1;
	loop.awaitingRound = true;
	loop.phase = "round";
	loop.roundStartedAt = Date.now();
	saveState(loop, "running");
	// Two consecutive rejected done claims ⇒ single-trajectory iteration is
	// stuck; escalate to parallel candidates selected by execution.
	const bestOfN = loop.rejections >= 2;
	registry.appendLog(
		loop.id,
		`— round ${loop.round}/${loop.budget} dispatched${bestOfN ? ` (BEST-OF-N after ${loop.rejections} rejections)` : ""}`,
	);
	setPhase(loop, bestOfN ? "best-of-n candidates" : "orchestrating");
	watchWorkers(loop);
	armWatchdog(loop);
	pi.sendMessage(
		{
			customType: "loop-round",
			content: bestOfN ? bestOfNPrompt(loop) : roundPrompt(loop),
			display: true,
			details: messageDetails(loop, { bestOfN }),
		},
		{ triggerTurn: true },
	);
}

/** Round 0: dispatch the criteria-definition phase (does not consume budget). */
function dispatchCriteria(pi: ExtensionAPI, loop: OrchestratedLoop): void {
	const registry = getBackgroundProcessRegistry();
	if (loop.killed) return;
	loop.awaitingRound = true;
	loop.phase = "criteria";
	loop.roundStartedAt = Date.now();
	registry.appendLog(loop.id, `— defining acceptance criteria (round 0)`);
	setPhase(loop, "defining acceptance criteria");
	watchWorkers(loop);
	armWatchdog(loop);
	pi.sendMessage(
		{
			customType: "loop-criteria",
			content: criteriaPrompt(loop),
			display: true,
			details: messageDetails(loop),
		},
		{ triggerTurn: true },
	);
}

/** Watchdog: a dispatch that never settles parks the loop instead of hanging it. */
function armWatchdog(loop: OrchestratedLoop): void {
	const registry = getBackgroundProcessRegistry();
	loop.watchdog = setTimeout(() => {
		if (!loop.awaitingRound || loop.killed) return;
		loop.awaitingRound = false;
		loop.unwatchWorkers?.();
		loop.parked = true;
		registry.setStatus(loop.id, "parked");
		saveState(loop, "parked");
		registry.appendLog(
			loop.id,
			`[${loop.phase} ${loop.round} timed out after ${Math.round(ROUND_TIMEOUT_MS / 60000)}m — parked]`,
		);
		loop.notify(`orchestrated loop ${loop.goal}: ${loop.phase} ${loop.round} timed out — parked`, "warning");
	}, ROUND_TIMEOUT_MS);
	loop.watchdog.unref?.();
}

/** Independent verification of a "done" claim: dispatch a fresh-context
 *  adversarial reviewer before the claim is accepted. */
function dispatchReview(pi: ExtensionAPI, loop: OrchestratedLoop, claim: string): void {
	const registry = getBackgroundProcessRegistry();
	loop.awaitingRound = true;
	loop.phase = "review";
	loop.roundStartedAt = Date.now();
	registry.appendLog(loop.id, `— done claimed: dispatching independent review`);
	setPhase(loop, "reviewing done claim");
	watchWorkers(loop);
	armWatchdog(loop);
	pi.sendMessage(
		{
			customType: "loop-review",
			content: reviewPrompt(loop, claim),
			display: true,
			details: messageDetails(loop, { reviewModel: loop.reviewModel }),
		},
		{ triggerTurn: true },
	);
}

/** Run the devbrain gate; on failure return the triage evidence. */
async function runGate(loop: OrchestratedLoop): Promise<{ ok: boolean; evidence: string }> {
	const handle: LoopHandle = { steers: [], killed: false };
	const { out } = await runDevbrain(
		["--repo", loop.repo, "flow", "goal", loop.gate as string, "--no-journal"],
		handle,
	);
	let ok = false;
	let evidence = "gate produced no report";
	try {
		const report = JSON.parse(out) as {
			ok?: boolean;
			steps?: Array<{ block?: string; triage?: string; detail?: string }>;
		};
		ok = Boolean(report.ok);
		if (!ok) {
			const failed = (report.steps ?? []).find((s) => s.triage);
			evidence = `${failed?.block ?? "?"} [${failed?.triage ?? "?"}]: ${String(failed?.detail ?? "").slice(0, 120)}`;
		}
	} catch {
		// keep defaults
	}
	return { ok, evidence };
}

/** Accept the done claim: criteria data, review (if enabled) and gate (if set) all agree. */
function completeLoop(loop: OrchestratedLoop, summary: string): void {
	const registry = getBackgroundProcessRegistry();
	const cs = criteriaStatus(loop);
	registry.setStatus(loop.id, "completed");
	registry.update(loop.id, {
		summary:
			`done after ${loop.round}/${loop.budget} rounds` +
			`${cs ? ` · criteria ${cs.passed}/${cs.total} ✓` : ""}` +
			`${loop.reviewEnabled ? " · review ✓" : ""}${loop.gate ? " · gate ✓" : ""}`,
	});
	saveState(loop, "completed");
	appendRunRecord(loop, true);
	loop.notify(`orchestrated loop ${loop.goal}: DONE after ${loop.round} round(s) — ${summary}`, "info");
	activeOrchestration = undefined;
}

async function settleRound(pi: ExtensionAPI, loop: OrchestratedLoop): Promise<void> {
	const registry = getBackgroundProcessRegistry();
	if (loop.killed || !loop.awaitingRound) return;
	loop.awaitingRound = false;
	if (loop.watchdog) clearTimeout(loop.watchdog);
	loop.unwatchWorkers?.();
	const took = Math.round((Date.now() - loop.roundStartedAt) / 1000);
	let progressText = "";
	try {
		progressText = readFileSync(progressPath(loop), "utf-8");
	} catch {
		// keep empty — defaults below handle it
	}
	// The verdict line lives in the orchestrator's REPLY; PROGRESS.md is a
	// fallback in case the model wrote it there instead. The reply goes LAST so
	// that "take the last match" prefers THIS round's reply over any stale
	// verdict line accumulated in PROGRESS.md.
	const verdictText = `${progressText}\n${loop.lastMessage ?? ""}`;

	// -------- criteria settle: round 0 must have produced a usable criteria.json
	if (loop.phase === "criteria") {
		const items = readCriteria(loop.dir);
		if (items) {
			registry.appendLog(loop.id, `criteria defined (${took}s): ${items.map((c) => c.id).join(", ")}`);
			// Auto-budget (the design doctrine, encoded): one round per criterion
			// plus integration plus the review cycle — only when the user gave
			// no explicit rounds.
			if (loop.autoBudget) {
				loop.budget = Math.min(AUTO_BUDGET_MAX, Math.max(AUTO_BUDGET_MIN, items.length + 2));
				registry.appendLog(loop.id, `budget auto-sized: ${loop.budget} rounds (${items.length} criteria + 2)`);
			}
			nextRound(pi, loop);
			return;
		}
		if (!loop.criteriaRetried) {
			loop.criteriaRetried = true;
			registry.appendLog(loop.id, `[criteria.json missing/unusable after round 0 — retrying once]`);
			dispatchCriteria(pi, loop);
			return;
		}
		registry.appendLog(loop.id, `[criteria unusable after retry — continuing WITHOUT criteria gating]`);
		loop.criteriaEnabled = false;
		nextRound(pi, loop);
		return;
	}

	// -------- review settle: the done claim faces its independent reviewer -----
	if (loop.phase === "review") {
		const matches = [...verdictText.matchAll(/REVIEW_VERDICT:\s*(pass|fail)\s*[—-]\s*(.*)/gi)];
		const last = matches[matches.length - 1];
		const reviewVerdict = last ? last[1].toLowerCase() : "fail";
		const reviewSummary = last ? last[2].slice(0, 120) : "(no REVIEW_VERDICT found — treating as fail)";
		registry.appendLog(loop.id, `review (${took}s): ${reviewVerdict} — ${reviewSummary}`);
		loop.verdicts.push({ round: loop.round, verdict: `review:${reviewVerdict}`, summary: reviewSummary, took });

		// EXOGENOUS verification is the gate — NOT the LLM reviewer. The field is
		// clear (SWE-agent/OpenHands terminate on tests; recursive self-review
		// collapses): a model reviewing a model oscillates via agreeableness bias
		// and "fixing" what isn't broken. So the independent review is ADVISORY —
		// if the objective criteria all still pass, the loop COMPLETES regardless
		// of the reviewer's opinion (its findings are logged). Only a criterion
		// that actually FAILS its verify command reopens the loop.
		const objective = runCriteriaChecks(loop);
		if (objective && !objective.allPass) {
			loop.rejections += 1;
			const failing = objective.failing.join(", ");
			registry.appendLog(loop.id, `✗ criteria still failing: ${failing} — another round`);
			addGuardrail(loop, `criteria unmet after review: ${failing}`);
			recordFailure(loop, "criteria", failing);
			loop.notes.push(
				`These acceptance criteria FAIL when the loop runs their verify commands: ${failing}. Make them pass.`,
			);
			nextRound(pi, loop);
			return;
		}
		if (reviewVerdict !== "pass") {
			registry.appendLog(
				loop.id,
				`review raised concerns but all ${objective?.total ?? 0} criteria objectively pass — ADVISORY, not blocking: ${reviewSummary}`,
			);
		}
		// All exogenous criteria pass. A devbrain gate (if configured) is ALSO
		// exogenous, so it still gates.
		if (loop.gate) {
			setPhase(loop, `gating: devbrain goal '${loop.gate}'`);
			const gate = await runGate(loop);
			if (!gate.ok) {
				loop.rejections += 1;
				registry.appendLog(loop.id, `✗ done claim REJECTED by gate '${loop.gate}' — ${gate.evidence.slice(0, 80)}`);
				addGuardrail(loop, `gate '${loop.gate}' rejected a done claim: ${gate.evidence}`);
				recordFailure(loop, "gate", gate.evidence);
				loop.notes.push(
					`Your previous "done" claim passed review but FAILED the verification gate '${loop.gate}': ${gate.evidence}. Fix that first.`,
				);
				nextRound(pi, loop);
				return;
			}
			registry.appendLog(loop.id, `✓ gate '${loop.gate}' PASSED`);
		}
		completeLoop(loop, reviewSummary);
		return;
	}

	// -------- round settle: parse the orchestrator's verdict -------------------
	const parsed = parseLoopVerdict(verdictText);
	const verdict = parsed?.verdict ?? "continue";
	const summary = parsed?.summary ?? "(no LOOP_VERDICT line in the reply — continuing)";
	registry.appendLog(loop.id, `round ${loop.round} (${took}s): ${verdict} — ${summary}`);
	loop.verdicts.push({ round: loop.round, verdict, summary, took });

	if (verdict === "blocked") {
		// Human decision required: park immediately, regardless of budget.
		loop.parked = true;
		registry.setStatus(loop.id, "parked");
		saveState(loop, "parked");
		registry.update(loop.id, { summary: `BLOCKED: ${summary.slice(0, 60)} — steer to answer` });
		loop.notify(`orchestrated loop ${loop.goal}: BLOCKED — ${summary}`, "warning");
		return;
	}

	// PRIMARY convergence signal — run the criteria's OWN verify commands and set
	// passes objectively (SOTA rule: verifiable checks, not agent self-assessment).
	// This lets the loop converge without depending on the model emitting a clean
	// text verdict (the fragile signal that stalled real runs). Without criteria,
	// fall back to the model's verdict.
	const checked = runCriteriaChecks(loop);
	if (checked) {
		registry.appendLog(
			loop.id,
			`criteria checked: ${checked.passed}/${checked.total} pass${checked.failing.length ? ` (failing ${checked.failing.join(",")})` : ""}`,
		);
	}
	const objectivelyDone = checked ? checked.allPass : verdict === "done";
	// A model "done" claim the checks contradict is rejected with the failing ids.
	if (verdict === "done" && checked && !checked.allPass) {
		loop.rejections += 1;
		addGuardrail(loop, `claimed done but verify commands still fail: ${checked.failing.join(", ")}`);
		recordFailure(loop, "criteria", checked.failing.join(", "));
		loop.notes.push(
			`Your "done" claim is rejected: I ran the criteria verify commands myself and these still FAIL: ${checked.failing.join(", ")}. Make them pass.`,
		);
	}

	if (objectivelyDone) {
		// Verified-done, stage 0 (free): the criteria data must agree. A prose
		// claim cannot outrank criteria.json — remaining criteria reject it
		// before any review tokens are spent.
		const cs = criteriaStatus(loop);
		if (cs && cs.remaining.length > 0) {
			loop.rejections += 1;
			const remaining = cs.remaining.map((c) => c.id).join(", ");
			registry.appendLog(
				loop.id,
				`✗ done claim REJECTED mechanically — criteria ${cs.passed}/${cs.total} (remaining: ${remaining})`,
			);
			addGuardrail(loop, `claimed done with unmet criteria: ${remaining}`);
			recordFailure(loop, "criteria", remaining);
			loop.notes.push(
				`Your "done" claim was rejected WITHOUT review: criteria.json still has ${cs.remaining.length} unmet criteria (${remaining}). Meet them (with verification evidence) or explain in PROGRESS.md why a criterion is obsolete and update its desc — never delete criteria.`,
			);
			nextRound(pi, loop);
			return;
		}
		// Stage 1: independent fresh-context review of the claim.
		if (loop.reviewEnabled) {
			dispatchReview(pi, loop, summary);
			return;
		}
		// Review disabled → straight to the mechanical gate (if any).
		if (loop.gate) {
			setPhase(loop, `gating: devbrain goal '${loop.gate}'`);
			const gate = await runGate(loop);
			if (!gate.ok) {
				loop.rejections += 1;
				registry.appendLog(loop.id, `✗ done claim REJECTED by gate '${loop.gate}' — ${gate.evidence.slice(0, 80)}`);
				addGuardrail(loop, `gate '${loop.gate}' rejected a done claim: ${gate.evidence}`);
				recordFailure(loop, "gate", gate.evidence);
				loop.notes.push(
					`Your previous "done" claim FAILED the verification gate '${loop.gate}': ${gate.evidence}. Fix that first.`,
				);
				nextRound(pi, loop);
				return;
			}
			registry.appendLog(loop.id, `✓ gate '${loop.gate}' PASSED`);
		}
		completeLoop(loop, summary);
		return;
	}
	nextRound(pi, loop);
}

const loopSchema = Type.Object({
	goal: Type.String({ description: "goal: a devbrain capability (verify mode) or any objective (orchestrate mode)" }),
	rounds: Type.Optional(Type.Number({ description: "round budget before parking (default 5)" })),
	repo: Type.Optional(Type.String({ description: "product repo (default: testing-automations)" })),
	mode: Type.Optional(
		Type.Unsafe<"verify" | "orchestrate">({
			type: "string",
			enum: ["verify", "orchestrate"],
			description:
				"orchestrate (DEFAULT) = LLM decides each round, dispatches fresh-context workers; verify = devbrain-gated retry loop",
		}),
	),
	gate: Type.Optional(
		Type.String({
			description:
				"orchestrate: devbrain capability that must PASS before a 'done' claim is accepted (verified-done)",
		}),
	),
	review: Type.Optional(
		Type.Boolean({
			description:
				"orchestrate: independent fresh-context review of every 'done' claim before acceptance (default true)",
		}),
	),
	criteria: Type.Optional(
		Type.Boolean({
			description:
				"orchestrate: round 0 generates machine-checkable acceptance criteria (criteria.json); done claims are mechanically rejected while any criterion is unmet (default true)",
		}),
	),
	reviewModel: Type.Optional(
		Type.String({
			description: "orchestrate: model for the done-claim reviewer (judge diversity; default $PI_LOOP_REVIEW_MODEL)",
		}),
	),
});

type LoopInput = Static<typeof loopSchema>;

interface LoopChipDetails {
	loop?: string;
	round?: number;
	budget?: number;
	gate?: string;
	criteria?: { passed: number; total: number };
	bestOfN?: boolean;
	reviewModel?: string;
	learned?: number;
}

interface LoopStatusDetails {
	goal?: string;
	status?: string;
	round?: number;
	budget?: number;
	gate?: string;
	reviewModel?: string;
	rejections?: number;
	learnedSteps?: string[];
	verdicts?: Array<{ round: number; verdict: string; summary: string; took: number }>;
	criteria?: Criterion[];
	guardrails?: number;
	dir?: string;
}

interface LoopOptimizeDetails {
	totalRuns?: number;
	minRuns?: number;
	version?: number;
	proposals?: Proposal[];
	applied?: Proposal[];
	existing?: Array<{ step: BaselineStep; before: string; after: string }>;
	trend?: Array<{ version: number; runs: number; meanScore: number }>;
}

// ---- /loop panel — the fullscreen, live, STEERABLE loop view -----------------

export interface LoopPanelLoop {
	dir: string;
	goal: string;
	status: string;
	round: number;
	budget: number;
	rejections: number;
	criteria: Array<{ id: string; desc: string; passes: boolean }>;
	verdicts: Array<{ round: number; verdict: string; summary: string; took: number }>;
}

/** Pure data model for the panel: every loop in this project with its live
 *  state + criteria, running loops first. Read from files so it works for
 *  running, parked, and completed loops alike. */
export function loopPanelModel(cwd: string): LoopPanelLoop[] {
	const loopsDir = `${cwd}/.pi/loops`;
	let dirs: string[];
	try {
		dirs = readdirSync(loopsDir).filter((d) => d !== "_optimizer" && existsSync(`${loopsDir}/${d}/state.json`));
	} catch {
		return [];
	}
	const out: LoopPanelLoop[] = [];
	for (const d of dirs) {
		const dir = `${loopsDir}/${d}`;
		try {
			const s = JSON.parse(readFileSync(`${dir}/state.json`, "utf-8"));
			const crit = readCriteria(dir) ?? [];
			out.push({
				dir,
				goal: typeof s.goal === "string" ? s.goal : d,
				status: typeof s.status === "string" ? s.status : "?",
				round: Number(s.round ?? 0),
				budget: Number(s.budget ?? 0),
				rejections: Number(s.rejections ?? 0),
				criteria: crit.map((c) => ({ id: c.id, desc: c.desc, passes: c.passes === true })),
				verdicts: Array.isArray(s.verdicts) ? s.verdicts : [],
			});
		} catch {
			// skip an unreadable loop dir
		}
	}
	return out.sort((a, b) => (b.status === "running" ? 1 : 0) - (a.status === "running" ? 1 : 0));
}

type PanelTheme = Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1];

class LoopPanelComponent implements Component {
	private idx = 0;
	private scroll = 0;
	private mode: "view" | "note" | "criterion" = "view";
	private input = "";
	private msg = "";
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly unsub: () => void;
	private readonly tui: TUI;
	private readonly theme: PanelTheme;
	private readonly done: (r: undefined) => void;
	private readonly pi: ExtensionAPI;
	private readonly cwd: string;

	// No parameter properties — the extension loader (type-stripping) rejects them.
	constructor(
		tui: TUI,
		theme: PanelTheme,
		_keybindings: KeybindingsManager,
		done: (r: undefined) => void,
		pi: ExtensionAPI,
		cwd: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.pi = pi;
		this.cwd = cwd;
		this.timer = setInterval(() => this.tui.requestRender(), 1500);
		this.unsub = getBackgroundProcessRegistry().subscribe(() => this.tui.requestRender());
	}
	dispose(): void {
		clearInterval(this.timer);
		this.unsub();
	}
	invalidate(): void {}

	private current(): LoopPanelLoop | undefined {
		const loops = loopPanelModel(this.cwd);
		if (this.idx >= loops.length) this.idx = Math.max(0, loops.length - 1);
		return loops[this.idx];
	}

	/** Steer the RUNNING loop via the registry (stop / more N / a note). */
	private steer(text: string): void {
		if (activeOrchestration && !activeOrchestration.killed) {
			getBackgroundProcessRegistry().steer(activeOrchestration.id, text);
			this.msg = `steered: ${text}`;
		} else {
			this.msg = "no running loop to steer — use r to resume";
		}
	}

	private resume(loop: LoopPanelLoop): void {
		this.msg = `resuming ${loop.goal.slice(0, 30)}…`;
		void resumeOrchestration(this.pi, { goal: loop.goal, cwd: this.cwd, notify: () => {} });
	}

	/** Append a criterion (input: "desc | verify command") and kick the loop.
	 *  Split on the FIRST pipe only — verify commands routinely contain pipes. */
	private addCriterion(loop: LoopPanelLoop, raw: string): void {
		const sep = raw.indexOf("|");
		const desc = (sep < 0 ? raw : raw.slice(0, sep)).trim();
		const verify = sep < 0 ? "" : raw.slice(sep + 1).trim();
		if (!desc) return;
		try {
			const items = readCriteria(loop.dir) ?? [];
			const id = `c${items.length + 1}`;
			items.push({ id, desc, verify: verify || undefined, passes: false });
			writeFileSync(`${loop.dir}/criteria.json`, `${JSON.stringify(items, null, 2)}\n`);
			this.msg = `added ${id}: ${desc.slice(0, 30)} — ${loop.status === "running" ? "loop will pick it up" : "press r to resume"}`;
			if (loop.status === "running") this.steer(`new acceptance criterion added (${id}) — satisfy it`);
		} catch {
			this.msg = "failed to write criterion";
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const pad = (s: string) => truncateToWidth(s, width);
		const lines: string[] = [];
		const loops = loopPanelModel(this.cwd);
		lines.push(pad(t.fg("accent", t.bold(" Loop "))));
		lines.push(heatLine(Math.min(width, 64)));
		if (loops.length === 0) {
			lines.push(pad(t.fg("muted", "  No loops in this project. Start one with /loop <goal>.")));
			lines.push("");
			lines.push(pad(t.fg("dim", "  q/Esc close")));
			return lines;
		}
		const loop = loops[Math.min(this.idx, loops.length - 1)];
		const sel = loops.length > 1 ? t.fg("dim", `  [${this.idx + 1}/${loops.length}] ←/→ switch`) : "";
		const statusColor = loop.status === "completed" ? "success" : loop.status === "parked" ? "warning" : "accent";
		lines.push(pad(`  ${t.fg("text", t.bold(loop.goal.slice(0, width - 6)))}`));
		lines.push(
			pad(
				`  ${t.fg(statusColor, loop.status)} · round ${loop.round}/${loop.budget} · ${loop.rejections} rejection(s)${sel}`,
			),
		);
		lines.push("");
		const passed = loop.criteria.filter((c) => c.passes).length;
		lines.push(pad(t.fg("muted", `  ${t.bold("Acceptance criteria")} · ${passed}/${loop.criteria.length} pass`)));
		const critView = loop.criteria.slice(this.scroll, this.scroll + 10);
		for (const c of critView) {
			const mark = c.passes ? t.fg("success", "✓") : t.fg("warning", "✗");
			lines.push(pad(`   ${mark} ${t.fg("dim", c.id)} ${t.fg("text", c.desc.slice(0, width - 10))}`));
		}
		if (loop.criteria.length > 10) lines.push(pad(t.fg("dim", `   …${loop.criteria.length} total · ↑/↓ scroll`)));
		lines.push("");
		lines.push(pad(t.fg("muted", `  ${t.bold("Rounds")}`)));
		const rounds = loop.verdicts.slice(-8);
		if (rounds.length === 0) lines.push(pad(t.fg("dim", "   (none yet)")));
		for (const v of rounds) {
			const vc = v.verdict.includes("fail") || v.verdict === "blocked" ? "warning" : "success";
			lines.push(
				pad(
					`   ${t.fg("dim", `r${v.round}`)} ${t.fg(vc, v.verdict)} ${t.fg("dim", `(${v.took}s)`)} ${t.fg("text", (v.summary || "").slice(0, width - 20))}`,
				),
			);
		}
		lines.push("");
		if (this.mode !== "view") {
			const label = this.mode === "note" ? "steer note" : "add criterion (desc | verify cmd)";
			lines.push(pad(t.fg("accent", `  ${label} › `) + this.input + t.fg("accent", "█")));
			lines.push(pad(t.fg("dim", "  Enter to apply · Esc to cancel")));
		} else {
			if (this.msg) lines.push(pad(t.fg("dim", `  ${this.msg}`)));
			lines.push(
				pad(
					t.fg("dim", "  s stop · m more · r resume · a add-criterion · n note · ↑/↓ scroll · ←/→ loop · q close"),
				),
			);
		}
		return lines;
	}

	handleInput(data: string): void {
		const loop = this.current();
		if (this.mode !== "view") {
			if (matchesKey(data, "escape")) {
				this.mode = "view";
				this.input = "";
			} else if (matchesKey(data, "return")) {
				const text = this.input.trim();
				if (loop && text) {
					if (this.mode === "note") this.steer(text);
					else this.addCriterion(loop, text);
				}
				this.mode = "view";
				this.input = "";
			} else if (matchesKey(data, "backspace")) {
				this.input = this.input.slice(0, -1);
			} else if (!data.startsWith("\x1b")) {
				for (const ch of data) if (ch >= " " && ch !== "\x7f") this.input += ch;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "down")) this.scroll += 1;
		else if (matchesKey(data, "left")) {
			this.idx = Math.max(0, this.idx - 1);
			this.scroll = 0;
		} else if (matchesKey(data, "right")) {
			this.idx += 1;
			this.scroll = 0;
		} else if (data === "s") this.steer("stop");
		else if (data === "m") this.steer("more 3");
		else if (data === "r" && loop) this.resume(loop);
		else if (data === "a") {
			this.mode = "criterion";
			this.input = "";
		} else if (data === "n") {
			this.mode = "note";
			this.input = "";
		}
		this.tui.requestRender();
	}
}

function openLoopPanel(ctx: ExtensionContext, pi: ExtensionAPI): Promise<undefined> {
	return ctx.ui.custom<undefined>(
		(tui, theme, keybindings, done) => new LoopPanelComponent(tui, theme, keybindings, done, pi, ctx.cwd),
		{ drawer: { height: "50%" } },
	);
}

export default function (pi: ExtensionAPI) {
	// ---- Rich TUI: forge-styled chips for loop dispatches (collapsed by
	// default; ctrl+o expands to the exact prompt the orchestrator received),
	// and a status panel for /loop status. ----
	const chip = (
		glyph: string,
		headline: string,
		body: string,
		expanded: boolean,
		theme: Parameters<Parameters<typeof pi.registerMessageRenderer>[1]>[2],
	) => {
		const head = `${copper("▎")} ${glyph} ${theme.fg("text", headline)}${expanded ? "" : ` ${theme.fg("dim", "· ctrl+o prompt")}`}`;
		return new Text(
			expanded ? `${head}\n${heatLine(46)}\n${theme.fg("dim", body)}` : `${head}\n${heatLine(46)}`,
			0,
			0,
		);
	};
	const chipMeta = (
		d: LoopChipDetails | undefined,
		theme: Parameters<Parameters<typeof pi.registerMessageRenderer>[1]>[2],
	) => {
		const bits = [
			d?.round !== undefined && d?.budget ? `round ${d.round}/${d.budget}` : "",
			d?.criteria ? `criteria ${d.criteria.passed}/${d.criteria.total}` : "",
			d?.gate ? `gate ${d.gate}` : "",
			d?.bestOfN ? theme.fg("warning", "BEST-OF-N") : "",
			d?.reviewModel ? `judge ${d.reviewModel}` : "",
			d?.learned ? theme.fg("accent", `✎ ${d.learned} learned`) : "",
		].filter(Boolean);
		return bits.join(" · ");
	};
	pi.registerMessageRenderer<LoopChipDetails>("loop-round", (message, options, theme) => {
		const d = message.details;
		const text = typeof message.content === "string" ? message.content : "";
		return chip("↻", `loop ${d?.loop ?? ""} · ${chipMeta(d, theme)}`, text, Boolean(options.expanded), theme);
	});
	pi.registerMessageRenderer<LoopChipDetails>("loop-review", (message, options, theme) => {
		const d = message.details;
		const text = typeof message.content === "string" ? message.content : "";
		return chip(
			"⚖",
			`loop ${d?.loop ?? ""} · reviewing done claim · ${chipMeta(d, theme)}`,
			text,
			Boolean(options.expanded),
			theme,
		);
	});
	pi.registerMessageRenderer<LoopChipDetails>("loop-criteria", (message, options, theme) => {
		const d = message.details;
		const text = typeof message.content === "string" ? message.content : "";
		return chip("◇", `loop ${d?.loop ?? ""} · defining acceptance criteria`, text, Boolean(options.expanded), theme);
	});
	pi.registerMessageRenderer<LoopStatusDetails>("loop-status", (message, _options, theme) => {
		const d = message.details ?? {};
		const lines: string[] = [];
		const statusColor = d.status === "completed" ? "success" : d.status === "parked" ? "warning" : "accent";
		lines.push(
			`${copper("▎")} ↻ ${theme.fg("text", `loop ${d.goal ?? "?"}`)} · ${theme.fg(statusColor, d.status ?? "?")} · round ${d.round ?? 0}/${d.budget ?? 0}` +
				`${d.gate ? ` · gate ${d.gate}` : ""}${d.reviewModel ? ` · judge ${d.reviewModel}` : ""}` +
				`${d.rejections ? ` · ${theme.fg("warning", `${d.rejections} rejected claim(s)`)}` : ""}`,
		);
		lines.push(heatLine(46));
		const criteria = d.criteria ?? [];
		if (criteria.length > 0) {
			lines.push(theme.fg("muted", "acceptance criteria"));
			for (const c of criteria) {
				const mark = c.passes === true ? theme.fg("success", "✓") : theme.fg("dim", "·");
				lines.push(`  ${mark} ${theme.fg(c.passes === true ? "text" : "dim", `${c.id} — ${c.desc.slice(0, 70)}`)}`);
			}
		}
		const learned = d.learnedSteps ?? [];
		if (learned.length > 0) {
			lines.push(theme.fg("accent", `✎ self-rewritten steps (${learned.length}) — learned from repeated failures`));
			for (const s of learned) {
				lines.push(`  ${theme.fg("accent", "L")} ${theme.fg("text", s.slice(0, 88))}`);
			}
		}
		const verdicts = (d.verdicts ?? []).slice(-5);
		if (verdicts.length > 0) {
			lines.push(theme.fg("muted", "recent verdicts"));
			for (const v of verdicts) {
				const color = /done|pass/.test(v.verdict) ? "success" : /blocked|fail/.test(v.verdict) ? "error" : "dim";
				lines.push(
					`  ${theme.fg(color, v.verdict.padEnd(12))} r${v.round} ${theme.fg("dim", `${v.took}s — ${v.summary.slice(0, 60)}`)}`,
				);
			}
		}
		lines.push(theme.fg("dim", `${d.guardrails ?? 0} guardrail(s) · ${d.dir ?? ""}`));
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerMessageRenderer<LoopOptimizeDetails>("loop-optimize", (message, _options, theme) => {
		const d = message.details ?? {};
		const lines: string[] = [];
		lines.push(
			`${copper("▎")} ⚙ ${theme.fg("text", "loop optimizer")} · ${theme.fg("muted", `${d.totalRuns ?? 0} runs · base v${d.version ?? 1} · promote ≥${d.minRuns ?? 3} runs`)}`,
		);
		lines.push(heatLine(46));
		const applied = d.applied ?? [];
		const proposals = d.proposals ?? [];
		if (applied.length > 0) {
			lines.push(theme.fg("success", `✓ promoted ${applied.length} step(s) into the base prompt`));
			for (const p of applied) {
				lines.push(
					`  ${theme.fg("success", "+")} ${theme.fg("text", `[${p.cls}] `)}${theme.fg("dim", p.text.slice(0, 78))}`,
				);
			}
		} else if (proposals.length > 0) {
			lines.push(theme.fg("accent", `${proposals.length} promotion candidate(s) — /loop optimize apply to adopt`));
			for (const p of proposals) {
				lines.push(
					`  ${theme.fg("accent", "▸")} ${theme.fg("text", `[${p.cls}] `)}${theme.fg("muted", `recurred in ${p.runs} runs`)} ${theme.fg("dim", `(${p.sampleGoals.join(", ").slice(0, 40)})`)}`,
				);
				lines.push(`    ${theme.fg("dim", p.text.slice(0, 82))}`);
			}
		} else {
			lines.push(theme.fg("muted", "no new promotion candidates — nothing recurred often enough"));
		}
		const existing = d.existing ?? [];
		if (existing.length > 0) {
			lines.push(theme.fg("muted", "promoted steps — recurrence before → after (should trend to 0):"));
			for (const e of existing) {
				const good = e.after === "0" || /^0\//.test(e.after) || e.after === "—";
				lines.push(
					`  ${theme.fg(good ? "success" : "warning", "•")} ${theme.fg("text", `[${e.step.cls}] `)}${theme.fg("dim", `${e.before} → ${e.after}`)}`,
				);
			}
		}
		const trend = d.trend ?? [];
		if (trend.length > 1) {
			lines.push(
				theme.fg(
					"muted",
					`score by version: ${trend.map((t) => `v${t.version}:${t.meanScore}(${t.runs})`).join("  ")}`,
				),
			);
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerTool({
		name: "loop_run",
		label: "loop",
		description:
			"Launch a steerable background verify-loop over a devbrain goal (visible in the agent hub: " +
			"live rounds, x kill, s steer with 'stop'/'more N'/notes; parks at budget for approval).",
		parameters: loopSchema,
		async execute(_id: string, input: LoopInput, _signal, _onUpdate, ctx) {
			const notify = (text: string, level: "info" | "warning" | "error") => {
				(ctx as { ui?: { notify?: (t: string, l: string) => void } })?.ui?.notify?.(text, level);
			};
			// Orchestrate is the DEFAULT (matches /loop); verify is explicit.
			if (input.mode !== "verify") {
				const cwd = (ctx as { cwd?: string })?.cwd ?? process.cwd();
				const defaults = loadLoopDefaults(cwd);
				const msg = await startOrchestration(pi, {
					goal: input.goal,
					rounds: Math.max(1, input.rounds ?? defaults.rounds ?? DEFAULT_ROUNDS),
					autoBudget: input.rounds === undefined && defaults.rounds === undefined,
					cwd,
					gate: input.gate ?? defaults.gate,
					repo: input.repo,
					review: input.review ?? defaults.review,
					criteria: input.criteria ?? defaults.criteria,
					reviewModel: input.reviewModel ?? defaults.reviewModel,
					notify,
				});
				return { content: [{ type: "text", text: msg }], details: undefined };
			}
			void driveLoop({
				goal: input.goal,
				repo: input.repo ?? DEFAULT_REPO,
				rounds: Math.max(1, input.rounds ?? 5),
				notify,
			});
			return {
				content: [
					{
						type: "text",
						text:
							`Loop launched for goal '${input.goal}' — it runs in the background and appears in the ` +
							"agent hub (Ctrl+Alt+A). The user can watch, steer, or kill it there. Do not poll.",
					},
				],
				details: undefined,
			};
		},
	});

	// Round completion: when the session settles after a dispatched round,
	// read the verdict from PROGRESS.md and continue/park/finish.
	// Capture the orchestrator's reply so settleRound can read the verdict line
	// from the MESSAGE (where the round prompt puts it) — not just PROGRESS.md.
	pi.on("turn_end", async (event) => {
		if (!activeOrchestration) return;
		const msg = (event as { message?: { content?: Array<{ type?: string; text?: string }> } }).message;
		const text = Array.isArray(msg?.content)
			? msg.content
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join("\n")
			: "";
		if (text.trim()) activeOrchestration.lastMessage = text;
	});

	pi.on("agent_settled", async () => {
		if (activeOrchestration) await settleRound(pi, activeOrchestration);
	});

	pi.registerCommand("loop", {
		description:
			"/loop <goal> — orchestrated loop with smart defaults (.pi/loop.json, auto rounds). Also: verify <cap> | resume [<goal>] | status [<goal>] | optimize [apply]; flags rounds= gate= rmodel= review=off criteria=off",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = (args ?? "").trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const goal = parts[0];
			if (!goal) {
				ctx.ui.notify(
					"Usage: /loop <goal>   (that's it — defaults from .pi/loop.json, budget auto-sized from criteria)\n" +
						"       /loop verify <devbrain-cap> | /loop resume [<goal>] | /loop status [<goal>] | /loop optimize [apply]\n" +
						"       overrides: rounds=N gate=<cap> rmodel=<model> review=off criteria=off",
					"error",
				);
				return;
			}
			if (goal === "resume") {
				// Full goal after "resume" (minus flags), not just the first word.
				// Strip the "resume" verb (with or without a trailing goal). Bare
				// "/loop resume" -> undefined goal -> resume the most-recent loop.
				const resumeGoal = parseOrchestrateGoal(raw.replace(/^resume\b\s*/i, "")) || undefined;
				const msg = await resumeOrchestration(pi, {
					goal: resumeGoal,
					cwd: ctx.cwd,
					notify: (text, level) => ctx.ui.notify(text, level),
				});
				ctx.ui.notify(msg, msg.startsWith("resumed") ? "info" : "error");
				return;
			}
			if (goal === "panel" || goal === "watch") {
				// Live, steerable drawer (criteria ✓/✗, rounds, steer keys).
				if (ctx.mode === "tui") await openLoopPanel(ctx, pi);
				else sendStatusPanel(pi, ctx.cwd, parts[1], (t, l) => ctx.ui.notify(t, l));
				return;
			}
			if (goal === "status") {
				// In a TUI, open the live drawer; otherwise the one-shot text panel.
				if (ctx.mode === "tui") await openLoopPanel(ctx, pi);
				else sendStatusPanel(pi, ctx.cwd, parts[1], (t, l) => ctx.ui.notify(t, l));
				return;
			}
			if (goal === "optimize") {
				runOptimizer(pi, ctx.cwd, /\bapply\b/i.test(raw), (t, l) => ctx.ui.notify(t, l));
				return;
			}
			// Explicit verify mode: the devbrain-gated retry loop.
			if (goal === "verify") {
				const cap = parts[1];
				if (!cap) {
					ctx.ui.notify("Usage: /loop verify <devbrain-capability> [rounds=N]", "error");
					return;
				}
				const vRounds = /rounds=(\d+)/.exec(raw);
				void driveLoop({
					goal: cap,
					repo: DEFAULT_REPO,
					rounds: vRounds ? Number(vRounds[1]) : 5,
					notify: (text, level) => ctx.ui.notify(text, level),
				});
				ctx.ui.notify(`verify-loop '${cap}' launched — Ctrl+Alt+A to watch/steer`, "info");
				return;
			}
			// DEFAULT: orchestrate. Explicit flags > .pi/loop.json repo defaults >
			// built-ins; no rounds= means the budget auto-sizes to criteria + 2.
			const defaults = loadLoopDefaults(ctx.cwd);
			const roundsArg = /rounds=(\d+)/.exec(raw);
			const gateArg = /gate=(\S+)/.exec(raw);
			const rmodelArg = /rmodel=(\S+)/.exec(raw);
			// The GOAL is the whole argument minus recognized flags — NOT parts[0]
			// (that is only for subcommand detection above; using it truncated every
			// multi-word goal to its first word).
			const goalText = parseOrchestrateGoal(raw);
			if (!goalText) {
				ctx.ui.notify("Usage: /loop <goal>  (a goal is required after any flags)", "error");
				return;
			}
			const msg = await startOrchestration(pi, {
				goal: goalText,
				rounds: roundsArg ? Number(roundsArg[1]) : (defaults.rounds ?? DEFAULT_ROUNDS),
				autoBudget: !roundsArg && defaults.rounds === undefined,
				cwd: ctx.cwd,
				gate: gateArg?.[1] ?? defaults.gate,
				review: /\breview=(off|false|0)\b/i.test(raw) ? false : (defaults.review ?? true),
				criteria: /\bcriteria=(off|false|0)\b/i.test(raw) ? false : (defaults.criteria ?? true),
				reviewModel: rmodelArg?.[1] ?? defaults.reviewModel,
				notify: (text, level) => ctx.ui.notify(text, level),
			});
			ctx.ui.notify(msg, "info");
		},
	});

	// Ctrl+Alt+L opens the live, steerable loop drawer.
	pi.registerShortcut(Key.ctrlAlt("l"), {
		description: "Open the live loop panel (criteria, rounds, steer)",
		handler: async (ctx: ExtensionContext) => {
			await openLoopPanel(ctx, pi);
		},
	});
}
