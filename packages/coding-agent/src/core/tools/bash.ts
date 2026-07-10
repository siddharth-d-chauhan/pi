import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { getBackgroundProcessRegistry, sanitizeLogLine } from "../background-process-registry.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Run the command detached in the background instead of blocking. Returns immediately with a background id and an output file path; the command keeps running, its output streams to that file (Read it to inspect progress) and to the background tasks panel, and you receive a task-notification when it finishes. Use for long-running or watch commands (dev servers, builds, tails). Do not poll.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Minimal structural view of the parent session used to deliver a
 * background-command completion notification to the model. `AgentSession`
 * satisfies this. Kept structural so the bash tool takes no hard dependency
 * on the session module.
 */
export interface BashBackgroundHost {
	sendCustomMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
	): Promise<unknown>;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Parent session used to notify the model when a `run_in_background`
	 * command completes. Optional: without it, background commands still run
	 * and appear in the background tasks panel, but no completion message is
	 * injected into the conversation.
	 */
	backgroundHost?: BashBackgroundHost;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

const BG_LABEL_MAX = 80;

function bgLabel(command: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length > BG_LABEL_MAX ? `${oneLine.slice(0, BG_LABEL_MAX - 1)}…` : oneLine;
}

// ── Background completion notifications ──────────────────────────────────────
// Mirrors the subagent background path (`queueBackgroundNotification`): a
// `<task-notification>` delivered on the next turn. Consecutive *completed*
// commands are collapsed into a single "N commands completed" message so a
// fan-out of background work doesn't flood the conversation; failed/cancelled
// commands are always surfaced individually.

interface PendingCompletion {
	registryId: string;
	label: string;
	status: "completed" | "failed" | "cancelled";
	exitCode: number | null;
	outputPath: string;
}

interface HostBatch {
	pending: PendingCompletion[];
	timer: NodeJS.Timeout | undefined;
}

const BG_NOTIFY_BATCH_MS = 200;
const activeBatches = new Map<BashBackgroundHost, HostBatch>();

/** Test helper: cancel any pending batch timers and clear batch state. */
export function resetBackgroundNotifierForTests(): void {
	for (const b of activeBatches.values()) if (b.timer) clearTimeout(b.timer);
	activeBatches.clear();
}

function sendSingleCompletion(host: BashBackgroundHost, it: PendingCompletion): void {
	const registry = getBackgroundProcessRegistry();
	const entry = registry.get(it.registryId);
	const tail = entry ? entry.log.slice(-10).join("\n") : "";
	const exitAttr = it.exitCode !== null ? ` exit="${it.exitCode}"` : "";
	const text =
		`<task-notification id="${it.registryId}" kind="shell" status="${it.status}"${exitAttr}>\n` +
		`$ ${it.label}\n` +
		(tail ? `--- last output ---\n${tail}\n` : "") +
		`full output: ${it.outputPath}\n` +
		"</task-notification>\n\n" +
		`Background command finished. Read ${it.outputPath} for full output if needed. Do not re-run or poll.`;
	host
		.sendCustomMessage(
			{
				customType: "task-notification",
				content: text,
				display: true,
				details: {
					registryId: it.registryId,
					kind: "shell",
					status: it.status,
					exitCode: it.exitCode,
					outputPath: it.outputPath,
				},
			},
			{ deliverAs: "nextTurn" },
		)
		.catch((err) => registry.appendLog(it.registryId, `[notification error: ${(err as Error).message}]`));
}

function flushBatch(host: BashBackgroundHost, batch: HostBatch): void {
	batch.timer = undefined;
	const items = batch.pending;
	batch.pending = [];
	if (items.length === 0) return;
	if (items.length === 1) {
		sendSingleCompletion(host, items[0]);
		return;
	}
	const lines = items.map((it) => {
		const code = it.exitCode !== null ? ` (exit ${it.exitCode})` : "";
		return `• $ ${it.label}${code} — ${it.outputPath}`;
	});
	const text =
		`<task-notification kind="shell" status="completed" count="${items.length}">\n` +
		`${items.length} background commands completed:\n${lines.join("\n")}\n` +
		"</task-notification>\n\n" +
		"Read any of the listed output files if needed. Do not re-run or poll.";
	host
		.sendCustomMessage(
			{
				customType: "task-notification",
				content: text,
				display: true,
				details: { kind: "shell", status: "completed", count: items.length, items },
			},
			{ deliverAs: "nextTurn" },
		)
		.catch(() => {});
}

function notifyBackgroundCompletion(params: {
	host: BashBackgroundHost | undefined;
	registryId: string;
	label: string;
	status: "completed" | "failed" | "cancelled";
	exitCode: number | null;
	outputPath: string;
}): void {
	const { host, ...rest } = params;
	if (!host) return;
	const item: PendingCompletion = rest;
	let batch = activeBatches.get(host);
	if (!batch) {
		batch = { pending: [], timer: undefined };
		activeBatches.set(host, batch);
	}
	// Non-success completions are always shown individually and immediately.
	// Flush any queued successes first so ordering is preserved.
	if (item.status !== "completed") {
		if (batch.timer) {
			clearTimeout(batch.timer);
			flushBatch(host, batch);
		}
		sendSingleCompletion(host, item);
		return;
	}
	batch.pending.push(item);
	if (!batch.timer) {
		batch.timer = setTimeout(() => flushBatch(host, batch as HostBatch), BG_NOTIFY_BATCH_MS);
		batch.timer.unref?.();
	}
}

// ── Stall detection ──────────────────────────────────────────────────────────
// A background command that stops producing output and whose last line looks
// like an interactive prompt is probably blocked waiting for input. We surface
// that once so the model can kill it and re-run with input piped in.

const STALL_IDLE_MS = 45_000;
const STALL_POLL_MS = 5_000;
const STALL_PROMPT_PATTERNS: RegExp[] = [
	/[?:]\s*$/,
	/\(y\/n\)\s*$/i,
	/\[y\/n\]\s*$/i,
	/password[^\n]*:\s*$/i,
	/press\s+(any\s+key|enter|return)/i,
	/continue\?\s*$/i,
	/›\s*$/,
	/\?\s*$/,
];

/** True if `tail` looks like a shell/program waiting for interactive input. */
export function looksLikePrompt(tail: string): boolean {
	const t = tail.trimEnd();
	if (!t) return false;
	return STALL_PROMPT_PATTERNS.some((re) => re.test(t));
}

function sendStallNotice(host: BashBackgroundHost, registryId: string, label: string): void {
	// Deliberately status-less: this is not a terminal event, so SDK consumers
	// must not treat it as completion.
	host
		.sendCustomMessage(
			{
				customType: "task-notification",
				content:
					`<task-notification id="${registryId}" kind="shell">\n` +
					`$ ${label}\n` +
					"appears to be waiting for interactive input (no output for 45s and the last line looks like a prompt). " +
					"Consider killing it and re-running with input piped in.\n" +
					"</task-notification>",
				display: true,
				details: { registryId, kind: "shell", stall: true },
			},
			{ deliverAs: "nextTurn" },
		)
		.catch(() => {});
}

export interface BackgroundLaunchResult {
	registryId: string;
	outputPath: string;
}

/**
 * Launch a command detached from the current turn. Registers it in the
 * BackgroundProcessRegistry (kind "shell") so it shows in the tasks panel with
 * a live output tail and a kill affordance, streams full output to a temp file
 * for later Read, and notifies the host session on completion. Returns
 * immediately.
 */
function launchBackgroundCommand(params: {
	ops: BashOperations;
	spawnContext: BashSpawnContext;
	displayCommand: string;
	timeout: number | undefined;
	host: BashBackgroundHost | undefined;
}): BackgroundLaunchResult {
	const { ops, spawnContext, displayCommand, timeout, host } = params;
	const registry = getBackgroundProcessRegistry();
	const output = new OutputAccumulator({ tempFilePrefix: "pi-bash-bg" });
	const outputPath = output.persist();
	const controller = new AbortController();
	const label = bgLabel(displayCommand);

	const registryId = registry.register({
		kind: "shell",
		label: `$ ${label}`,
		summary: outputPath,
		onKill: () => controller.abort(),
	});

	// Line-buffer raw output into the registry log (the human-facing live tail).
	let lineBuf = "";
	let lastLine = "";
	let lastGrowthAt = Date.now();
	let stallWarned = false;
	const decoder = new TextDecoder();
	const pumpLines = (flush: boolean): void => {
		let idx = lineBuf.indexOf("\n");
		while (idx !== -1) {
			const line = sanitizeLogLine(lineBuf.slice(0, idx));
			if (line) {
				registry.appendLog(registryId, line);
				lastLine = line;
			}
			lineBuf = lineBuf.slice(idx + 1);
			idx = lineBuf.indexOf("\n");
		}
		if (flush) {
			lineBuf += decoder.decode();
			const line = sanitizeLogLine(lineBuf);
			if (line) {
				registry.appendLog(registryId, line);
				lastLine = line;
			}
			lineBuf = "";
		}
	};

	const onData = (data: Buffer): void => {
		output.append(data);
		lastGrowthAt = Date.now();
		lineBuf += decoder.decode(data, { stream: true });
		pumpLines(false);
	};

	// Stall-watchdog: if output goes quiet and the visible tail looks like a
	// prompt, the command is likely blocked on interactive input.
	const watchdog = setInterval(() => {
		if (stallWarned || Date.now() - lastGrowthAt < STALL_IDLE_MS) return;
		const candidate = lineBuf.trim() ? sanitizeLogLine(lineBuf) : lastLine;
		if (!looksLikePrompt(candidate)) return;
		stallWarned = true;
		registry.appendLog(registryId, "[appears to be waiting for interactive input]");
		if (host) sendStallNotice(host, registryId, label);
	}, STALL_POLL_MS);
	watchdog.unref?.();

	void (async () => {
		let exitCode: number | null = null;
		let status: "completed" | "failed" | "cancelled" = "completed";
		let statusText = "completed";
		try {
			const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
				onData,
				signal: controller.signal,
				timeout,
				env: spawnContext.env,
			});
			exitCode = result.exitCode;
			if (controller.signal.aborted) {
				status = "cancelled";
				statusText = "killed";
			} else if (exitCode !== 0 && exitCode !== null) {
				status = "failed";
				statusText = `exited with code ${exitCode}`;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === "aborted" || controller.signal.aborted) {
				status = "cancelled";
				statusText = "killed";
			} else if (message.startsWith("timeout:")) {
				status = "failed";
				statusText = `timed out after ${message.split(":")[1]}s`;
			} else {
				status = "failed";
				statusText = message;
			}
		} finally {
			clearInterval(watchdog);
			output.finish();
			pumpLines(true);
			await output.closeTempFile().catch(() => {});
		}
		registry.appendLog(registryId, `[${statusText}]`);
		registry.setStatus(registryId, status);
		notifyBackgroundCompletion({ host, registryId, label, status, exitCode, outputPath });
	})();

	return { registryId, outputPath };
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Set run_in_background to launch long-running commands (dev servers, builds, watchers) detached: the call returns immediately with an output file path, the command keeps running, and you get a task-notification when it finishes.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout, run_in_background }: { command: string; timeout?: number; run_in_background?: boolean },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

			if (run_in_background) {
				const { registryId, outputPath } = launchBackgroundCommand({
					ops,
					spawnContext,
					displayCommand: command,
					timeout,
					host: options?.backgroundHost,
				});
				const text =
					`Background command started (id: ${registryId}).\n` +
					"It runs detached; this turn continues without waiting for it.\n" +
					`Output streams to: ${outputPath}\n` +
					"Read that file to inspect progress (it grows as the command runs). " +
					"You'll receive a task-notification when it finishes — do not poll.";
				return { content: [{ type: "text", text }], details: { fullOutputPath: outputPath } };
			}

			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
