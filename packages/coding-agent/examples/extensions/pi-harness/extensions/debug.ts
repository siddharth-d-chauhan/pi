/**
 * debug.ts — ONE debugger tool for everything: run-and-inspect (Python/Node) and
 * attach-and-inspect (JVM/Java/Spring-Boot), unified behind a single `debug` tool.
 *
 * Two debugging models under one interface (the runtime/mode is picked by action):
 *  - run  {file, line?, args?}    one-shot: run a Python/Node script under a
 *         debugger; optional breakpoint line dumps locals; any crash gives a
 *         post-mortem traceback + locals. Python via stdlib pdb, Node stack-only.
 *  - attach {port, name?, host?}  interactive: attach to a RUNNING JVM over JDWP
 *         (jdb — ships with every JDK). Then break/locals/print/step/resume while
 *         a request pauses execution inside a handler. Multi-repo = one session
 *         per port.
 *  - break/status/locals/print/where/step/resume/sessions/detach  drive an
 *         attached JVM session.
 *  - help                          full workflow + setup (kept OUT of the prefix).
 *
 * Small prefix: the tool description is one line; the detailed JVM workflow (JDWP
 * launch flags, attach→break→request→inspect) is returned by {action:"help"} on
 * demand, not carried every turn.
 *
 * Config: KP_DEBUG_ENABLED=0 · KP_DEBUG_PYTHON(python3) · KP_JDB(jdb) ·
 *   KP_DEBUG_TIMEOUT_MS.
 */

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

const ENABLED = process.env.KP_DEBUG_ENABLED !== "0";
const PY = process.env.KP_DEBUG_PYTHON || "python3";
const JDB = process.env.KP_JDB || "jdb";
const TIMEOUT = Number(process.env.KP_DEBUG_TIMEOUT_MS || 60_000);

// ---- run-and-inspect (Python / Node) ----------------------------------------
function debugPython(file: string, line: number | undefined, args: string[], cwd: string, condition?: string): string {
	const cmds: string[] = [];
	if (line) {
		cmds.push(
			`break ${file}:${line}${condition ? `, ${condition}` : ""}`,
			"commands 1",
			"silent",
			`print('--- BREAK @ ${file}:${line} ---')`,
			"args",
			"pp {k:v for k,v in locals().items() if not k.startswith('__')}",
			"continue",
			"end",
		);
	}
	cmds.push("continue", "where", "pp {k:v for k,v in locals().items() if not k.startswith('__')}", "quit");
	const cArgs = cmds.flatMap((c) => ["-c", c]);
	try {
		return (
			execFileSync(PY, ["-m", "pdb", ...cArgs, file, ...args], {
				cwd,
				encoding: "utf-8",
				timeout: TIMEOUT,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 4 * 1024 * 1024,
			}).slice(-4000) || "(ran to completion)"
		);
	} catch (e: any) {
		return `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().slice(-4000) || e.message;
	}
}
function debugNode(file: string, args: string[], cwd: string): string {
	const harness = `process.on('uncaughtException',e=>{console.error('--- UNCAUGHT ---');console.error(e&&e.stack||e);process.exit(1);});require(${JSON.stringify(resolve(cwd, file))});`;
	try {
		return (
			execFileSync("node", ["--stack-trace-limit=50", "-e", harness, "--", ...args], {
				cwd,
				encoding: "utf-8",
				timeout: TIMEOUT,
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 4 * 1024 * 1024,
			}).slice(-4000) || "(ran to completion)"
		);
	} catch (e: any) {
		return `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().slice(-4000) || e.message;
	}
}

// ---- attach-and-inspect (JVM via jdb) ---------------------------------------
type Session = {
	id: string;
	name: string;
	port: number;
	proc: ChildProcessWithoutNullStreams;
	buf: string;
	paused: boolean;
};
const sessions = new Map<string, Session>();
let seq = 0;
const drain = (s: Session) => {
	const o = s.buf;
	s.buf = "";
	return o;
};
function jcmd(s: Session, line: string, waitMs = 1500): Promise<string> {
	return new Promise((res) => {
		const before = s.buf.length;
		s.proc.stdin.write(`${line}\n`);
		setTimeout(() => {
			const out = s.buf.slice(before);
			if (/Breakpoint hit|Step completed|Exception occurred/i.test(out)) s.paused = true;
			res(out.trim());
		}, waitMs);
	});
}
function attach(host: string, port: number, name: string): Session {
	const id = `j${++seq}`;
	const proc = spawn(JDB, ["-attach", `${host}:${port}`], { stdio: ["pipe", "pipe", "pipe"] });
	const s: Session = { id, name: name || `jvm:${port}`, port, proc, buf: "", paused: false };
	proc.stdout.on("data", (d) => {
		s.buf += d.toString();
		if (/Breakpoint hit|Step completed/i.test(d.toString())) s.paused = true;
	});
	proc.stderr.on("data", (d) => {
		s.buf += d.toString();
	});
	proc.on("exit", () => sessions.delete(id));
	sessions.set(id, s);
	return s;
}

const HELP =
	"debug — two modes:\n\n" +
	"RUN (Python/Node one-shot): debug{action:'run', file, line?, args?}\n" +
	"  → runs under a debugger; optional breakpoint line dumps locals; crash → post-mortem traceback+locals.\n\n" +
	"ATTACH (running JVM/Spring-Boot — see what a request actually carries in a handler):\n" +
	"  1. App must run with JDWP: java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:<port> …\n" +
	"     (Spring Boot: JAVA_TOOL_OPTIONS or run config; classes need -g = Maven/Gradle default.)\n" +
	"  2. debug{action:'attach', port, name}            → session id\n" +
	"  3. debug{action:'break', location:'OrderController.createOrder' | 'OrderController.java:42'}\n" +
	"  4. Send the request (curl the endpoint) — it hits the breakpoint and PAUSES.\n" +
	"  5. debug{action:'status'} → [PAUSED]; 'where' → stack; 'locals' → request args/DTO in scope;\n" +
	"     debug{action:'print', expr:'body.getItems()'} → evaluate on live objects; 'step' {over|into|out}.\n" +
	"  6. debug{action:'resume'} (finish request) · 'detach'.\n" +
	"  Multi-repo: attach one session per app/port; 'sessions' shows which paused.";

export default function (pi: any) {
	if (!ENABLED) return;

	pi.registerTool({
		name: "debug",
		label: "debug",
		description:
			"Debug by observing runtime values, not guessing. run a Python/Node script (breakpoint/crash inspect), or " +
			"attach to a running JVM/Spring-Boot app to see what a request actually carries in a handler (multi-repo). " +
			'Call {action:"help"} for setup + all actions.',
		promptSnippet: "debug(action,…) — run a script or attach to a live JVM and inspect runtime state",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"run",
						"attach",
						"break",
						"watch",
						"status",
						"locals",
						"print",
						"where",
						"step",
						"resume",
						"sessions",
						"detach",
						"help",
					],
				},
				// run
				file: { type: "string", description: "run: script to debug (.py full, .js stack)" },
				line: { type: "number", description: "run: breakpoint line (Python)" },
				args: { type: "array", items: { type: "string" }, description: "run: program args" },
				// attach + session
				port: { type: "number", description: "attach: JDWP port" },
				name: { type: "string", description: "attach: friendly name (repo/service)" },
				host: { type: "string", description: "attach host (default 127.0.0.1)" },
				session: { type: "string", description: "session id (omit for only/last)" },
				location: { type: "string", description: "break: 'Class.method' or 'File.java:line'" },
				condition: {
					type: "string",
					description: "break: only stop when this expr is true (conditional breakpoint)",
				},
				field: { type: "string", description: "watch: 'Class.fieldName' to pause when it changes" },
				expr: { type: "string", description: "print: expression in the paused frame" },
				kind: {
					type: "string",
					enum: ["over", "into", "out", "access", "all"],
					description: "step kind, or watch mode (access/all)",
				},
			},
			required: ["action"],
		},
		async execute(_id: string, p: any) {
			const cwd = process.cwd();
			if (p.action === "help") return { content: [{ type: "text", text: HELP }] };

			// --- run mode (Python/Node) ---
			if (p.action === "run") {
				if (!p.file) return { content: [{ type: "text", text: "run needs a file" }], isError: true };
				const abs = resolve(cwd, p.file);
				if (!existsSync(abs))
					return { content: [{ type: "text", text: `no such file: ${p.file}` }], isError: true };
				const ext = extname(abs).toLowerCase();
				const args = (p.args ?? []).map(String);
				if (ext === ".py")
					return { content: [{ type: "text", text: debugPython(p.file, p.line, args, cwd, p.condition) }] };
				if (/\.(js|mjs|cjs)$/.test(ext)) return { content: [{ type: "text", text: debugNode(p.file, args, cwd) }] };
				return {
					content: [
						{
							type: "text",
							text: `run supports .py (full) / .js (stack). For a running JVM use action:'attach'.`,
						},
					],
				};
			}

			// --- JVM session modes ---
			if (p.action === "attach") {
				if (!p.port) return { content: [{ type: "text", text: "attach needs a port" }], isError: true };
				const s = attach(p.host || "127.0.0.1", p.port, p.name);
				await new Promise((r) => setTimeout(r, 1200));
				const init = drain(s);
				if (/Unable to attach|Connection refused| error/i.test(init) && !/Initializing jdb|VM Started/i.test(init))
					return {
						content: [{ type: "text", text: `attach ${p.host || "127.0.0.1"}:${p.port} failed:\n${init}` }],
						isError: true,
					};
				return {
					content: [
						{
							type: "text",
							text: `attached ${s.id} (${s.name}) to :${p.port}. debug{action:'break',location:…} then hit the endpoint. ${init.slice(0, 160)}`,
						},
					],
				};
			}
			if (p.action === "sessions") {
				const list = [...sessions.values()]
					.map((s) => `${s.id} ${s.name} :${s.port} ${s.paused ? "[PAUSED]" : "[running]"}`)
					.join("\n");
				return {
					content: [{ type: "text", text: list || "no jvm debug sessions (debug{action:'attach',port:…})" }],
				};
			}
			const s = p.session
				? sessions.get(p.session)
				: sessions.size === 1
					? [...sessions.values()][0]
					: [...sessions.values()].pop();
			if (!s)
				return {
					content: [
						{
							type: "text",
							text: "no session — debug{action:'attach',port:…} first, or {action:'run'} for a script",
						},
					],
					isError: true,
				};
			switch (p.action) {
				case "break": {
					if (!p.location) return { content: [{ type: "text", text: "break needs a location" }], isError: true };
					// conditional breakpoint: jdb supports `stop at Loc if <expr>`
					const base = p.location.includes(":") ? `stop at ${p.location}` : `stop in ${p.location}`;
					const loc = p.condition ? `${base} if ${p.condition}` : base;
					return {
						content: [
							{
								type: "text",
								text:
									(await jcmd(s, loc)) ||
									`breakpoint set: ${p.location}${p.condition ? ` if ${p.condition}` : ""} — now hit the endpoint`,
							},
						],
					};
				}
				case "watch": {
					// field watchpoint: pause when a field is read/modified (jdb `watch`).
					if (!p.field)
						return { content: [{ type: "text", text: "watch needs a field 'Class.fieldName'" }], isError: true };
					const mode = p.kind === "access" ? "access " : p.kind === "all" ? "all " : "";
					return {
						content: [
							{
								type: "text",
								text:
									(await jcmd(s, `watch ${mode}${p.field}`)) ||
									`watching ${p.field} — pauses on ${mode || "modify"}`,
							},
						],
					};
				}
				case "status": {
					drain(s);
					const o = await jcmd(s, "threads", 800);
					return {
						content: [
							{
								type: "text",
								text: `${s.paused ? "PAUSED" : "running"} (${s.name}:${s.port})\n${o.slice(0, 400)}`,
							},
						],
					};
				}
				case "locals":
					return {
						content: [
							{ type: "text", text: (await jcmd(s, "locals")) || "(no frame paused — hit a breakpoint first)" },
						],
					};
				case "print": {
					if (!p.expr) return { content: [{ type: "text", text: "print needs expr" }], isError: true };
					return { content: [{ type: "text", text: await jcmd(s, `print ${p.expr}`) }] };
				}
				case "where":
					return { content: [{ type: "text", text: (await jcmd(s, "where")) || "(not paused)" }] };
				case "step": {
					const kind: "over" | "into" | "out" = p.kind || "over";
					const k = { over: "next", into: "step", out: "step up" }[kind];
					s.paused = false;
					const o = await jcmd(s, k!, 2000);
					s.paused = /Step completed|Breakpoint/i.test(o);
					return { content: [{ type: "text", text: o || "stepped" }] };
				}
				case "resume": {
					s.paused = false;
					const o = await jcmd(s, "cont", 800);
					return { content: [{ type: "text", text: o || "resumed — pauses at next breakpoint" }] };
				}
				case "detach": {
					s.proc.stdin.write("exit\n");
					setTimeout(() => s.proc.kill(), 300);
					sessions.delete(s.id);
					return { content: [{ type: "text", text: `detached ${s.id}` }] };
				}
				default:
					return { content: [{ type: "text", text: "unknown action — debug{action:'help'}" }] };
			}
		},
	});

	pi.registerCommand("debug", {
		description: "Debug sessions: /debug (list attached JVM sessions)",
		handler: async (_a: string, ctx: any) => {
			const list = [...sessions.values()]
				.map((s) => `  ${s.id} ${s.name} :${s.port} ${s.paused ? "[PAUSED]" : "[running]"}`)
				.join("\n");
			ctx.ui.notify(
				list
					? `JVM debug sessions:\n${list}`
					: "No JVM debug sessions. The agent uses the debug tool (run a script or attach to a live JVM).",
				"info",
			);
		},
	});
}
