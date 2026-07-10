/**
 * Loop Extension — Ralph-style verify-loops that are VISIBLE and STEERABLE
 * inside pi, like subagents:
 *
 *   /loop <goal-capability> [rounds=5]     e.g. /loop smoke-tested rounds=3
 *   loop_run tool — the model can launch the same loop.
 *
 * The loop registers in the BackgroundProcessRegistry (the same roster the
 * agent hub shows): every round streams into the live log, `x` kills it,
 * `s` steers it ("stop", "more 3", or free text appended to the next round's
 * context), and when the round budget runs out it PARKS (status "parked")
 * until you steer "more N" — the human approval gate, in the TUI.
 *
 * Round semantics (loop engineering): run `devbrain flow goal` → triage:
 *   green            → done (notification)
 *   env              → doctor detour, retry — does NOT consume a round
 *   flake_suspect    → retry, consumes a round
 *   product_bug      → stop with evidence (notification) — never papered over
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	roundStartedAt: number;
	watchdog?: NodeJS.Timeout;
	unwatchWorkers?: () => void;
	notify: (text: string, level: "info" | "warning" | "error") => void;
}

let activeOrchestration: OrchestratedLoop | undefined;

function progressPath(loop: OrchestratedLoop): string {
	return `${loop.dir}/PROGRESS.md`;
}

function roundPrompt(loop: OrchestratedLoop): string {
	const steering = loop.notes.length ? `\nOperator steering notes (honor these): ${loop.notes.join(" | ")}\n` : "";
	loop.notes = [];
	const gateLine = loop.gate
		? `A "done" verdict will be VERIFIED by running devbrain goal '${loop.gate}' — do not claim done unless that gate will pass.`
		: "";
	return [
		`<loop-round loop="${loop.goal}" round="${loop.round}" budget="${loop.budget}">`,
		`You are the ORCHESTRATOR of an autonomous loop. Goal: ${loop.goal}`,
		`State file: ${progressPath(loop)} (read it first; it survives across rounds — context does not).`,
		gateLine,
		steering,
		"This round, do exactly this:",
		"1. Read PROGRESS.md. Decide: is the goal genuinely DONE (verified, not claimed)?",
		"2. If NOT done: dispatch 1-3 workers via the agent tool (fresh context each) with precise,",
		"   self-contained briefs — parallel only when tasks are independent; worktree isolation for",
		"   write work. Include relevant PROGRESS excerpts in each brief.",
		"   Use the devbrain tool to VERIFY product-facing results (triage-typed).",
		"3. Append to PROGRESS.md: what was attempted, what was verified, what remains.",
		"4. End your reply with EXACTLY one line:",
		"   LOOP_VERDICT: done|continue|blocked — <one-line summary>",
		"   (use `blocked` when a human decision is required; say what you need)",
		"Do not do the work yourself in this session — dispatch it. Keep your own output short.",
		"</loop-round>",
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
	const loop: OrchestratedLoop = {
		id: "",
		goal: opts.goal,
		gate: opts.gate,
		repo: opts.repo ?? DEFAULT_REPO,
		dir,
		budget: opts.rounds,
		round: 0,
		notes: [],
		killed: false,
		parked: false,
		awaitingRound: false,
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
				activeOrchestration = undefined;
				return;
			}
			if (more) {
				loop.budget += Number(more[1]);
				registry.appendLog(loop.id, `budget → ${loop.budget}`);
			} else if (t) {
				loop.notes.push(t.slice(0, 200));
			}
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
	nextRound(pi, loop);
	return `orchestrated loop '${opts.goal}' launched — Ctrl+Alt+A to watch/steer; state in ${dir}/PROGRESS.md`;
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
		registry.update(loop.id, { summary: `parked at ${loop.round}/${loop.budget} — steer "more N" | "stop"` });
		registry.appendLog(loop.id, `parked: ${loop.round}/${loop.budget} rounds — steer "more N" or "stop"`);
		loop.notify(`orchestrated loop ${loop.goal}: parked after ${loop.round} rounds`, "warning");
		return;
	}
	loop.round += 1;
	loop.awaitingRound = true;
	loop.roundStartedAt = Date.now();
	registry.appendLog(loop.id, `— round ${loop.round}/${loop.budget} dispatched`);
	setPhase(loop, "orchestrating");
	watchWorkers(loop);
	// Watchdog: a round that never settles parks the loop instead of hanging it.
	loop.watchdog = setTimeout(() => {
		if (!loop.awaitingRound || loop.killed) return;
		loop.awaitingRound = false;
		loop.unwatchWorkers?.();
		loop.parked = true;
		registry.setStatus(loop.id, "parked");
		registry.appendLog(
			loop.id,
			`[round ${loop.round} timed out after ${Math.round(ROUND_TIMEOUT_MS / 60000)}m — parked]`,
		);
		loop.notify(`orchestrated loop ${loop.goal}: round ${loop.round} timed out — parked`, "warning");
	}, ROUND_TIMEOUT_MS);
	loop.watchdog.unref?.();
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

async function settleRound(pi: ExtensionAPI, loop: OrchestratedLoop): Promise<void> {
	const registry = getBackgroundProcessRegistry();
	if (loop.killed || !loop.awaitingRound) return;
	loop.awaitingRound = false;
	if (loop.watchdog) clearTimeout(loop.watchdog);
	loop.unwatchWorkers?.();
	let verdict = "continue";
	let summary = "(no verdict line found in PROGRESS.md — continuing)";
	try {
		const text = readFileSync(progressPath(loop), "utf-8");
		const matches = [...text.matchAll(/LOOP_VERDICT:\s*(done|continue|blocked)\s*[—-]\s*(.*)/gi)];
		const last = matches[matches.length - 1];
		if (last) {
			verdict = last[1].toLowerCase();
			summary = last[2].slice(0, 100);
		}
	} catch {
		// keep defaults
	}
	const took = Math.round((Date.now() - loop.roundStartedAt) / 1000);
	registry.appendLog(loop.id, `round ${loop.round} (${took}s): ${verdict} — ${summary}`);

	if (verdict === "blocked") {
		// Human decision required: park immediately, regardless of budget.
		loop.parked = true;
		registry.setStatus(loop.id, "parked");
		registry.update(loop.id, { summary: `BLOCKED: ${summary.slice(0, 60)} — steer to answer` });
		loop.notify(`orchestrated loop ${loop.goal}: BLOCKED — ${summary}`, "warning");
		return;
	}

	if (verdict === "done") {
		// Verified-done: a claim only counts when the gate passes.
		if (loop.gate) {
			setPhase(loop, `gating: devbrain goal '${loop.gate}'`);
			const handle: LoopHandle = { steers: [], killed: false };
			const { out } = await runDevbrain(["--repo", loop.repo, "flow", "goal", loop.gate, "--no-journal"], handle);
			let gateOk = false;
			let evidence = "gate produced no report";
			try {
				const report = JSON.parse(out) as {
					ok?: boolean;
					steps?: Array<{ block?: string; triage?: string; detail?: string }>;
				};
				gateOk = Boolean(report.ok);
				if (!gateOk) {
					const failed = (report.steps ?? []).find((s) => s.triage);
					evidence = `${failed?.block ?? "?"} [${failed?.triage ?? "?"}]: ${String(failed?.detail ?? "").slice(0, 120)}`;
				}
			} catch {
				// keep defaults
			}
			if (!gateOk) {
				registry.appendLog(loop.id, `✗ done claim REJECTED by gate '${loop.gate}' — ${evidence.slice(0, 80)}`);
				loop.notes.push(
					`Your previous "done" claim FAILED the verification gate '${loop.gate}': ${evidence}. Fix that first.`,
				);
				nextRound(pi, loop);
				return;
			}
			registry.appendLog(loop.id, `✓ gate '${loop.gate}' PASSED`);
		}
		registry.setStatus(loop.id, "completed");
		registry.update(loop.id, {
			summary: `done after ${loop.round}/${loop.budget} rounds${loop.gate ? " · gate ✓" : ""}`,
		});
		loop.notify(`orchestrated loop ${loop.goal}: DONE after ${loop.round} round(s) — ${summary}`, "info");
		activeOrchestration = undefined;
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
		description: "Steerable loops: /loop <goal> [rounds=5] [orchestrate] — watch in the agent hub",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = (args ?? "").trim();
			const parts = raw.split(/\s+/).filter(Boolean);
			const goal = parts[0];
			if (!goal) {
				ctx.ui.notify(
					"Usage: /loop <goal> [rounds=5] [orchestrate] — verify: devbrain-gated; orchestrate: LLM-driven rounds",
					"error",
				);
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
