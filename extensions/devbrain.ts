/**
 * devbrain Extension — mounts the AI-composable block system
 * (~/vault/tools/devbrain) as a single pi tool.
 *
 *   devbrain {cmd:"guide"}                     → the machine brief (read once)
 *   devbrain {cmd:"blocks"}                    → block catalog (id/params/requires/provides)
 *   devbrain {cmd:"validate", flow:{...}}      → deterministic clip-check, no execution
 *   devbrain {cmd:"run", flow:{...}}           → execute; per-step typed verdicts + triage
 *   devbrain {cmd:"doctor", live?:true}        → drift detection over all blocks
 *
 * One tool (not five) keeps the standing schema cost minimal; the guide teaches
 * the model the whole contract. Flows are piped via stdin (`flow run -`), the
 * abort signal kills the child, and stdlib-only devbrain runs on system python3
 * with PYTHONPATH — no venv coupling.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEVBRAIN_ROOT = process.env.PI_DEVBRAIN_ROOT ?? `${process.env.HOME}/vault/tools/devbrain`;
/** Composition/introspection are fast; run/doctor--live can bring stacks up. */
const FAST_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = Number(process.env.PI_DEVBRAIN_RUN_TIMEOUT_MS ?? 900_000);

const devbrainSchema = Type.Object({
	cmd: Type.Unsafe<"guide" | "blocks" | "goal" | "validate" | "run" | "doctor" | "draft">({
		type: "string",
		enum: ["guide", "blocks", "goal", "validate", "run", "doctor", "draft"],
		description: "goal = plan+run from capabilities; draft = author a block from flat fields",
	}),
	fields: Type.Optional(
		Type.Unsafe<Record<string, unknown>>({
			type: "object",
			description:
				"draft: FLAT fields (id, description, command|url|spec, requires, provides, verify_command…) — never hand-write block JSON",
		}),
	),
	write: Type.Optional(Type.Boolean({ description: "draft: write the block into <repo>/devbrain/blocks when valid" })),
	goal: Type.Optional(Type.String({ description: "goal: comma-separated target capabilities, e.g. 'mfa-enrolled'" })),
	params: Type.Optional(
		Type.Unsafe<Record<string, unknown>>({ type: "object", description: "shared param pool (goal/run)" }),
	),
	flow: Type.Optional(
		Type.Unsafe<Record<string, unknown>>({
			type: "object",
			description: "manual flow doc for validate/run: {steps:[{block, params?}], assume?, params?}",
		}),
	),
	repo: Type.Optional(Type.String({ description: "product repo path (adds its devbrain/blocks)" })),
	live: Type.Optional(Type.Boolean({ description: "doctor: also run each block's verify" })),
});

type DevbrainInput = Static<typeof devbrainSchema>;

function cliArgs(input: DevbrainInput): { args: string[]; stdin?: string; timeoutMs: number } {
	const repo = input.repo ? ["--repo", input.repo] : [];
	switch (input.cmd) {
		case "guide":
			return { args: ["guide"], timeoutMs: FAST_TIMEOUT_MS };
		case "blocks":
			return { args: [...repo, "blocks", "list", "--json"], timeoutMs: FAST_TIMEOUT_MS };
		case "goal":
			return {
				args: [
					...repo,
					"flow",
					"goal",
					input.goal ?? "",
					...(input.params ? ["--params", JSON.stringify(input.params)] : []),
				],
				timeoutMs: RUN_TIMEOUT_MS,
			};
		case "draft":
			return {
				args: [
					...repo,
					"blocks",
					"draft",
					"--fields",
					JSON.stringify(input.fields ?? {}),
					...(input.write ? ["--write"] : []),
				],
				timeoutMs: FAST_TIMEOUT_MS,
			};
		case "validate":
			return {
				args: [...repo, "flow", "validate", "-"],
				stdin: JSON.stringify(input.flow ?? {}),
				timeoutMs: FAST_TIMEOUT_MS,
			};
		case "run":
			return {
				args: [...repo, "flow", "run", "-"],
				stdin: JSON.stringify(input.flow ?? {}),
				timeoutMs: RUN_TIMEOUT_MS,
			};
		case "doctor":
			return {
				args: [...repo, "doctor", ...(input.live ? ["--live"] : [])],
				timeoutMs: input.live ? RUN_TIMEOUT_MS : FAST_TIMEOUT_MS,
			};
	}
}

function runCli(
	spec: { args: string[]; stdin?: string; timeoutMs: number },
	signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-m", "devbrain.cli", ...spec.args], {
			env: { ...process.env, PYTHONPATH: DEVBRAIN_ROOT },
			cwd: DEVBRAIN_ROOT,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutMs);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(spec.stdin ?? "");
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "devbrain",
		label: "devbrain",
		description:
			"Composable self-verifying blocks for setup/testing (env.up, login, sso, mfa, …). " +
			"Call {cmd:'guide'} once to learn the contract, {cmd:'blocks'} for the catalog, then " +
			"validate and run composed flows; failures come back triage-typed (env/flake_suspect/product_bug).",
		parameters: devbrainSchema,
		async execute(_id: string, input: DevbrainInput, signal?: AbortSignal) {
			if (!existsSync(DEVBRAIN_ROOT)) {
				throw new Error(`devbrain not found at ${DEVBRAIN_ROOT} (set PI_DEVBRAIN_ROOT)`);
			}
			if ((input.cmd === "validate" || input.cmd === "run") && !input.flow) {
				throw new Error(`cmd '${input.cmd}' needs a flow — call {cmd:"guide"} for the format`);
			}
			if (input.cmd === "goal" && !input.goal) {
				throw new Error(`cmd 'goal' needs goal capabilities — see {cmd:"blocks"} provides tokens`);
			}
			const result = await runCli(cliArgs(input), signal);
			const text = result.stdout.trim() || result.stderr.trim() || `(exit ${result.code})`;
			// Exit 1 = flow/doctor reported failure — that's a RESULT for the
			// model (triage-typed), not a tool error. Exit 2 = composition/usage
			// error: also a result (the JSON names the fix). Only spawn-level
			// problems throw.
			if (result.code !== 0 && !result.stdout.trim()) {
				throw new Error(`devbrain failed (exit ${result.code}): ${result.stderr.slice(0, 400)}`);
			}
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerCommand("devbrain", {
		description: "devbrain status: blocks + doctor (drift check)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const live = args.trim() === "live";
			try {
				const blocks = await runCli(cliArgs({ cmd: "blocks" }));
				const doctor = await runCli(cliArgs({ cmd: "doctor", live }));
				const catalog = JSON.parse(blocks.stdout) as { blocks: Array<{ id: string }> };
				const health = JSON.parse(doctor.stdout) as {
					ok: boolean;
					findings: Array<{ status: string; block: string; detail: string }>;
				};
				const bad = health.findings.filter((f) => f.status !== "ok");
				const lines = [
					`devbrain: ${catalog.blocks.length} blocks · doctor ${health.ok ? "OK" : "FAILING"}${live ? " (live)" : ""}`,
					...bad
						.slice(0, 8)
						.map((f) => `  ${f.status === "fail" ? "✗" : "⚠"} ${f.block}: ${f.detail.slice(0, 70)}`),
				];
				ctx.ui.notify(lines.join("\n"), health.ok ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`devbrain unavailable: ${(err as Error).message}`, "error");
			}
		},
	});
}
