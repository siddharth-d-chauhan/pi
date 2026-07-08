/**
 * sandbox.ts — run commands in an OS-level sandbox (the frontier gap).
 *
 * The 2026 frontier ("the agent you don't watch") is autonomous work in an
 * isolated environment so a bad command can't damage your machine — Devin/Codex
 * Cloud use ephemeral VMs; this does the portable local equivalent using each
 * OS's native sandbox primitive. Runs a command confined to the WORKSPACE with NO
 * NETWORK by default (both configurable per call).
 *
 * Portable across your platforms (auto-detected, best-first):
 *  - macOS:  sandbox-exec (Seatbelt) — deny-default policy: read anywhere, write
 *            ONLY under the workspace (+ a private per-run scratch dir bound as
 *            TMPDIR), no network. VERIFIED blocks out-of-workspace writes (incl.
 *            /tmp and $HOME) and network — strict containment, no leak.
 *  - WSL/Linux: bwrap (bubblewrap) — bind workspace rw, rest ro, --unshare-net;
 *            else firejail (--net=none --whitelist); else unshare (namespaces).
 *  - fallback: docker run --network=none -v <ws> (if a runtime is present).
 *  - none available → refuse (don't silently run unsandboxed).
 *
 * Use: sandbox_run{command, network?, writable?} for a one-off; or wrap an
 * autonomous flow (delegate can pass KP_SANDBOX=1 to run stages sandboxed — the
 * child pi's bash goes through here via policy, future work).
 *
 * ── AUTO-ENFORCEMENT (KP_SANDBOX_MODE) ───────────────────────────────────────
 * sandbox_run above is OPT-IN — the model must choose it. That's the gap vs Codex/
 * Claude Code, which wrap EVERY bash command by policy so an autonomous agent can't
 * run unsandboxed even if it forgets to ask. KP_SANDBOX_MODE closes it by rewriting
 * every bash tool_call's command into the sandboxed argv, so the model cannot bypass:
 *   off       (default) — no auto-wrap; sandbox_run stays available opt-in.
 *   workspace — auto-wrap: writes confined to the workspace (+scratch), network per
 *               KP_SANDBOX_ALLOW_NET. The everyday "contained but usable" mode.
 *   strict    — auto-wrap with network OFF always, ignoring per-call net requests.
 * A delegated/autonomous child inherits enforcement: delegate sets KP_SANDBOX=1 → we
 * treat it as `workspace` unless MODE is already stricter. Interactive sessions stay
 * `off` by default (you're watching) — turn it on per session when you step away.
 * Escape hatch: a caller can prefix a command with the marker in KP_SANDBOX_BYPASS
 * (unset by default) to run one command unwrapped; logged, never silent.
 *
 * Config: KP_SANDBOX_ENABLED=0 disable · KP_SANDBOX_MODE=off|workspace|strict ·
 *   KP_SANDBOX_TIMEOUT_MS · KP_SANDBOX_ALLOW_NET (default network off) ·
 *   KP_SANDBOX_IMAGE (docker fallback image) · KP_SANDBOX_BYPASS (opt-out marker).
 */

import { type ChildProcessByStdio, execSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

const ENABLED = process.env.KP_SANDBOX_ENABLED !== "0";
const TIMEOUT = Number(process.env.KP_SANDBOX_TIMEOUT_MS || 300_000);

function have(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

type Backend = "seatbelt" | "bwrap" | "firejail" | "unshare" | "docker" | "none";
function detectBackend(): Backend {
	if (platform() === "darwin" && have("sandbox-exec")) return "seatbelt";
	if (have("bwrap")) return "bwrap";
	if (have("firejail")) return "firejail";
	if (have("unshare")) return "unshare";
	if (have("docker")) return "docker";
	return "none";
}

// Build the sandboxed argv for a shell command. writable = extra dirs (beyond ws)
// the command may write; net = allow network. STRICT by default: only the
// workspace is writable (real containment). A per-process temp dir is bound too so
// build tools that need scratch work, but the shared /tmp is NOT writable unless
// the caller adds it to `writable` — otherwise "contained" wouldn't mean contained.
function wrap(
	backend: Backend,
	cmd: string,
	ws: string,
	net: boolean,
	writable: string[],
	scratch: string,
): { argv: string[]; cleanup?: () => void } {
	// Resolve symlinks so kernel-level subpath matches hold — on macOS /tmp is a
	// symlink to /private/tmp, so a writable dir of "/tmp/x" would otherwise be
	// denied (the write resolves to /private/tmp/x). realpath what exists; leave
	// non-existent paths as-is (caller may pre-authorize a dir the command creates).
	const real = (d: string) => {
		try {
			return realpathSync(d);
		} catch {
			return d;
		}
	};
	const writes = [ws, scratch, ...writable].map(real);
	switch (backend) {
		case "seatbelt": {
			const rules = [
				"(version 1)",
				"(deny default)",
				"(allow process-exec)",
				"(allow process-fork)",
				"(allow signal)",
				"(allow sysctl-read)",
				"(allow mach-lookup)",
				"(allow file-read*)",
				...writes.map((d) => `(allow file-write* (subpath ${JSON.stringify(d)}))`),
				'(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty"))',
				net ? "(allow network*)" : "(deny network*)",
			].join("\n");
			const dir = mkdtempSync(join(tmpdir(), "sb-"));
			const pol = join(dir, "policy.sb");
			writeFileSync(pol, rules);
			return {
				argv: ["sandbox-exec", "-f", pol, "bash", "-c", cmd],
				cleanup: () => rmSync(dir, { recursive: true, force: true }),
			};
		}
		case "bwrap": {
			const args = [
				"bwrap",
				"--die-with-parent",
				"--ro-bind",
				"/",
				"/",
				"--dev",
				"/dev",
				"--proc",
				"/proc",
				"--tmpfs",
				"/tmp",
			];
			for (const d of writes) args.push("--bind", d, d);
			if (!net) args.push("--unshare-net");
			args.push("bash", "-c", cmd);
			return { argv: args };
		}
		case "firejail": {
			const args = ["firejail", "--quiet", "--noprofile"];
			if (!net) args.push("--net=none");
			for (const d of writes) args.push(`--whitelist=${d}`);
			args.push("bash", "-c", cmd);
			return { argv: args };
		}
		case "unshare": {
			// namespaces: new mount+pid; network off via --net if unprivileged userns allows
			const args = ["unshare", "--map-root-user", "--mount", "--pid", "--fork"];
			if (!net) args.push("--net");
			args.push("bash", "-c", cmd);
			return { argv: args };
		}
		case "docker": {
			const args = ["docker", "run", "--rm", "-w", "/ws", "-v", `${ws}:/ws`];
			if (!net) args.push("--network=none");
			args.push("alpine:latest", "sh", "-c", cmd); // minimal; user can set KP_SANDBOX_IMAGE
			return { argv: args };
		}
		default:
			return { argv: [] };
	}
}

function runSandboxed(
	cmd: string,
	ws: string,
	net: boolean,
	writable: string[],
): Promise<{ ok: boolean; output: string; backend: Backend }> {
	return new Promise((resolve) => {
		const backend = detectBackend();
		if (backend === "none")
			return resolve({
				ok: false,
				output:
					"no sandbox backend available (need sandbox-exec / bwrap / firejail / docker). Refusing to run unsandboxed.",
				backend,
			});
		// Private scratch dir (bound writable) so build tools have TMPDIR without
		// opening the shared /tmp. realpath so Seatbelt's subpath match works on macOS
		// (/var/folders is a symlink target of /private/var/folders). Cleaned up after.
		let scratch = mkdtempSync(join(tmpdir(), "sbwork-"));
		try {
			scratch = realpathSync(scratch);
		} catch {}
		const { argv, cleanup } = wrap(backend, cmd, ws, net, writable, scratch);
		const img = process.env.KP_SANDBOX_IMAGE;
		if (backend === "docker" && img) argv[argv.indexOf("alpine:latest")] = img;
		let out = "";
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(argv[0], argv.slice(1), {
				cwd: ws,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, TMPDIR: scratch },
			});
		} catch (e: any) {
			cleanup?.();
			rmSync(scratch, { recursive: true, force: true });
			return resolve({ ok: false, output: `sandbox spawn failed: ${e.message}`, backend });
		}
		const done = (r: { ok: boolean; output: string }) => {
			cleanup?.();
			try {
				rmSync(scratch, { recursive: true, force: true });
			} catch {}
			resolve({ ...r, backend });
		};
		const timer = setTimeout(() => proc.kill(), TIMEOUT);
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", (d) => {
			out += d.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			done({ ok: code === 0, output: out.slice(-8000) });
		});
		proc.on("error", (e) => {
			clearTimeout(timer);
			done({ ok: false, output: `sandbox error: ${e.message}` });
		});
	});
}

// ── auto-enforcement helpers ────────────────────────────────────────────────
type Mode = "off" | "workspace" | "strict";
function resolveMode(): Mode {
	const m = String(process.env.KP_SANDBOX_MODE || "").toLowerCase();
	if (m === "workspace" || m === "strict") return m;
	// A delegated/autonomous child (KP_SANDBOX=1 from delegate) defaults to workspace
	// enforcement even if MODE wasn't set — "the agent you don't watch" must be contained.
	if (process.env.KP_SANDBOX === "1") return "workspace";
	return "off";
}
// Shell-quote a single argument for safe interpolation into a bash -c string.
function shq(s: string): string {
	return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Wrap a raw bash command string into a sandboxed command STRING (bash runs a string,
// not an argv), reusing wrap()'s backend policy. Returns null if already wrapped or no
// backend. The scratch dir leaks per-call here (bash tool owns the lifecycle) — bounded
// and under tmp; acceptable for the auto path (the tool path cleans up precisely).
function autoWrapCommand(cmd: string, mode: Mode): string | null {
	if (mode === "off") return null;
	const backend = detectBackend();
	if (backend === "none") return null; // fail-open handled by caller (warn once)
	if (/\bsandbox-exec\b|\bbwrap\b|\bfirejail\b/.test(cmd)) return null; // already sandboxed
	const net = mode === "strict" ? false : process.env.KP_SANDBOX_ALLOW_NET === "1";
	let scratch = mkdtempSync(join(tmpdir(), "sbauto-"));
	try {
		scratch = realpathSync(scratch);
	} catch {}
	const { argv } = wrap(backend, cmd, process.cwd(), net, [], scratch);
	if (!argv.length) return null;
	// argv is [tool, ...args, "bash","-c", cmd]; render as a quoted command string.
	return argv.map(shq).join(" ");
}

export default function (pi: any) {
	if (!ENABLED) return;

	const backend = detectBackend();
	const mode = resolveMode();
	let warnedNoBackend = false;

	// AUTO-ENFORCEMENT: rewrite every bash command into its sandboxed form so the model
	// can't run unsandboxed. tool_call input is mutable in place (like guardrails' bash
	// hardening). Only when MODE != off. A missing backend fails OPEN with a one-time warn
	// (refusing to run any bash would brick the session) — documented tradeoff.
	if (mode !== "off") {
		pi.on("tool_call", (event: any) => {
			const name = String(event?.name ?? event?.tool ?? "");
			if (!/^bash$/i.test(name)) return;
			const input = event?.input ?? event?.arguments ?? {};
			const cmd = String(input.command ?? "");
			if (!cmd) return;
			const bypass = process.env.KP_SANDBOX_BYPASS;
			if (bypass && cmd.startsWith(bypass)) {
				try {
					pi.ui?.notify?.(`⚠ sandbox bypassed for one command (marker matched)`, "warning");
				} catch {}
				input.command = cmd.slice(bypass.length).trimStart();
				return;
			}
			const wrapped = autoWrapCommand(cmd, mode);
			if (wrapped) {
				input.command = wrapped;
				return;
			}
			if (backend === "none" && !warnedNoBackend) {
				warnedNoBackend = true;
				try {
					pi.ui?.notify?.(
						`⚠ KP_SANDBOX_MODE=${mode} but no sandbox backend (bwrap/sandbox-exec/docker) — bash runs UNSANDBOXED. Install one to enforce.`,
						"warning",
					);
				} catch {}
			}
		});
	}

	pi.registerTool({
		name: "sandbox_run",
		label: "sandbox",
		description:
			"Run a shell command in an OS-level sandbox — confined to the workspace, NO NETWORK by default. Use for " +
			"untrusted code, risky commands, or autonomous work you want contained (a bad command can't touch the rest " +
			"of the machine). Set network:true to allow net, writable:[dirs] for extra write access.",
		promptSnippet: "sandbox_run(command) — run isolated to the workspace, no network (contained blast radius)",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "shell command to run sandboxed" },
				network: { type: "boolean", description: "allow network (default false)" },
				writable: {
					type: "array",
					items: { type: "string" },
					description: "extra dirs the command may write (beyond workspace/tmp)",
				},
			},
			required: ["command"],
		},
		async execute(_id: string, p: any) {
			const net = p.network ?? process.env.KP_SANDBOX_ALLOW_NET === "1";
			const r = await runSandboxed(String(p.command ?? ""), process.cwd(), net, (p.writable ?? []).map(String));
			return {
				content: [
					{
						type: "text",
						text: `[sandbox: ${r.backend}, net ${net ? "on" : "off"}, ${r.ok ? "exit 0" : "failed"}]\n${r.output || "(no output)"}`,
					},
				],
				isError: !r.ok,
			};
		},
	});

	pi.registerCommand("sandbox", {
		description: "Show the sandbox backend in use",
		handler: async (_a: string, ctx: any) => {
			ctx.ui.notify(
				backend === "none"
					? "No sandbox backend available. Install: macOS has sandbox-exec built-in; WSL/Linux → apt install bubblewrap (bwrap) or firejail; or docker."
					: `Sandbox backend: ${backend} (${platform()}) · enforcement mode: ${mode}` +
							(mode === "off"
								? " (sandbox_run is opt-in; set KP_SANDBOX_MODE=workspace|strict to auto-wrap every bash)."
								: ` — EVERY bash command is auto-confined to the workspace${mode === "strict" ? ", network always off" : ""}. The model cannot bypass.`),
				backend === "none" ? "warning" : "info",
			);
		},
	});
}
