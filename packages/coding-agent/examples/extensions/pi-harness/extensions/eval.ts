/**
 * eval.ts — opt-in persistent Python eval tool (adopted from oh-my-pi).
 *
 * When KP_EVAL=1, registers an `eval` tool backed by ONE long-lived Python
 * subprocess per session that speaks a tiny NDJSON protocol over stdin/stdout.
 * Globals persist ACROSS eval calls (like a notebook kernel) but reset PER CELL
 * boundary is not enforced — instead each call may pass multiple `cells` which
 * execute in order sharing the same globals; the last expression's repr and any
 * stdout/stderr are captured. No Jupyter / ipykernel dependency — a ~90-line
 * bundled runner using only the stdlib.
 *
 * Robustness (ported intent from oh-my-pi):
 *   - die-and-retry-once: if the runner has crashed, respawn and retry the call.
 *   - cancellation ladder: SIGINT → (grace) SIGTERM → (grace) SIGKILL, so a
 *     runaway cell can be interrupted without killing persisted globals when
 *     SIGINT alone suffices.
 *   - OutputSink truncation: large stdout/stderr/result is head+tail clipped so
 *     a noisy cell can't blow the context budget.
 *
 * Config:
 *   KP_EVAL=1                enable (off by default)
 *   KP_EVAL_PYTHON           interpreter (default python3)
 *   KP_EVAL_TIMEOUT_MS       per-call wall clock (default 30000)
 *   KP_EVAL_OUTPUT_MAX       max chars returned per stream (default 12000)
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.KP_EVAL === "1";
const PYTHON = process.env.KP_EVAL_PYTHON || "python3";
const TIMEOUT_MS = Number(process.env.KP_EVAL_TIMEOUT_MS || 30_000);
const OUTPUT_MAX = Number(process.env.KP_EVAL_OUTPUT_MAX || 12_000);

// Bundled runner: reads one NDJSON request per line {id, cells:[...]} and writes
// one NDJSON response {id, ok, stdout, stderr, result, error}. Globals persist in
// a module-level dict across requests. stdlib only.
const RUNNER_SRC = `
import sys, io, json, traceback, contextlib, ast

_GLOBALS = {"__name__": "__eval__"}

def _run(cells):
    out, err = io.StringIO(), io.StringIO()
    result_repr = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        for cell in cells:
            src = cell if isinstance(cell, str) else str(cell)
            # exec all-but-last statement, eval the last expression if it is one
            try:
                mod = ast.parse(src, mode="exec")
            except SyntaxError:
                raise
            body = mod.body
            last_expr = None
            if body and isinstance(body[-1], ast.Expr):
                last_expr = body.pop()
            if body:
                exec(compile(ast.Module(body, type_ignores=[]), "<eval>", "exec"), _GLOBALS)
            if last_expr is not None:
                val = eval(compile(ast.Expression(last_expr.value), "<eval>", "eval"), _GLOBALS)
                if val is not None:
                    result_repr = repr(val)
    return out.getvalue(), err.getvalue(), result_repr

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        cells = req.get("cells") or []
        if isinstance(cells, str):
            cells = [cells]
        resp = {"id": rid}
        try:
            so, se, res = _run(cells)
            resp.update(ok=True, stdout=so, stderr=se, result=res)
        except KeyboardInterrupt:
            resp.update(ok=False, stdout="", stderr="", result=None, error="KeyboardInterrupt (cancelled)")
        except BaseException:
            resp.update(ok=False, stdout="", stderr="", result=None, error=traceback.format_exc())
        sys.stdout.write(json.dumps(resp) + "\\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
`;

function runnerPath(): string {
	const dir = join(homedir(), ".pi", "agent", "pi-harness");
	mkdirSync(dir, { recursive: true });
	const p = join(dir, "eval-runner.py");
	writeFileSync(p, RUNNER_SRC);
	return p;
}

/** OutputSink-style head+tail truncation for a single stream. */
function clip(s: string): string {
	if (!s) return "";
	if (s.length <= OUTPUT_MAX) return s;
	const half = Math.floor(OUTPUT_MAX / 2);
	return `${s.slice(0, half)}\n…[${s.length - OUTPUT_MAX} chars elided]…\n${s.slice(s.length - half)}`;
}

interface EvalResp {
	id: number;
	ok: boolean;
	stdout?: string;
	stderr?: string;
	result?: string | null;
	error?: string;
}

/** A long-lived Python kernel speaking NDJSON. One per session. */
class PyKernel {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private buf = "";
	private nextId = 1;
	private stuckSince: number | null = null; // set on cancel; cleared on any kernel response
	private readonly pending = new Map<number, (r: EvalResp) => void>();
	private readonly script: string;

	constructor(script: string) {
		this.script = script;
	}

	private spawnProc() {
		const proc = spawn(PYTHON, ["-u", this.script], { stdio: ["pipe", "pipe", "pipe"] });
		proc.stdout.setEncoding("utf-8");
		proc.stdout.on("data", (d: string) => this.onData(d));
		proc.stderr.on("data", () => {}); // runner-level stderr; cell stderr comes back in the response
		proc.on("exit", () => {
			this.proc = null;
			// fail any in-flight requests so callers can retry
			for (const [, resolve] of this.pending)
				resolve({ id: -1, ok: false, error: "eval kernel exited unexpectedly" });
			this.pending.clear();
		});
		this.proc = proc;
	}

	private ensure() {
		if (!this.proc) this.spawnProc();
	}

	private onData(chunk: string) {
		this.stuckSince = null; // the kernel spoke → it's alive; abort any pending cancel escalation
		this.buf += chunk;
		for (;;) {
			const nl = this.buf.indexOf("\n");
			if (nl < 0) break;
			const line = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			if (!line.trim()) continue;
			let resp: EvalResp;
			try {
				resp = JSON.parse(line);
			} catch {
				continue;
			}
			const cb = this.pending.get(resp.id);
			if (cb) {
				this.pending.delete(resp.id);
				cb(resp);
			}
		}
	}

	/** SIGINT → SIGTERM → SIGKILL cancellation ladder on timeout.
	 *  A plain SIGINT interrupts the current cell but the kernel (and its globals) can
	 *  RECOVER. Escalating to SIGTERM/SIGKILL on a recovered kernel would needlessly destroy
	 *  session state. So we only escalate while the kernel is still unresponsive: `cancelSeq`
	 *  is bumped here and any kernel response/write clears `stuckSince` — each escalation step
	 *  re-checks that the same cancel is still pending AND nothing has been heard since. */
	private cancelSeq = 0;
	private cancel() {
		const p = this.proc;
		if (!p) return;
		const seq = ++this.cancelSeq;
		this.stuckSince = Date.now();
		try {
			p.kill("SIGINT");
		} catch {}
		const stillStuck = () => this.proc === p && this.cancelSeq === seq && this.stuckSince !== null;
		setTimeout(() => {
			if (!stillStuck()) return; // kernel recovered after SIGINT — leave it alone
			try {
				p.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				if (!stillStuck()) return;
				try {
					p.kill("SIGKILL");
				} catch {}
			}, 1_500);
		}, 1_500);
	}

	private once(cells: string[]): Promise<EvalResp> {
		return new Promise((resolve) => {
			this.ensure();
			const proc = this.proc;
			if (!proc) return resolve({ id: -1, ok: false, error: "failed to spawn python kernel" });
			const id = this.nextId++;
			let done = false;
			const settle = (r: EvalResp) => {
				if (done) return;
				done = true;
				this.pending.delete(id);
				clearTimeout(timer);
				resolve(r);
			};
			const timer = setTimeout(() => {
				this.cancel(); // interrupt the runaway cell (globals survive a plain SIGINT)
				settle({ id, ok: false, error: `eval timed out after ${TIMEOUT_MS}ms (cancelled)` });
			}, TIMEOUT_MS);
			this.pending.set(id, settle);
			try {
				proc.stdin.write(`${JSON.stringify({ id, cells })}\n`);
			} catch {
				settle({ id, ok: false, error: "kernel stdin closed" });
			}
		});
	}

	/** die-and-retry-once: if the kernel had crashed, respawn and retry a single time. */
	async run(cells: string[]): Promise<EvalResp> {
		const first = await this.once(cells);
		if (first.ok || (first.error && !/exited|spawn|stdin closed/.test(first.error))) return first;
		// kernel-level failure → globals are gone anyway; respawn and retry once
		this.proc = null;
		return this.once(cells);
	}

	shutdown() {
		try {
			this.proc?.kill("SIGKILL");
		} catch {}
		this.proc = null;
	}
}

export default function (pi: any) {
	if (!ENABLED) return; // opt-in only

	let kernel: PyKernel | null = null;
	const getKernel = () => {
		kernel ??= new PyKernel(runnerPath());
		return kernel;
	};

	pi.on("session_shutdown", () => kernel?.shutdown());

	pi.registerTool({
		name: "eval",
		label: "python eval",
		description:
			"Run Python in a PERSISTENT kernel — globals (variables, imports, defs) persist across eval calls " +
			"in this session, like a notebook. Pass `cells` (array of code strings) executed in order sharing " +
			"the same namespace; the last expression's repr plus stdout/stderr come back. Use for quick " +
			"computation, data inspection, and iterative exploration without re-setting-up state each call.",
		promptSnippet:
			"eval(cells[]) — persistent Python kernel (globals survive across calls); returns stdout/stderr + last-expr repr",
		parameters: {
			type: "object",
			properties: {
				cells: {
					oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
					description: "code cell(s) to run in order; globals persist across calls",
				},
			},
			required: ["cells"],
		},
		async execute(_id: string, params: any) {
			const raw = params?.cells;
			const cells: string[] = Array.isArray(raw) ? raw.map(String) : [String(raw ?? "")];
			if (!cells.some((c) => c.trim())) return { content: [{ type: "text", text: "eval: no code provided" }] };
			let r: any;
			try {
				r = await getKernel().run(cells);
			} catch (e: any) {
				// fail open like every other path here — a fs/spawn fault (read-only HOME, ENOSPC,
				// no python3) must not crash the turn.
				return {
					content: [{ type: "text", text: `eval unavailable: ${String(e?.message ?? e).slice(0, 200)}` }],
					isError: true,
				};
			}
			const out: string[] = [];
			if (!r.ok) out.push(`ERROR:\n${clip(r.error || "unknown error")}`);
			const so = clip(r.stdout || "");
			const se = clip(r.stderr || "");
			if (so) out.push(`stdout:\n${so}`);
			if (se) out.push(`stderr:\n${se}`);
			if (r.result != null) out.push(`=> ${clip(String(r.result))}`);
			if (!out.length) out.push(r.ok ? "(no output)" : "(failed, no output)");
			return { content: [{ type: "text", text: out.join("\n\n") }] };
		},
	});

	pi.registerCommand("eval-reset", {
		description: "Reset the persistent Python eval kernel (clears all globals)",
		handler: async (_args: string, ctx: any) => {
			kernel?.shutdown();
			kernel = null;
			ctx.ui.notify("Python eval kernel reset — globals cleared.", "info");
		},
	});
}
