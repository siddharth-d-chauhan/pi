/**
 * Quality Gate Extension — the deterministic code-quality lane pi lacked,
 * ported as BEHAVIOR from ECC's hook suite (stop-format-typecheck,
 * config-protection, block-no-verify, check-console-log), not as code: pi's
 * other guards police budget/repetition/memory; nothing verified edit quality
 * outside /loop. All checks are deterministic — zero LLM calls, zero standing
 * context; feedback reaches the model only when a check actually fails.
 *
 * - Batch typecheck at settle: files edited this run are accumulated and
 *   checked ONCE per settle (tsc --noEmit when a tsconfig + local tsc exist,
 *   or the `typecheck` command from .pi/quality.json), time-boxed.
 * - Debug-debris warning: edited JS/TS files containing console.log/debugger
 *   (tests, configs, and scripts/ excluded) produce a one-line warning.
 * - Config protection: the FIRST edit to an existing lint/format/ts config in
 *   a run is blocked with a steer ("fix the code, not the gate"); an
 *   immediate retry is allowed, so deliberate, user-requested changes pass.
 * - `git commit --no-verify` is blocked.
 *
 * Off-switches: PI_QUALITY=0 (all), or per-check via .pi/quality.json:
 * { "typecheck": "cmd" | false, "consoleWarn": false, "configGuard": false,
 *   "blockNoVerify": false }.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TYPECHECK_TIMEOUT_MS = 120_000;
const MAX_REPORT_CHARS = 3_000;

interface QualityConfig {
	typecheck?: string | false;
	consoleWarn?: boolean;
	configGuard?: boolean;
	blockNoVerify?: boolean;
}

function loadConfig(cwd: string): QualityConfig {
	try {
		return JSON.parse(readFileSync(join(cwd, ".pi", "quality.json"), "utf-8")) as QualityConfig;
	} catch {
		return {};
	}
}

function enabled(): boolean {
	return process.env.PI_QUALITY !== "0";
}

const CONFIG_FILE_RE =
	/^(\.eslintrc(\..+)?|eslint\.config\.[cm]?[jt]s|biome\.jsonc?|\.prettierrc(\..+)?|prettier\.config\.[cm]?js|tsconfig(\..+)?\.json|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|\.oxlintrc\.json|ruff\.toml|\.golangci\.ya?ml)$/;

/** Lint/format/typecheck configs agents weaken to make gates pass. */
export function isProtectedConfig(path: string): boolean {
	return CONFIG_FILE_RE.test(basename(path));
}

/** console.log/debugger debris in non-test, non-config, non-scripts JS/TS. */
export function hasDebugDebris(path: string, content: string): boolean {
	if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return false;
	if (/(^|\/)(test|tests|__tests__|scripts|bench)\//.test(path) || /\.(test|spec)\./.test(path)) return false;
	if (isProtectedConfig(path)) return false;
	return /\bconsole\.log\s*\(|\bdebugger\b/.test(content);
}

/** A bash command that bypasses commit hooks. */
export function bypassesCommitHooks(command: string): boolean {
	return /\bgit\b[\s\S]*\bcommit\b[\s\S]*--no-verify\b/.test(command);
}

function editedPathOf(event: { toolName: string; input: Record<string, unknown> }): string | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "apply_patch") return undefined;
	const path = event.input.path ?? event.input.file_path;
	return typeof path === "string" ? path : undefined;
}

function resolveTypecheck(cwd: string, config: QualityConfig): { cmd: string; args: string[] } | undefined {
	if (config.typecheck === false) return undefined;
	if (typeof config.typecheck === "string" && config.typecheck.trim()) {
		return { cmd: "bash", args: ["-c", config.typecheck] };
	}
	const tsc = join(cwd, "node_modules", ".bin", "tsc");
	if (existsSync(join(cwd, "tsconfig.json")) && existsSync(tsc)) return { cmd: tsc, args: ["--noEmit"] };
	return undefined;
}

export default function qualityGate(pi: ExtensionAPI) {
	/** Files edited since the last settle check (cleared on read, ECC-style). */
	const editedThisRun = new Set<string>();
	/** Config files whose first edit this run was already blocked once. */
	const configWarned = new Set<string>();
	let checking = false;

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled()) return;
		const config = loadConfig(ctx.cwd);
		if (event.toolName === "bash" && config.blockNoVerify !== false) {
			const command = (event.input as { command?: string }).command ?? "";
			if (bypassesCommitHooks(command)) {
				return {
					block: true,
					reason:
						"git commit --no-verify bypasses the repo's hooks. Fix what the hooks report instead; if the user explicitly wants the bypass, ask them to run it themselves.",
				};
			}
		}
		const path = editedPathOf(event as { toolName: string; input: Record<string, unknown> });
		if (!path) return;
		const absolute = isAbsolute(path) ? path : join(ctx.cwd, path);
		if (config.configGuard !== false && isProtectedConfig(absolute) && existsSync(absolute)) {
			if (!configWarned.has(absolute)) {
				configWarned.add(absolute);
				return {
					block: true,
					reason:
						`${basename(absolute)} is a quality-gate config. Fix the failing code rather than weakening the gate. ` +
						"If this change is genuinely required (and the user asked for it), repeat the edit — a deliberate retry is allowed.",
				};
			}
		}
		editedThisRun.add(absolute);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled() || checking || editedThisRun.size === 0) return;
		const cwd = (ctx as { cwd?: string }).cwd ?? process.cwd();
		const config = loadConfig(cwd);
		const files = [...editedThisRun];
		editedThisRun.clear();
		configWarned.clear();
		const findings: string[] = [];

		if (config.consoleWarn !== false) {
			for (const file of files) {
				try {
					if (hasDebugDebris(file, readFileSync(file, "utf-8"))) {
						findings.push(`debug debris: ${file} still contains console.log/debugger`);
					}
				} catch {
					// deleted or unreadable — nothing to check
				}
			}
		}

		const typecheck = resolveTypecheck(cwd, config);
		if (typecheck && files.some((file) => /\.(ts|tsx|mts|cts)$/.test(file))) {
			checking = true;
			const result = await new Promise<{ ok: boolean; out: string }>((resolve) => {
				execFile(
					typecheck.cmd,
					typecheck.args,
					{ cwd, timeout: TYPECHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
					(error, stdout, stderr) => resolve({ ok: !error, out: `${stdout ?? ""}${stderr ?? ""}`.trim() }),
				);
			});
			checking = false;
			if (!result.ok) {
				findings.push(`typecheck FAILED after this run's edits:\n${result.out.slice(0, MAX_REPORT_CHARS)}`);
			}
		}

		if (findings.length > 0) {
			pi.sendUserMessage(
				`<quality-gate>\n${findings.join("\n")}\n` +
					"Fix these before considering the task done (do not weaken configs to pass).\n</quality-gate>",
			);
		}
	});
}
