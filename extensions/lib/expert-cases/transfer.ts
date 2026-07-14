import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EXPERT_TRANSFER_PROTOCOL_VERSION,
	EXPERT_TRANSFER_SCHEMA_VERSION,
	type ExpertTransferArm,
	type ExpertTransferAttempt,
	type ExpertTransferTaskInput,
	type ExpertTransferTaskSnapshot,
	type ExpertTransferValidation,
	expertHash,
} from "./contracts.ts";
import { searchExpertLearningClaims } from "./search.ts";
import { loadActiveExpertManifest, saveExpertTransferValidation } from "./store.ts";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_FIXTURE_FILES = 512;
const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_CHARS = 1_000_000;

export interface ExpertTransferExecution {
	model: { provider: string; id: string };
	toolCalls: string[];
	usedClaimIds: string[];
	metrics: {
		completed: boolean;
		qualityScore: number;
		hardGates: Record<string, boolean>;
		latencyMs: number;
		tokens?: number;
		costUsd?: number;
	};
	assistantText: string;
	judgeOutput: string;
}

export interface ExpertTransferExecutorInput {
	cwd: string;
	arm: ExpertTransferArm;
	task: ExpertTransferTaskInput;
	taskSnapshot: ExpertTransferTaskSnapshot;
	claimIds: string[];
	attemptDir: string;
}

export type ExpertTransferExecutor = (input: ExpertTransferExecutorInput) => Promise<ExpertTransferExecution>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedAppend(current: string, value: string): string {
	const next = current + value;
	return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function redact(value: string): string {
	return value
		.replace(/(authorization["'\s:=]+(?:bearer|basic)\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(/((?:token|password|secret|api[_-]?key)["'\s:=]+)[^\s"']+/gi, "$1[redacted]");
}

function hashFixture(directory: string): string {
	const entries: Array<{ path: string; hash: string; bytes: number }> = [];
	let bytes = 0;
	const visit = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const path = join(current, entry.name);
			const relativePath = relative(directory, path);
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) throw new Error(`transfer fixture contains a symbolic link: ${relativePath}`);
			if (stat.isDirectory()) {
				visit(path);
				continue;
			}
			if (!stat.isFile()) throw new Error(`transfer fixture contains an unsupported entry: ${relativePath}`);
			bytes += stat.size;
			if (entries.length >= MAX_FIXTURE_FILES || bytes > MAX_FIXTURE_BYTES) {
				throw new Error("transfer fixture exceeds the file or byte limit");
			}
			entries.push({ path: relativePath, hash: hashFile(path), bytes: stat.size });
		}
	};
	visit(directory);
	return expertHash(entries);
}

function hashJudgeCommand(command: string[]): string {
	const files = command.flatMap((part) => {
		if (!isAbsolute(part) || !existsSync(part) || !lstatSync(part).isFile()) return [];
		return [{ path: part, hash: hashFile(part) }];
	});
	return expertHash({ command, files });
}

function validateTask(cwd: string, task: ExpertTransferTaskInput, claimIds: string[]): ExpertTransferTaskSnapshot {
	if (!/^[a-z0-9][a-z0-9_-]{2,80}$/.test(task.taskId)) throw new Error("transfer task has an invalid taskId");
	if (!task.goal.trim() || !task.query.trim()) throw new Error("transfer task requires a goal and query");
	if (task.judgeCommand.length === 0 || task.judgeCommand.some((part) => !part.trim())) {
		throw new Error("transfer task requires a valid judge command");
	}
	if (task.hardGates.length === 0 || new Set(task.hardGates).size !== task.hardGates.length) {
		throw new Error("transfer task requires unique hard gates");
	}
	const fixtureDir = isAbsolute(task.fixtureDir) ? task.fixtureDir : resolve(cwd, task.fixtureDir);
	if (!existsSync(fixtureDir) || !lstatSync(fixtureDir).isDirectory()) {
		throw new Error(`transfer fixture does not exist: ${fixtureDir}`);
	}
	const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
		throw new Error("transfer timeout must be 10-600 seconds");
	}
	const core = {
		protocolVersion: EXPERT_TRANSFER_PROTOCOL_VERSION,
		taskId: task.taskId,
		goal: task.goal.trim(),
		query: task.query.trim(),
		fixtureHash: hashFixture(fixtureDir),
		judgeCommand: task.judgeCommand,
		judgeHash: hashJudgeCommand(task.judgeCommand),
		hardGates: [...task.hardGates].sort(),
		expectedClaimIds: [...claimIds].sort(),
		timeoutMs,
	};
	return { ...core, contentHash: expertHash(core) };
}

function defaultPiCliPath(): string {
	const configured = process.env.PI_EXPERT_RPC_CLI;
	if (configured) return configured;
	const localCliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/coding-agent/dist/cli.js");
	const resolvedEntry =
		typeof import.meta.resolve === "function"
			? fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))
			: undefined;
	const cliPath = resolvedEntry
		? resolvedEntry.endsWith(".ts")
			? join(dirname(resolvedEntry), "..", "dist", "cli.js")
			: join(dirname(resolvedEntry), "cli.js")
		: localCliPath;
	if (!existsSync(cliPath)) throw new Error(`Pi RPC CLI not found: ${cliPath}`);
	return cliPath;
}

function expertExtensionPath(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../expert-cases.ts");
}

interface PiExecution {
	model: { provider: string; id: string };
	toolCalls: string[];
	usedClaimIds: string[];
	assistantText: string;
	tokens?: number;
	costUsd?: number;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runPi(input: ExpertTransferExecutorInput): Promise<PiExecution> {
	const provider = process.env.PI_EXPERT_TRANSFER_PROVIDER ?? "minimax";
	const modelId = process.env.PI_EXPERT_TRANSFER_MODEL ?? "MiniMax-M3";
	const arguments_ = [
		process.execPath,
		defaultPiCliPath(),
		"--mode",
		"rpc",
		"--provider",
		provider,
		"--model",
		modelId,
		"--no-session",
		"--no-extensions",
		...(input.arm === "learned" ? ["--extension", expertExtensionPath()] : []),
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--tools",
		input.arm === "learned" ? "read,edit,write,expert_cases_search" : "read,edit,write",
		"--thinking",
		"low",
		"--approve",
	];
	const command = `stty -echo -icanon; exec ${arguments_.map(quote).join(" ")}`;
	const child = spawn(process.env.PI_EXPERT_RPC_PTY ?? "script", ["-qefc", command, "/dev/null"], {
		cwd: input.attemptDir,
		env: {
			...process.env,
			PI_EXPERT_AUTO_CONTEXT: "0",
			PI_EXPERT_CASES_CWD: input.cwd,
			TMPDIR: tmpdir(),
			TEMP: tmpdir(),
			TMP: tmpdir(),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const { stdin, stdout, stderr } = child;
	if (!stdin || !stdout || !stderr) {
		child.kill("SIGTERM");
		return Promise.reject(new Error("Pi transfer RPC did not create JSONL streams"));
	}
	return new Promise((resolveExecution, reject) => {
		let buffer = "";
		let stderrText = "";
		let model = { provider: "unknown", id: "unknown" };
		const toolCalls: string[] = [];
		const usedClaimIds = new Set<string>();
		let assistantText = "";
		let tokens: number | undefined;
		let costUsd: number | undefined;
		let settled = false;
		const timer = setTimeout(() => finish(new Error("Pi transfer RPC timed out")), input.taskSnapshot.timeoutMs);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			if (error) reject(error);
			else
				resolveExecution({
					model,
					toolCalls,
					usedClaimIds: [...usedClaimIds].sort(),
					assistantText,
					tokens,
					costUsd,
				});
		};
		const prompt = [
			"Unseen transfer evaluation. Work only inside the current directory and do not inspect parent or external paths.",
			input.task.goal,
			`The behavior-oriented retrieval query for this task is ${JSON.stringify(input.task.query)}. This same query is disclosed to both evaluation arms.`,
			input.arm === "learned"
				? "Before editing, call expert_cases_search exactly once with that query. Use the returned evidence as a hypothesis, then implement the task."
				: "No historical expert tool is available. Implement using only the task and files in the current directory.",
			"You may use read, edit, and write. Do not merely explain: complete the implementation, then answer briefly.",
		].join("\n");
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				return;
			}
			if (!isRecord(value)) return;
			if (value.type === "response" && value.id === "transfer-state") {
				const data = isRecord(value.data) ? value.data : undefined;
				const selected = data && isRecord(data.model) ? data.model : undefined;
				if (typeof selected?.provider !== "string" || typeof selected.id !== "string") {
					finish(new Error("Pi transfer RPC did not report a model"));
					return;
				}
				model = { provider: selected.provider, id: selected.id };
				stdin.write(`${JSON.stringify({ id: "transfer-prompt", type: "prompt", message: prompt })}\n`);
			}
			if (value.type === "message_end" && isRecord(value.message)) {
				const message = value.message;
				const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
				if (message.role === "assistant") {
					for (const part of content) {
						if (part.type === "toolCall" && typeof part.name === "string") toolCalls.push(part.name);
					}
					assistantText = content
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => String(part.text))
						.join("");
					const usage = isRecord(message.usage) ? message.usage : undefined;
					if (typeof usage?.totalTokens === "number") tokens = usage.totalTokens;
					const cost = usage && isRecord(usage.cost) ? usage.cost : undefined;
					if (typeof cost?.total === "number") costUsd = cost.total;
				}
				if (message.role === "toolResult" && message.toolName === "expert_cases_search") {
					const text = content
						.filter((part) => part.type === "text" && typeof part.text === "string")
						.map((part) => String(part.text))
						.join("");
					for (const claimId of text.match(/claim-[a-f0-9]{24}/g) ?? []) usedClaimIds.add(claimId);
				}
			}
			if (value.type === "agent_settled") finish();
		};
		stdout.on("data", (chunk: Buffer) => {
			buffer = boundedAppend(buffer, chunk.toString("utf-8"));
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
		});
		stderr.on("data", (chunk: Buffer) => {
			stderrText = boundedAppend(stderrText, chunk.toString("utf-8"));
		});
		child.once("error", (error) => finish(error));
		child.once("exit", (code, signal) => {
			finish(
				new Error(
					`Pi transfer RPC exited before settling (code=${code} signal=${signal}): ${redact(stderrText.slice(-500))}`,
				),
			);
		});
		stdin.write(`${JSON.stringify({ id: "transfer-state", type: "get_state" })}\n`);
	});
}

function runJudge(
	input: ExpertTransferExecutorInput,
): Promise<{ output: string; completed: boolean; qualityScore: number; hardGates: Record<string, boolean> }> {
	const [executable, ...arguments_] = input.task.judgeCommand;
	if (!executable) return Promise.reject(new Error("transfer judge command is empty"));
	return new Promise((resolveJudge, reject) => {
		const child = spawn(executable, arguments_, { cwd: input.attemptDir, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = boundedAppend(stdout, chunk.toString("utf-8"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = boundedAppend(stderr, chunk.toString("utf-8"));
		});
		let settled = false;
		const timer = setTimeout(() => finish(new Error("transfer judge timed out")), input.taskSnapshot.timeoutMs);
		const finish = (
			error?: Error,
			result?: { output: string; completed: boolean; qualityScore: number; hardGates: Record<string, boolean> },
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				child.kill("SIGTERM");
				reject(error);
			} else if (result) resolveJudge(result);
		};
		child.once("error", (error) => finish(error));
		child.once("close", (code) => {
			if (code !== 0) {
				finish(new Error(`transfer judge exited ${code}: ${redact(stderr.slice(-500))}`));
				return;
			}
			const line = stdout
				.split("\n")
				.map((entry) => entry.trim())
				.filter(Boolean)
				.at(-1);
			if (!line) {
				finish(new Error("transfer judge emitted no result"));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				finish(new Error("transfer judge result is not JSON"));
				return;
			}
			if (
				!isRecord(parsed) ||
				typeof parsed.completed !== "boolean" ||
				typeof parsed.qualityScore !== "number" ||
				!isRecord(parsed.hardGates)
			) {
				finish(new Error("transfer judge result has an invalid shape"));
				return;
			}
			if (!Number.isFinite(parsed.qualityScore) || parsed.qualityScore < 0 || parsed.qualityScore > 1) {
				finish(new Error("transfer judge qualityScore must be between 0 and 1"));
				return;
			}
			const hardGates: Record<string, boolean> = {};
			for (const gate of input.taskSnapshot.hardGates) {
				if (typeof parsed.hardGates[gate] !== "boolean") {
					finish(new Error(`transfer judge omitted hard gate '${gate}'`));
					return;
				}
				hardGates[gate] = parsed.hardGates[gate] as boolean;
			}
			finish(undefined, {
				output: stdout,
				completed: parsed.completed,
				qualityScore: parsed.qualityScore,
				hardGates,
			});
		});
	});
}

export const defaultExpertTransferExecutor: ExpertTransferExecutor = async (input) => {
	const fixtureDir = isAbsolute(input.task.fixtureDir)
		? input.task.fixtureDir
		: resolve(input.cwd, input.task.fixtureDir);
	cpSync(fixtureDir, input.attemptDir, { recursive: true });
	const started = Date.now();
	const pi = await runPi(input);
	const judge = await runJudge(input);
	return {
		model: pi.model,
		toolCalls: pi.toolCalls,
		usedClaimIds: pi.usedClaimIds,
		metrics: {
			completed: judge.completed,
			qualityScore: judge.qualityScore,
			hardGates: judge.hardGates,
			latencyMs: Date.now() - started,
			tokens: pi.tokens,
			costUsd: pi.costUsd,
		},
		assistantText: pi.assistantText,
		judgeOutput: judge.output,
	};
};

async function executeAttempt(
	input: ExpertTransferExecutorInput,
	executor: ExpertTransferExecutor,
): Promise<ExpertTransferAttempt> {
	const startedAt = new Date().toISOString();
	try {
		const execution = await executor(input);
		return {
			arm: input.arm,
			startedAt,
			finishedAt: new Date().toISOString(),
			model: execution.model,
			toolCalls: execution.toolCalls,
			usedClaimIds: execution.usedClaimIds,
			metrics: execution.metrics,
			assistantHash: expertHash(execution.assistantText),
			judgeOutputHash: expertHash(execution.judgeOutput),
		};
	} catch (error) {
		return {
			arm: input.arm,
			startedAt,
			finishedAt: new Date().toISOString(),
			model: { provider: "unknown", id: "unknown" },
			toolCalls: [],
			usedClaimIds: [],
			metrics: {
				completed: false,
				qualityScore: 0,
				hardGates: Object.fromEntries(input.taskSnapshot.hardGates.map((gate) => [gate, false])),
				latencyMs: 0,
			},
			assistantHash: expertHash(""),
			judgeOutputHash: expertHash(""),
			error: redact((error as Error).message),
		};
	}
}

export async function runExpertTransferEvaluation(options: {
	cwd: string;
	task: ExpertTransferTaskInput;
	executor?: ExpertTransferExecutor;
	createdAt?: string;
}): Promise<ExpertTransferValidation> {
	const manifest = loadActiveExpertManifest(options.cwd);
	if (!manifest) throw new Error("no active expert-case manifest");
	const matching = searchExpertLearningClaims(options.cwd, options.task.query, 20);
	const claimIds = options.task.expectedClaimIds?.length
		? [...new Set(options.task.expectedClaimIds)].sort()
		: matching.slice(0, 1).map((claim) => claim.claimId);
	if (claimIds.length === 0) throw new Error("transfer task matched no active semantic claim");
	const byId = new Map(
		matching.flatMap((claim) => claim.equivalentClaimIds.map((claimId) => [claimId, claim] as const)),
	);
	for (const claimId of claimIds) {
		if (!byId.has(claimId)) throw new Error(`transfer task expected an unmatched or inactive claim: ${claimId}`);
	}
	const sourceTicketKeys = [...new Set(claimIds.flatMap((claimId) => byId.get(claimId)?.ticketKeys ?? []))].sort();
	const taskText = `${options.task.goal}\n${options.task.query}`.toUpperCase();
	const leaked = sourceTicketKeys.filter((ticketKey) => taskText.includes(ticketKey.toUpperCase()));
	if (leaked.length > 0) throw new Error(`transfer task is not unseen; it names source tickets: ${leaked.join(", ")}`);
	const task = validateTask(options.cwd, options.task, claimIds);
	const workRoot = mkdtempSync(join(tmpdir(), "pi-expert-transfer-"));
	const executor = options.executor ?? defaultExpertTransferExecutor;
	const [control, learned] = await Promise.all(
		(["control", "learned"] as const).map((arm) =>
			executeAttempt(
				{
					cwd: options.cwd,
					arm,
					task: options.task,
					taskSnapshot: task,
					claimIds,
					attemptDir: join(workRoot, arm),
				},
				executor,
			),
		),
	);
	const reasons: string[] = [];
	if (control.model.provider !== learned.model.provider || control.model.id !== learned.model.id) {
		reasons.push("control and learned arms used different models");
	}
	if (!learned.metrics.completed) reasons.push("learned arm did not complete the unseen task");
	for (const gate of task.hardGates) {
		if (!learned.metrics.hardGates[gate]) reasons.push(`learned arm failed hard gate '${gate}'`);
	}
	if (learned.toolCalls.filter((tool) => tool === "expert_cases_search").length !== 1) {
		reasons.push("learned arm did not call expert_cases_search exactly once");
	}
	for (const claimId of claimIds) {
		if (!learned.usedClaimIds.includes(claimId)) reasons.push(`learned arm did not consume claim ${claimId}`);
	}
	if (control.toolCalls.includes("expert_cases_search")) reasons.push("control arm accessed expert knowledge");
	if (learned.metrics.qualityScore <= control.metrics.qualityScore) {
		reasons.push("learned arm did not improve hidden quality over control");
	}
	const createdAt = options.createdAt ?? new Date().toISOString();
	const identityCore = {
		schemaVersion: EXPERT_TRANSFER_SCHEMA_VERSION,
		createdAt,
		sourceManifestId: manifest.manifestId,
		sourceManifestHash: manifest.contentHash,
		task,
		claimIds,
		sourceTicketKeys,
		attempts: [control, learned],
		decision: reasons.length === 0 ? ("transfer_validated" as const) : ("rejected" as const),
		reasons,
	};
	const validationId = `transfer-${expertHash(identityCore).slice(0, 24)}`;
	const core = { ...identityCore, validationId };
	return saveExpertTransferValidation(options.cwd, { ...core, contentHash: expertHash(core) });
}
