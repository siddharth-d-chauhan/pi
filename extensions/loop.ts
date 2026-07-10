/**
 * Loop Extension — Ralph-style verify-loops that are VISIBLE and STEERABLE
 * inside pi, like subagents:
 *
 *   /loop <goal-capability> [rounds=5]     e.g. /loop smoke-tested rounds=3
 *   /loop <goal> orchestrate [gate=cap] [review=off]   LLM-orchestrated rounds
 *   /loop resume [<goal>]                  re-attach after a pi restart
 *   loop_run tool — the model can launch the same loops.
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
 * Orchestrate mode — a "done" claim must survive, in order:
 *   1. independent fresh-context adversarial REVIEW of the loop's whole diff
 *      (baseline = git HEAD at start); reviewer findings reject the claim
 *   2. the mechanical devbrain GATE (when gate= is set)
 * Rejections append a lesson to GUARDRAILS.md, which every later round and
 * reviewer reads — the loop learns from its failures (Ralph guardrails).
 * State (PROGRESS.md, GUARDRAILS.md, state.json) lives in .pi/loops/<goal>/;
 * context dies, files don't — /loop resume re-attaches after a restart.
 */

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEVBRAIN_ROOT = process.env.PI_DEVBRAIN_ROOT ?? `${process.env.HOME}/vault/tools/devbrain`;
const DEFAULT_REPO = process.env.PI_DEVBRAIN_REPO ?? `${process.env.HOME}/projects/dev/automations/testing-automations`;
const ROUND_TIMEOUT_MS = Number(process.env.PI_LOOP_ROUND_TIMEOUT_MS ?? 900_000);
const MAX_ENV_DETOURS = 3;

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
	/** Which dispatch we are waiting on: a work round or the done-claim review. */
	phase: "round" | "review";
	/** Independent fresh-context review of every "done" claim (default on). */
	reviewEnabled: boolean;
	/** git HEAD at loop start — the reviewer diffs against this. */
	baseline?: string;
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

function roundPrompt(loop: OrchestratedLoop): string {
	const steering = loop.notes.length ? `\nOperator steering notes (honor these): ${loop.notes.join(" | ")}\n` : "";
	loop.notes = [];
	const gateLine = loop.gate
		? `A "done" verdict will be VERIFIED by running devbrain goal '${loop.gate}' — do not claim done unless that gate will pass.`
		: "";
	const reviewLine = loop.reviewEnabled
		? "A 'done' verdict triggers an INDEPENDENT fresh-context review of the whole loop's work before it is accepted — claims that don't survive scrutiny cost a round."
		: "";
	return [
		`<loop-round loop="${loop.goal}" round="${loop.round}" budget="${loop.budget}">`,
		`You are the ORCHESTRATOR of an autonomous loop. Goal: ${loop.goal}`,
		`State file: ${progressPath(loop)} (read it first; it survives across rounds — context does not).`,
		`Guardrails file: ${guardrailsPath(loop)} (read it and honor EVERY rule — it is the loop's memory of past failures).`,
		gateLine,
		reviewLine,
		steering,
		"This round, do exactly this:",
		"1. Read PROGRESS.md and GUARDRAILS.md. Decide: is the goal genuinely DONE (verified, not claimed)?",
		"2. If NOT done: dispatch 1-3 workers via the agent tool (fresh context each) with precise,",
		"   self-contained briefs — parallel only when tasks are independent; worktree isolation for",
		"   write work. Include relevant PROGRESS excerpts and guardrails in each brief.",
		"   Use the devbrain tool to VERIFY product-facing results (triage-typed).",
		"3. Append to PROGRESS.md: what was attempted, what was verified, what remains.",
		"   If anything FAILED this round, append the distilled lesson to GUARDRAILS.md (one line).",
		"4. End your reply with EXACTLY one line:",
		"   LOOP_VERDICT: done|continue|blocked — <one-line summary>",
		"   (use `blocked` when a human decision is required; say what you need)",
		"Do not do the work yourself in this session — dispatch it. Keep your own output short.",
		"</loop-round>",
	].join("\n");
}

function reviewPrompt(loop: OrchestratedLoop, claim: string): string {
	const diffLine = loop.baseline
		? `The loop started at git commit ${loop.baseline} — have the reviewer run \`git diff ${loop.baseline}\` to see ALL work the loop produced.`
		: "Have the reviewer inspect the work products listed in PROGRESS.md directly.";
	return [
		`<loop-review loop="${loop.goal}" round="${loop.round}">`,
		`The loop just claimed DONE: "${claim}".`,
		"Before this claim is accepted, dispatch EXACTLY ONE fresh-context reviewer via the agent tool.",
		"The reviewer must be adversarial — its job is to find reasons the claim is FALSE, not to confirm it.",
		"Give the reviewer a self-contained brief containing:",
		`- The goal: ${loop.goal}`,
		`- The state files to read: ${progressPath(loop)} and ${guardrailsPath(loop)}`,
		`- ${diffLine}`,
		"- Instructions: verify the goal is ACTUALLY met — read the changed code/artifacts, check for",
		"  regressions, unhandled edge cases, skipped acceptance criteria, and claims in PROGRESS.md",
		"  that were never verified by execution. Verdict first, then at most 5 findings with file:line.",
		"When the reviewer returns, append its findings to PROGRESS.md, then end your reply with EXACTLY one line:",
		"REVIEW_VERDICT: pass|fail — <one-line summary of the reviewer's verdict>",
		"Report the reviewer's verdict honestly — do not soften a fail.",
		"</loop-review>",
	].join("\n");
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
		/** Resume: restore round/notes/baseline from a prior run's state.json. */
		restore?: { round: number; notes: string[]; baseline?: string };
		notify: OrchestratedLoop["notify"];
	},
): Promise<string> {
	if (activeOrchestration && !activeOrchestration.killed) {
		return `an orchestrated loop is already running (${activeOrchestration.goal}) — kill it first`;
	}
	const registry = getBackgroundProcessRegistry();
	const dir = `${opts.cwd}/.pi/loops/${opts.goal.replace(/[^a-zA-Z0-9-]/g, "_")}`;
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
	nextRound(pi, loop);
	const extras = [loop.gate ? `gate: ${loop.gate}` : "", loop.reviewEnabled ? "review: on" : "review: OFF"]
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
	const resumable = states.filter((s) => s.status === "running" || s.status === "parked");
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
		restore: { round: target.round, notes: target.notes ?? [], baseline: target.baseline },
		notify: opts.notify,
	}).then((msg) =>
		msg.startsWith("orchestrated") ? `resumed at round ${target.round}/${target.budget} — ${msg}` : msg,
	);
}

function setPhase(loop: OrchestratedLoop, phase: string): void {
	const registry = getBackgroundProcessRegistry();
	const elapsed = loop.roundStartedAt ? ` · ${Math.round((Date.now() - loop.roundStartedAt) / 1000)}s` : "";
	registry.update(loop.id, {
		summary: `round ${loop.round}/${loop.budget} · ${phase}${elapsed}${loop.gate ? ` · gate: ${loop.gate}` : ""}`,
	});
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
	registry.appendLog(loop.id, `— round ${loop.round}/${loop.budget} dispatched`);
	setPhase(loop, "orchestrating");
	watchWorkers(loop);
	armWatchdog(loop);
	pi.sendMessage(
		{
			customType: "loop-round",
			content: roundPrompt(loop),
			display: true,
			details: { loop: loop.goal, round: loop.round },
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
			details: { loop: loop.goal, round: loop.round },
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

/** Accept the done claim: it has survived review (if enabled) and the gate (if set). */
function completeLoop(loop: OrchestratedLoop, summary: string): void {
	const registry = getBackgroundProcessRegistry();
	registry.setStatus(loop.id, "completed");
	registry.update(loop.id, {
		summary: `done after ${loop.round}/${loop.budget} rounds${loop.reviewEnabled ? " · review ✓" : ""}${loop.gate ? " · gate ✓" : ""}`,
	});
	saveState(loop, "completed");
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

	// -------- review settle: the done claim faces its independent reviewer -----
	if (loop.phase === "review") {
		const matches = [...progressText.matchAll(/REVIEW_VERDICT:\s*(pass|fail)\s*[—-]\s*(.*)/gi)];
		const last = matches[matches.length - 1];
		const reviewVerdict = last ? last[1].toLowerCase() : "fail";
		const reviewSummary = last ? last[2].slice(0, 120) : "(no REVIEW_VERDICT found — treating as fail)";
		registry.appendLog(loop.id, `review (${took}s): ${reviewVerdict} — ${reviewSummary}`);

		if (reviewVerdict !== "pass") {
			addGuardrail(loop, `review rejected a done claim: ${reviewSummary}`);
			loop.notes.push(
				`Your previous "done" claim FAILED independent review: ${reviewSummary}. Address every finding (see PROGRESS.md) before claiming done again.`,
			);
			nextRound(pi, loop);
			return;
		}
		// Review passed → the mechanical gate (if any) has the final word.
		if (loop.gate) {
			setPhase(loop, `gating: devbrain goal '${loop.gate}'`);
			const gate = await runGate(loop);
			if (!gate.ok) {
				registry.appendLog(loop.id, `✗ done claim REJECTED by gate '${loop.gate}' — ${gate.evidence.slice(0, 80)}`);
				addGuardrail(loop, `gate '${loop.gate}' rejected a done claim: ${gate.evidence}`);
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
	let verdict = "continue";
	let summary = "(no verdict line found in PROGRESS.md — continuing)";
	const matches = [...progressText.matchAll(/LOOP_VERDICT:\s*(done|continue|blocked)\s*[—-]\s*(.*)/gi)];
	const last = matches[matches.length - 1];
	if (last) {
		verdict = last[1].toLowerCase();
		summary = last[2].slice(0, 100);
	}
	registry.appendLog(loop.id, `round ${loop.round} (${took}s): ${verdict} — ${summary}`);

	if (verdict === "blocked") {
		// Human decision required: park immediately, regardless of budget.
		loop.parked = true;
		registry.setStatus(loop.id, "parked");
		saveState(loop, "parked");
		registry.update(loop.id, { summary: `BLOCKED: ${summary.slice(0, 60)} — steer to answer` });
		loop.notify(`orchestrated loop ${loop.goal}: BLOCKED — ${summary}`, "warning");
		return;
	}

	if (verdict === "done") {
		// Verified-done, stage 1: independent fresh-context review of the claim.
		if (loop.reviewEnabled) {
			dispatchReview(pi, loop, summary);
			return;
		}
		// Review disabled → straight to the mechanical gate (if any).
		if (loop.gate) {
			setPhase(loop, `gating: devbrain goal '${loop.gate}'`);
			const gate = await runGate(loop);
			if (!gate.ok) {
				registry.appendLog(loop.id, `✗ done claim REJECTED by gate '${loop.gate}' — ${gate.evidence.slice(0, 80)}`);
				addGuardrail(loop, `gate '${loop.gate}' rejected a done claim: ${gate.evidence}`);
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
				"verify = devbrain-gated retry loop; orchestrate = LLM decides each round, dispatches fresh-context workers",
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
});

type LoopInput = Static<typeof loopSchema>;

export default function (pi: ExtensionAPI) {
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
			if (input.mode === "orchestrate") {
				const msg = await startOrchestration(pi, {
					goal: input.goal,
					rounds: Math.max(1, input.rounds ?? 5),
					cwd: (ctx as { cwd?: string })?.cwd ?? process.cwd(),
					gate: input.gate,
					repo: input.repo,
					review: input.review,
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
	pi.on("agent_settled", async () => {
		if (activeOrchestration) await settleRound(pi, activeOrchestration);
	});

	pi.registerCommand("loop", {
		description:
			"Steerable loops: /loop <goal> [rounds=5] [orchestrate] [gate=cap] [review=off] | /loop resume <goal>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = (args ?? "").trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const goal = parts[0];
			if (!goal) {
				ctx.ui.notify(
					"Usage: /loop <goal> [rounds=5] [orchestrate] [gate=cap] [review=off] | /loop resume <goal>",
					"error",
				);
				return;
			}
			if (goal === "resume") {
				const msg = await resumeOrchestration(pi, {
					goal: parts[1],
					cwd: ctx.cwd,
					notify: (text, level) => ctx.ui.notify(text, level),
				});
				ctx.ui.notify(msg, msg.startsWith("resumed") ? "info" : "error");
				return;
			}
			const roundsArg = /rounds=(\d+)/.exec(raw);
			const rounds = roundsArg ? Number(roundsArg[1]) : 5;
			if (/\borchestrate\b/i.test(raw)) {
				const gateArg = /gate=(\S+)/.exec(raw);
				const msg = await startOrchestration(pi, {
					goal,
					rounds,
					cwd: ctx.cwd,
					gate: gateArg?.[1],
					review: !/\breview=(off|false|0)\b/i.test(raw),
					notify: (text, level) => ctx.ui.notify(text, level),
				});
				ctx.ui.notify(msg, "info");
				return;
			}
			void driveLoop({
				goal,
				repo: DEFAULT_REPO,
				rounds,
				notify: (text, level) => ctx.ui.notify(text, level),
			});
			ctx.ui.notify(`loop '${goal}' launched — Ctrl+Alt+A to watch/steer`, "info");
		},
	});
}
