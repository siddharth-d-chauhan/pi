#!/usr/bin/env node
/**
 * pi-scheduler — durable per-project schedule daemon (Wave 5).
 *
 * Owns execution of the schedules `/every` persists in .pi/schedules.json,
 * INDEPENDENTLY of any Pi TUI session. Run it once per project:
 *
 *   node bin/pi-scheduler.mjs [projectDir]      # defaults to cwd
 *
 * It holds a single-owner lease (heartbeat + TTL) so it never double-fires with
 * a second daemon or an in-session `/every` (which defers to a live lease). On
 * each tick it computes due jobs (catch-up aware — a fire missed while the
 * daemon was down still happens once), runs each via `pi -p "<prompt>"` in the
 * project, and records the fire to .pi/scheduler-state.json so state survives
 * restart. Stop with Ctrl-C; it releases its lease on the way out.
 *
 * Env: PI_SCHEDULER_PI (pi binary, default "pi"); PI_SCHEDULER_TICK_MS (default 30000).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = resolve(process.argv[2] || process.cwd());
const TICK_MS = Number(process.env.PI_SCHEDULER_TICK_MS) || 30_000;
const PI_BIN = process.env.PI_SCHEDULER_PI || "pi";
const OWNER = `${hostname()}:${process.pid}`;

// Single source of truth: the same tested pure core the extensions use.
const libUrl = pathToFileURL(join(import.meta.dirname, "..", "extensions", "lib", "scheduler.ts")).href;
const { canRun, dueJobs, loadState, recordFire, refreshLease, saveState } = await import(libUrl);

function log(msg) {
	// eslint-disable-next-line no-console
	console.log(`[pi-scheduler ${new Date().toISOString()}] ${msg}`);
}

function loadJobs() {
	const p = join(cwd, ".pi", "schedules.json");
	try {
		if (!existsSync(p)) return [];
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		return Array.isArray(parsed)
			? parsed.filter((j) => j && typeof j.prompt === "string" && typeof j.intervalMs === "number")
			: [];
	} catch {
		return [];
	}
}

function runPrompt(prompt) {
	return new Promise((res) => {
		let proc;
		try {
			proc = spawn(PI_BIN, ["-p", prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			log(`spawn failed for "${prompt}": ${e.message}`);
			return res(false);
		}
		let out = "";
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", () => {});
		proc.on("close", (code) => {
			const tail = out.trim().split("\n").slice(-1)[0]?.slice(0, 160) ?? "";
			log(`fired "${prompt}" -> exit ${code}${tail ? ` · ${tail}` : ""}`);
			res(code === 0);
		});
		proc.on("error", (e) => {
			log(`error running "${prompt}": ${e.message}`);
			res(false);
		});
	});
}

let stopping = false;

async function tick() {
	if (stopping) return;
	const now = Date.now();
	let state = loadState(cwd);
	if (!canRun(state, OWNER, now)) {
		return; // another live daemon owns execution
	}
	state = refreshLease(state, OWNER, now);
	saveState(cwd, state);

	const jobs = loadJobs();
	const due = dueJobs(jobs, state, now);
	for (const job of due) {
		if (stopping) break;
		await runPrompt(job.prompt);
		state = recordFire(loadState(cwd), job.id, Date.now());
		saveState(cwd, state);
	}
}

function releaseLease() {
	try {
		const state = loadState(cwd);
		if (state.lease?.owner === OWNER) {
			delete state.lease;
			saveState(cwd, state);
		}
	} catch {
		// best-effort
	}
}

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		stopping = true;
		releaseLease();
		log(`stopped (${sig}); lease released`);
		process.exit(0);
	});
}

log(`started · project=${cwd} · owner=${OWNER} · tick=${TICK_MS}ms`);
await tick(); // immediate catch-up pass on start
setInterval(() => {
	tick().catch((e) => log(`tick error: ${e.message}`));
}, TICK_MS);
