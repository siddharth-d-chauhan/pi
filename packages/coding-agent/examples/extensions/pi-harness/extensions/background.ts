/**
 * background.ts — spawn long-running processes in the background and track them in the status bar
 * (Claude Code parity). The agent starts a build/test/server/watch, gets a handle back IMMEDIATELY,
 * keeps working, and the status bar shows "⏳ 2 bg jobs" live; completions surface on the next turn.
 *
 * Tools:
 *   bg_run(command, [cwd], [name])  → spawn detached, return a job id + PID. Non-blocking.
 *   bg_status([id])                 → list jobs (or one) with state/runtime/exit code.
 *   bg_output(id, [tail])           → the captured stdout+stderr so far (last `tail` lines).
 *   bg_kill(id)                     → terminate a running job.
 *
 * Status bar: `ctx.ui.setStatus("bg", "⏳ 2 running · ✓1 ✗0")` — updated as jobs start/finish, cleared
 * when none remain. Completions are queued and injected once into the next turn's context (append-
 * only, cache-safe) so the agent notices "job X finished (exit 0)" without polling.
 *
 * Output is captured to a file per job (never held in memory unbounded); bg_output reads a bounded
 * tail. A job's full log path is in its status so it's recoverable.
 *
 * Config: KP_BG_ENABLED=0 disable · KP_BG_MAX (concurrent cap, default 8).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as registry from "./process-registry.ts"; // shared registry → /logs can open any job

const ENABLED = process.env.KP_BG_ENABLED !== "0";
const MAX = Number(process.env.KP_BG_MAX || 8);
// Per-job log cap — a runaway job (chatty server, `yes` loop) must not fill the disk. On overflow
// the job is killed with a note, like omp's 5GB guard (we default lower: 128MB, plenty for logs).
const MAX_LOG_BYTES = Number(process.env.KP_BG_MAX_LOG_MB || 128) * 1024 * 1024;
const DIR = join(tmpdir(), "pi-bg");

type Job = {
	id: string;
	name: string;
	command: string;
	cwd: string;
	pid: number;
	proc: ChildProcess;
	logPath: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	state: "running" | "done" | "failed" | "killed";
	readOffset: number; // byte offset already returned by bg_output — for INCREMENTAL reads
	logBytes: number; // running total written to the log — for the size cap
};

export default function (pi: any) {
	if (!ENABLED) return;
	try {
		mkdirSync(DIR, { recursive: true });
	} catch {}

	const jobs = new Map<string, Job>();
	let seq = 0;
	const completed: string[] = []; // job ids finished since the last turn injection
	let uiCtx: any = null; // captured from any hook that carries ctx

	const shortId = () => `bg${++seq}`;

	function refreshStatus(): void {
		const all = [...jobs.values()];
		const running = all.filter((j) => j.state === "running").length;
		const ok = all.filter((j) => j.state === "done").length;
		const bad = all.filter((j) => j.state === "failed" || j.state === "killed").length;
		const text =
			running || ok || bad ? `⏳ ${running} bg${ok ? ` · ✓${ok}` : ""}${bad ? ` · ✗${bad}` : ""}` : undefined;
		try {
			uiCtx?.setStatus?.("bg", text);
		} catch {}
	}

	function fmt(j: Job): any {
		const secs = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
		return {
			id: j.id,
			name: j.name,
			state: j.state,
			pid: j.pid,
			runtime_s: secs,
			...(j.exitCode != null ? { exit_code: j.exitCode } : {}),
			command: j.command.slice(0, 120),
			log: j.logPath,
		};
	}

	function startJob(command: string, cwd: string, name: string): Job {
		const id = shortId();
		const logPath = join(DIR, `${id}.log`);
		try {
			appendFileSync(logPath, `$ ${command}\n`);
		} catch {}
		// Detached shell so the child owns its own process group (bg_kill can take the whole tree).
		const proc = spawn("bash", ["-lc", command], { cwd, detached: false, stdio: ["ignore", "pipe", "pipe"] });
		const job: Job = {
			id,
			name: name || command.split(/\s+/)[0] || id,
			command,
			cwd,
			pid: proc.pid || -1,
			proc,
			logPath,
			startedAt: Date.now(),
			state: "running",
			readOffset: 0,
			logBytes: 0,
		};
		const cap = (buf: Buffer) => {
			try {
				appendFileSync(logPath, buf);
				job.logBytes += buf.length;
				if (job.logBytes > MAX_LOG_BYTES && job.state === "running") {
					// runaway output — kill it so it can't fill the disk. Recorded, not silent.
					try {
						appendFileSync(logPath, `\n[killed by pi: log exceeded ${Math.round(MAX_LOG_BYTES / 1048576)}MB]\n`);
					} catch {}
					try {
						job.proc.kill("SIGTERM");
					} catch {}
					job.state = "killed";
					job.endedAt = Date.now();
					completed.push(job.id);
					refreshStatus();
				}
			} catch {}
		};
		proc.stdout?.on("data", cap);
		proc.stderr?.on("data", cap);
		proc.on("error", (e) => {
			try {
				appendFileSync(logPath, `\n[spawn error] ${e}\n`);
			} catch {}
			job.state = "failed";
			job.endedAt = Date.now();
			completed.push(id);
			refreshStatus();
		});
		proc.on("exit", (code) => {
			job.endedAt = Date.now();
			job.exitCode = code;
			if (job.state === "running") job.state = code === 0 ? "done" : "failed";
			completed.push(id);
			refreshStatus();
			registry.touched(); // notify ui-logs so its "N recent · ↓↓ logs" hint updates on finish
		});
		jobs.set(id, job);
		// Register in the shared process registry so /logs can list + open this job's live output.
		registry.register({
			id,
			kind: "bg",
			label: command,
			state: () => job.state,
			output: () => {
				try {
					return existsSync(job.logPath) ? readFileSync(job.logPath, "utf-8") : "";
				} catch {
					return "";
				}
			},
			kill: () => {
				try {
					job.proc.kill("SIGTERM");
				} catch {}
			},
		});
		refreshStatus();
		return job;
	}

	// Capture a ctx with setStatus from any hook (tools get a different ctx shape).
	const grabCtx = (_e: any, ctx: any) => {
		if (ctx?.ui?.setStatus) uiCtx = ctx.ui;
	};
	pi.on("session_start", grabCtx);
	pi.on("turn_start", grabCtx);

	// Surface completions ONCE into the next turn (append-only tail → cache-safe). The agent sees
	// "background job X finished" without polling — mirrors Claude Code's completion notice.
	pi.on("context", async (event: any) => {
		if (!completed.length) return;
		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		const lines = completed
			.splice(0)
			.map((id) => {
				const j = jobs.get(id);
				if (!j) return "";
				return `- ${j.id} (${j.name}) ${j.state}${j.exitCode != null ? ` exit ${j.exitCode}` : ""} after ${Math.round(((j.endedAt ?? 0) - j.startedAt) / 1000)}s — bg_output ${j.id} for logs`;
			})
			.filter(Boolean);
		if (!lines.length) return;
		return {
			messages: [
				...messages,
				{ role: "user", content: [{ type: "text", text: `## Background jobs finished\n${lines.join("\n")}` }] },
			],
		};
	});

	pi.registerTool({
		name: "bg_run",
		label: "background run",
		description:
			"Spawn a long-running shell command in the BACKGROUND and return immediately with a job id — " +
			"for builds, test suites, dev servers, watchers, or anything you don't want to block on. Track " +
			"it with bg_status, read its output with bg_output, stop it with bg_kill. The status bar shows " +
			"live running/done counts; completions surface automatically next turn. Use instead of a blocking " +
			"bash call when the command is slow or should keep running while you work.",
		promptSnippet:
			"bg_run(command) — start a bg process (build/test/server/watch), get a job id back now; bg_status/bg_output/bg_kill to manage. Status bar tracks them.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "the shell command to run in the background" },
				cwd: { type: "string", description: "working directory (default: current)" },
				name: { type: "string", description: "a short label for the status bar (default: the command)" },
			},
			required: ["command"],
		},
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			if (ctx?.ui?.setStatus) uiCtx = ctx.ui;
			const running = [...jobs.values()].filter((j) => j.state === "running").length;
			if (running >= MAX)
				return {
					content: [
						{ type: "text", text: `bg: ${running} jobs already running (cap ${MAX}). Wait or bg_kill one.` },
					],
					isError: true,
				};
			const command = String(params?.command || "").trim();
			if (!command) return { content: [{ type: "text", text: "bg_run: no command" }], isError: true };
			const j = startJob(command, String(params?.cwd || process.cwd()), String(params?.name || ""));
			return {
				content: [
					{
						type: "text",
						text: `started ${j.id} (${j.name}) pid ${j.pid} — bg_status/${j.id}, bg_output ${j.id}`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "background status",
		description: "List background jobs (or one by id) with state, runtime, and exit code. Read-only.",
		promptSnippet: "bg_status([id]) — list background jobs + their state/runtime/exit",
		parameters: { type: "object", properties: { id: { type: "string", description: "one job id (omit for all)" } } },
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			if (ctx?.ui?.setStatus) uiCtx = ctx.ui;
			const one = params?.id ? jobs.get(String(params.id)) : null;
			const list = one ? [one] : [...jobs.values()];
			if (!list.length) return { content: [{ type: "text", text: "no background jobs" }] };
			return { content: [{ type: "text", text: JSON.stringify({ jobs: list.map(fmt) }) }] };
		},
	});

	pi.registerTool({
		name: "bg_output",
		label: "background output",
		description:
			"Read a background job's output. By default returns ONLY the NEW output since your last " +
			"bg_output call for this job (incremental — poll a long job without re-reading what you've " +
			"seen). `filter` = a regex to keep only matching lines (e.g. 'error|fail'). `full=true` re-reads " +
			"the whole log from the start. Read-only.",
		promptSnippet:
			"bg_output(id, [filter], [full]) — NEW output since last read (incremental); filter=regex; full=true for all",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "the job id" },
				filter: { type: "string", description: "regex — keep only matching lines" },
				full: { type: "boolean", description: "re-read the entire log (default: only new since last read)" },
			},
			required: ["id"],
		},
		async execute(_id: string, params: any) {
			const j = jobs.get(String(params?.id || ""));
			if (!j) return { content: [{ type: "text", text: `bg_output: no job ${params?.id}` }], isError: true };
			let text = "";
			try {
				text = existsSync(j.logPath) ? readFileSync(j.logPath, "utf-8") : "";
			} catch {}
			const full = params?.full === true;
			// INCREMENTAL: slice from the byte offset already returned, then advance it. So a poll loop
			// only ever pays for genuinely new bytes — the Claude-Code BashOutput semantics.
			const from = full ? 0 : Math.min(j.readOffset, text.length);
			let chunk = text.slice(from);
			j.readOffset = text.length;
			let note = "";
			if (params?.filter) {
				try {
					const re = new RegExp(String(params.filter), "i");
					const kept = chunk.split("\n").filter((l) => re.test(l));
					note = ` · filter '${params.filter}' → ${kept.length} line(s)`;
					chunk = kept.join("\n");
				} catch {
					note = ` · (bad filter regex, ignored)`;
				}
			}
			const head =
				`${j.id} (${j.name}) ${j.state}${j.exitCode != null ? ` exit ${j.exitCode}` : ""}` +
				`${full ? " · full log" : chunk ? " · new output" : " · no new output"}${note}\n`;
			return { content: [{ type: "text", text: head + chunk }] };
		},
	});

	pi.registerTool({
		name: "bg_wait",
		label: "background wait",
		description:
			"Block until a background job finishes (or all running jobs if no id), then return its final " +
			"state + exit code + any NEW output. Use when the next step DEPENDS on a job completing (build " +
			"→ deploy, test → report) instead of guessing timing with bg_status polls. `timeout_s` caps the " +
			"wait (default 300); on timeout it returns the still-running state, not an error.",
		promptSnippet: "bg_wait([id], [timeout_s]) — block until a bg job finishes; returns exit + new output",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "job to wait for (omit = wait for all running jobs)" },
				timeout_s: { type: "integer", description: "max seconds to wait (default 300)" },
			},
		},
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			if (ctx?.ui?.setStatus) uiCtx = ctx.ui;
			const timeout = Math.max(1, Number(params?.timeout_s || 300)) * 1000;
			const targetId = params?.id ? String(params.id) : null;
			if (targetId && !jobs.get(targetId))
				return { content: [{ type: "text", text: `bg_wait: no job ${targetId}` }], isError: true };
			const done = () =>
				targetId ? jobs.get(targetId)!.state !== "running" : [...jobs.values()].every((j) => j.state !== "running");
			const start = Date.now();
			// Poll the job state (event-driven exit already flips it) until done or timeout. No busy spin.
			while (!done() && Date.now() - start < timeout) {
				await new Promise((r) => setTimeout(r, 200));
			}
			const timedOut = !done();
			const report = (targetId ? [jobs.get(targetId)!] : [...jobs.values()]).map(fmt);
			// include the target job's NEW output since last read (so the model sees results in one call)
			let newOut = "";
			if (targetId) {
				const j = jobs.get(targetId)!;
				try {
					const text = existsSync(j.logPath) ? readFileSync(j.logPath, "utf-8") : "";
					newOut = text.slice(Math.min(j.readOffset, text.length));
					j.readOffset = text.length;
				} catch {}
			}
			return {
				content: [
					{
						type: "text",
						text:
							`${timedOut ? "timed out (still running)" : "finished"}\n${JSON.stringify({ jobs: report })}` +
							(newOut ? `\n--- new output ---\n${newOut}` : ""),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "background kill",
		description: "Terminate a running background job by id.",
		promptSnippet: "bg_kill(id) — stop a background job",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "the job id" } },
			required: ["id"],
		},
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			if (ctx?.ui?.setStatus) uiCtx = ctx.ui;
			const j = jobs.get(String(params?.id || ""));
			if (!j) return { content: [{ type: "text", text: `bg_kill: no job ${params?.id}` }], isError: true };
			if (j.state !== "running") return { content: [{ type: "text", text: `${j.id} already ${j.state}` }] };
			try {
				j.proc.kill("SIGTERM");
			} catch {}
			j.state = "killed";
			j.endedAt = Date.now();
			refreshStatus();
			return { content: [{ type: "text", text: `killed ${j.id}` }] };
		},
	});

	// /tasks (alias /bashes) — Claude Code parity: list all background jobs (running + finished)
	// with state, runtime, exit, and log path. A human-readable view of what bg_status returns.
	const tasksHandler = async (_args: string, ctx: any) => {
		if (ctx?.ui?.setStatus) uiCtx = ctx.ui;
		const all = [...jobs.values()];
		if (!all.length) {
			ctx.ui.notify("No background jobs this session. Start one with bg_run.", "info");
			return;
		}
		const icon = (s: string) => (s === "running" ? "⏳" : s === "done" ? "✓" : s === "killed" ? "⊘" : "✗");
		const lines = all.map((j) => {
			const secs = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
			return (
				`  ${icon(j.state)} ${j.id} · ${j.name} · ${j.state}${j.exitCode != null ? ` (exit ${j.exitCode})` : ""} · ${secs}s` +
				`\n      ${j.command.slice(0, 90)}`
			);
		});
		ctx.ui.notify(
			`Background jobs (${all.length}):\n${lines.join("\n")}\n(bg_output <id> for logs · bg_kill <id> to stop)`,
			"info",
		);
	};
	pi.registerCommand("tasks", {
		description: "List background jobs (running + finished) — Claude Code /tasks parity",
		handler: tasksHandler,
	});
	pi.registerCommand("bashes", { description: "Alias of /tasks — list background shells", handler: tasksHandler });

	// Clean shutdown: terminate any still-running jobs so they don't outlive the session.
	pi.on("session_shutdown", async () => {
		for (const j of jobs.values())
			if (j.state === "running") {
				try {
					j.proc.kill("SIGTERM");
				} catch {}
			}
		try {
			uiCtx?.setStatus?.("bg", undefined);
		} catch {}
	});
}
