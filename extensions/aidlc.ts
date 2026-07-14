/**
 * AIDLC Workflows Extension — drives the REAL awslabs/aidlc-workflows v2
 * deterministic engine from pi. The engine (a bun-run TypeScript CLI) owns all
 * between-stage routing, workflow state, audit, and approval gates; the model
 * is only the conductor: ask the engine what's next, do that one move well,
 * report, repeat. `/aidlc <intent>` starts the forwarding loop; an
 * `agent_settled` guard re-arms it (bounded) when the model stops mid-loop —
 * pi's equivalent of the upstream Stop hook.
 *
 * Token posture: ZERO context cost while no workflow is active — no context
 * handlers, no system-prompt additions; the settle guard early-returns.
 * Engine install is central (`~/.pi/aidlc-workflows`, override PI_AIDLC_HOME):
 * the tools resolve their stage graph/scopes module-relative, so one install
 * serves every project while workflow state lands in the project's `aidlc/`.
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

function enginePath(): string {
	return join(aidlcHome(), "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
}

function bunBin(): string {
	if (process.env.PI_BUN) return process.env.PI_BUN;
	const local = join(homedir(), ".bun", "bin", "bun");
	return existsSync(local) ? local : "bun";
}

export interface AidlcDirective {
	kind: string;
	question?: string;
	message?: string;
	stage_slug?: string;
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

/** True when the active intent's state file shows a stage positively waiting
 *  on the human ([?] gate open / [R] revising) — the upstream Stop hook's
 *  human-wait carve-out. Fail-open to false (the nudge cap still bounds us). */
export function humanWaitState(cwd: string): boolean {
	try {
		const space = readFileSync(join(cwd, "aidlc", "active-space"), "utf-8").trim() || "default";
		const intentsDir = join(cwd, "aidlc", "spaces", space, "intents");
		const intent = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
		if (!intent) return false;
		const state = readFileSync(join(intentsDir, intent, "aidlc-state.md"), "utf-8");
		return /\[(\?|R)\]/.test(state);
	} catch {
		return false;
	}
}

function runEngine(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile(
			bunBin(),
			[enginePath(), ...args],
			{ cwd, timeout: ENGINE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				resolve({ ok: !error, out: `${stdout ?? ""}${stdout ? "" : (stderr ?? "")}` });
			},
		);
	});
}

function installReady(): boolean {
	return existsSync(enginePath());
}

/** The lean conductor contract. Deliberately small: the engine bakes its full
 *  conductor persona into the first run-stage directive, and each stage file
 *  loads only when a directive names it — pi does not duplicate that prose. */
function conductorKickoff(intentArgs: string): string {
	const engine = `${bunBin()} ${enginePath()}`;
	return [
		"<aidlc-conductor>",
		"You are the CONDUCTOR of an AI-DLC workflow. A deterministic engine owns ALL routing, state,",
		"audit, and gates; you own the quality of the single move it names. Run it via bash from the",
		"project root:",
		`  NEXT:   ${engine} next [args]`,
		`  REPORT: ${engine} report --stage <slug> --result <outcome> [--user-input "<text>"]`,
		"Forwarding loop — repeat until kind=done:",
		"1. Run NEXT (this first call: pass the user's intent/flags below as the argument).",
		"2. Act on the ONE JSON directive it prints:",
		"   - ask → relay the question to the user VERBATIM and END YOUR TURN. Hard stop: no tool",
		"     calls, no invented options, no proceeding until the user answers.",
		"   - run-stage → open the directive's stage_file and execute exactly that stage, reading only",
		"     the `consumes` paths it resolved and writing the `produces` paths. Honor `gate`.",
		"   - print / error → show the message to the user and follow its instruction.",
		"   - parked / done → tell the user and stop.",
		"3. REPORT the outcome (--result approved|completed|... per the stage protocol), then NEXT again.",
		"Rules: never edit aidlc-state.md or audit files by hand — report owns every transition; at an",
		"approval gate end your turn and wait for the human; keep artifacts inside the directive's paths.",
		`Start now: run NEXT with the argument ${JSON.stringify(intentArgs)}.`,
		"</aidlc-conductor>",
	].join("\n");
}

export default function aidlc(pi: ExtensionAPI) {
	let active = false;
	let lastSignature = "";
	let nudges = 0;

	pi.registerCommand("aidlc", {
		description: "Run an AI-DLC workflow (real awslabs engine): /aidlc <intent> · --resume · status · stop · setup",
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
			if (raw === "status" || raw === "") {
				const res = await runEngine(ctx.cwd, ["next"]);
				const directive = parseDirective(res.out);
				ctx.ui.notify(
					directive
						? `aidlc: ${directive.kind}${directive.stage_slug ? ` @ ${directive.stage_slug}` : ""} — ${
								(directive.question ?? directive.message ?? "").slice(0, 120) || "(pending stage)"
							}`
						: `aidlc engine unreadable: ${res.out.slice(0, 160)}`,
					directive ? "info" : "error",
				);
				return;
			}
			// Everything else — an intent, --resume, --scope <s>, --status — goes to
			// the engine verbatim through the conductor loop.
			active = true;
			lastSignature = "";
			nudges = 0;
			pi.sendUserMessage(conductorKickoff(raw));
		},
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
		if (directive.kind === "done") {
			active = false;
			ctx.ui.notify("aidlc workflow complete", "info");
			return;
		}
		if (!directivePending(directive.kind)) return; // ask/parked/error → human's turn
		if (humanWaitState(cwd)) return; // gate open / revising → the stop is legitimate
		const signature = `${directive.kind}:${directive.stage_slug ?? ""}:${directive.message ?? ""}`;
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
				`${directive.stage_slug ? ` @ ${directive.stage_slug}` : ""}). Continue the forwarding loop: ` +
				`act on it, report, and run next again — or relay its question and stop if it needs the user.</aidlc-continuation>`,
		);
	});
}
