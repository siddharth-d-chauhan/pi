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

const loopSchema = Type.Object({
	goal: Type.String({ description: "devbrain goal capability, e.g. 'smoke-tested'" }),
	rounds: Type.Optional(Type.Number({ description: "round budget before parking (default 5)" })),
	repo: Type.Optional(Type.String({ description: "product repo (default: testing-automations)" })),
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

	pi.registerCommand("loop", {
		description: "Steerable verify-loop: /loop <goal> [rounds=5] — watch in the agent hub",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const goal = parts[0];
			if (!goal) {
				ctx.ui.notify("Usage: /loop <goal-capability> [rounds=5] — e.g. /loop smoke-tested rounds=3", "error");
				return;
			}
			const roundsArg = /rounds=(\d+)/.exec(args ?? "");
			void driveLoop({
				goal,
				repo: DEFAULT_REPO,
				rounds: roundsArg ? Number(roundsArg[1]) : 5,
				notify: (text, level) => ctx.ui.notify(text, level),
			});
			ctx.ui.notify(`loop '${goal}' launched — Ctrl+Alt+A to watch/steer`, "info");
		},
	});
}
