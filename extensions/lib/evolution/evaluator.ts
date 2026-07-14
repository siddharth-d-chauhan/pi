import { spawn } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AggregateMetrics,
	type AttemptMetrics,
	type AttemptOutcome,
	type DecisionRecord,
	EVOLUTION_SCHEMA_VERSION,
	type EvaluationArm,
	type EvolutionTask,
	type ExperimentManifest,
	type HarnessSnapshot,
	hashValue,
	type MutationManifest,
	newRecordId,
	type PairedComparison,
	type RunAttempt,
	type TaskManifest,
} from "./contracts.ts";
import { evolutionRoot, saveAttempt, saveAttemptArtifact } from "./store.ts";

const MAX_CAPTURE_CHARS = 1_000_000;
const UNBOUNDED_RATIO = 1_000_000_000;

class CommandExecutionError extends Error {
	readonly stdout: string;
	readonly stderr: string;

	constructor(message: string, stdout: string, stderr: string) {
		super(message);
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export interface AttemptExecution {
	metrics: AttemptMetrics;
	stdout?: string;
	stderr?: string;
}

export interface AttemptExecutorInput {
	cwd: string;
	experiment: ExperimentManifest;
	mutation: MutationManifest;
	task: EvolutionTask;
	arm: EvaluationArm;
	sample: number;
	snapshot: HarnessSnapshot;
	attemptId: string;
	signal: AbortSignal;
}

export type AttemptExecutor = (input: AttemptExecutorInput) => Promise<AttemptExecution>;

function boundedAppend(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

function validateMetrics(value: unknown, hardGates: string[]): AttemptMetrics {
	if (!value || typeof value !== "object") throw new Error("runner result must be an object");
	const metrics = value as Partial<AttemptMetrics>;
	for (const field of ["qualityScore", "criteriaPassRate", "rounds", "rejections", "latencyMs"] as const) {
		if (typeof metrics[field] !== "number" || !Number.isFinite(metrics[field])) {
			throw new Error(`runner result has invalid ${field}`);
		}
	}
	if (typeof metrics.completed !== "boolean") throw new Error("runner result has invalid completed");
	if (!Number.isInteger(metrics.rounds) || (metrics.rounds ?? -1) < 0) {
		throw new Error("runner result has invalid rounds");
	}
	if (!Number.isInteger(metrics.rejections) || (metrics.rejections ?? -1) < 0) {
		throw new Error("runner result has invalid rejections");
	}
	if ((metrics.latencyMs ?? -1) < 0) throw new Error("runner result has invalid latencyMs");
	if (metrics.tokens !== undefined && (!Number.isFinite(metrics.tokens) || metrics.tokens < 0)) {
		throw new Error("runner result has invalid tokens");
	}
	if (metrics.costUsd !== undefined && (!Number.isFinite(metrics.costUsd) || metrics.costUsd < 0)) {
		throw new Error("runner result has invalid costUsd");
	}
	if (!metrics.hardGates || typeof metrics.hardGates !== "object") {
		throw new Error("runner result has invalid hardGates");
	}
	for (const gate of hardGates) {
		if (typeof metrics.hardGates[gate] !== "boolean") throw new Error(`runner result omitted hard gate '${gate}'`);
	}
	if ((metrics.criteriaPassRate ?? 0) < 0 || (metrics.criteriaPassRate ?? 0) > 1) {
		throw new Error("runner criteriaPassRate must be between 0 and 1");
	}
	return metrics as AttemptMetrics;
}

function parseMetricsOutput(stdout: string, hardGates: string[]): AttemptMetrics {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const line = lines.at(-1);
	if (!line) throw new Error("runner emitted no metrics JSON");
	try {
		return validateMetrics(JSON.parse(line), hardGates);
	} catch (error) {
		throw new Error(
			`runner final line is not valid metrics JSON: ${(error as Error).message}; line=${JSON.stringify(line.slice(-500))}`,
		);
	}
}

/**
 * Execute a task command in an isolated copy of its fixture. The command must
 * print an AttemptMetrics JSON object as its final non-empty stdout line.
 */
export function commandAttemptExecutor(input: AttemptExecutorInput): Promise<AttemptExecution> {
	const fixture = isAbsolute(input.task.fixtureDir)
		? input.task.fixtureDir
		: resolve(input.cwd, input.task.fixtureDir);
	const attemptDir = join(
		evolutionRoot(input.cwd),
		"experiments",
		input.experiment.experimentId,
		"work",
		input.attemptId,
	);
	mkdirSync(attemptDir, { recursive: true });
	cpSync(fixture, attemptDir, { recursive: true });
	const [executable, ...args] = input.task.command;
	if (!executable) return Promise.reject(new Error(`task '${input.task.taskId}' has an empty command`));

	return new Promise((resolveExecution, reject) => {
		const child = spawn(executable, args, {
			cwd: attemptDir,
			env: {
				...process.env,
				...input.task.env,
				PI_EVOLUTION_ARM: input.arm,
				PI_EVOLUTION_ATTEMPT_ID: input.attemptId,
				PI_EVOLUTION_TASK_ID: input.task.taskId,
				PI_EVOLUTION_TASK_GOAL: input.task.goal,
				PI_EVOLUTION_SAMPLE: String(input.sample),
				PI_EVOLUTION_SNAPSHOT_ID: input.snapshot.snapshotId,
				PI_EVOLUTION_PROMPT_VERSION: String(input.snapshot.promptVersion),
				PI_EVOLUTION_PROMPT_STEPS_JSON: JSON.stringify(input.snapshot.steps),
				...(input.experiment.model ? { PI_EVOLUTION_MODEL: input.experiment.model } : {}),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const abort = () => child.kill("SIGKILL");
		input.signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = boundedAppend(stdout, chunk.toString());
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = boundedAppend(stderr, chunk.toString());
		});
		child.on("error", (error) => {
			input.signal.removeEventListener("abort", abort);
			reject(error);
		});
		child.on("close", (code) => {
			input.signal.removeEventListener("abort", abort);
			if (input.signal.aborted) {
				reject(new CommandExecutionError("attempt timed out", stdout, stderr));
				return;
			}
			if (code !== 0) {
				reject(new CommandExecutionError(`runner exited ${code}: ${stderr.trim().slice(-500)}`, stdout, stderr));
				return;
			}
			try {
				const metrics = parseMetricsOutput(stdout, input.task.hardGates);
				resolveExecution({ metrics, stdout, stderr });
			} catch (error) {
				reject(new CommandExecutionError((error as Error).message, stdout, stderr));
			}
		});
	});
}

function failedMetrics(task: EvolutionTask, latencyMs: number): AttemptMetrics {
	return {
		completed: false,
		qualityScore: 0,
		criteriaPassRate: 0,
		rounds: 0,
		rejections: 0,
		latencyMs,
		hardGates: Object.fromEntries(task.hardGates.map((gate) => [gate, false])),
	};
}

async function runAttempt(
	cwd: string,
	experiment: ExperimentManifest,
	mutation: MutationManifest,
	task: EvolutionTask,
	arm: EvaluationArm,
	sample: number,
	snapshot: HarnessSnapshot,
	executor: AttemptExecutor,
): Promise<RunAttempt> {
	const attemptId = newRecordId("attempt");
	const startedAt = new Date().toISOString();
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), experiment.budgets.attemptTimeoutMs);
	let outcome: AttemptOutcome = "completed";
	let metrics: AttemptMetrics;
	let error: string | undefined;
	const artifactRefs: string[] = [];
	try {
		const execution = executor({
			cwd,
			experiment,
			mutation,
			task,
			arm,
			sample,
			snapshot,
			attemptId,
			signal: controller.signal,
		});
		const timedOut = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("attempt timed out")), { once: true });
		});
		const result = await Promise.race([execution, timedOut]);
		metrics = {
			...validateMetrics(result.metrics, task.hardGates),
			wallLatencyMs: Math.max(1, Date.now() - started),
		};
		if (result.stdout)
			artifactRefs.push(saveAttemptArtifact(cwd, experiment.experimentId, attemptId, "stdout", result.stdout));
		if (result.stderr)
			artifactRefs.push(saveAttemptArtifact(cwd, experiment.experimentId, attemptId, "stderr", result.stderr));
		if (
			(experiment.budgets.maxTokensPerAttempt !== undefined &&
				(metrics.tokens === undefined || metrics.tokens > experiment.budgets.maxTokensPerAttempt)) ||
			(experiment.budgets.maxCostUsdPerAttempt !== undefined &&
				(metrics.costUsd === undefined || metrics.costUsd > experiment.budgets.maxCostUsdPerAttempt))
		) {
			outcome = "budget_exceeded";
		}
	} catch (caught) {
		outcome = controller.signal.aborted ? "timed_out" : "invalid_result";
		error = (caught as Error).message;
		if (caught instanceof CommandExecutionError) {
			if (caught.stdout) {
				artifactRefs.push(saveAttemptArtifact(cwd, experiment.experimentId, attemptId, "stdout", caught.stdout));
			}
			if (caught.stderr) {
				artifactRefs.push(saveAttemptArtifact(cwd, experiment.experimentId, attemptId, "stderr", caught.stderr));
			}
		}
		metrics = failedMetrics(task, Date.now() - started);
	} finally {
		clearTimeout(timer);
	}
	const attempt: RunAttempt = {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		attemptId,
		experimentId: experiment.experimentId,
		mutationId: mutation.mutationId,
		arm,
		taskId: task.taskId,
		split: task.split,
		sample,
		snapshotId: snapshot.snapshotId,
		startedAt,
		finishedAt: new Date().toISOString(),
		outcome,
		metrics,
		artifactRefs,
		error,
	};
	saveAttempt(cwd, attempt);
	return attempt;
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregate(attempts: RunAttempt[]): AggregateMetrics {
	return {
		attempts: attempts.length,
		completionRate: mean(
			attempts.map((attempt) => Number(attempt.metrics.completed && attempt.outcome === "completed")),
		),
		meanQualityScore: mean(attempts.map((attempt) => attempt.metrics.qualityScore)),
		meanCriteriaPassRate: mean(attempts.map((attempt) => attempt.metrics.criteriaPassRate)),
		meanRounds: mean(attempts.map((attempt) => attempt.metrics.rounds)),
		meanRejections: mean(attempts.map((attempt) => attempt.metrics.rejections)),
		meanLatencyMs: mean(
			attempts.map((attempt) => Math.max(attempt.metrics.latencyMs, attempt.metrics.wallLatencyMs ?? 0)),
		),
		meanTokens: mean(attempts.map((attempt) => attempt.metrics.tokens ?? 0)),
		meanCostUsd: mean(attempts.map((attempt) => attempt.metrics.costUsd ?? 0)),
		hardGateFailures: attempts.reduce(
			(sum, attempt) => sum + Object.values(attempt.metrics.hardGates).filter((passed) => !passed).length,
			0,
		),
	};
}

function ratio(candidate: number, baseline: number): number {
	if (baseline === 0) return candidate === 0 ? 1 : UNBOUNDED_RATIO;
	return candidate / baseline;
}

function compare(attempts: RunAttempt[]): PairedComparison {
	const baselineAttempts = attempts.filter((attempt) => attempt.arm === "baseline");
	const candidateAttempts = attempts.filter((attempt) => attempt.arm === "candidate");
	const baseline = aggregate(baselineAttempts);
	const candidate = aggregate(candidateAttempts);
	const byPair = new Map(baselineAttempts.map((attempt) => [`${attempt.taskId}:${attempt.sample}`, attempt] as const));
	const hardGateRegressions: PairedComparison["hardGateRegressions"] = [];
	for (const candidateAttempt of candidateAttempts) {
		const baselineAttempt = byPair.get(`${candidateAttempt.taskId}:${candidateAttempt.sample}`);
		if (!baselineAttempt) continue;
		for (const [gate, passed] of Object.entries(baselineAttempt.metrics.hardGates)) {
			if (passed && candidateAttempt.metrics.hardGates[gate] !== true) {
				hardGateRegressions.push({ taskId: candidateAttempt.taskId, sample: candidateAttempt.sample, gate });
			}
		}
	}
	const bySplit = Object.fromEntries(
		(["validation", "held_out", "replay", "ood"] as const).map((split) => {
			const splitBaseline = aggregate(baselineAttempts.filter((attempt) => attempt.split === split));
			const splitCandidate = aggregate(candidateAttempts.filter((attempt) => attempt.split === split));
			return [
				split,
				{
					baseline: splitBaseline,
					candidate: splitCandidate,
					deltas: {
						completionRate: splitCandidate.completionRate - splitBaseline.completionRate,
						qualityScore: splitCandidate.meanQualityScore - splitBaseline.meanQualityScore,
						criteriaPassRate: splitCandidate.meanCriteriaPassRate - splitBaseline.meanCriteriaPassRate,
					},
				},
			];
		}),
	) as PairedComparison["bySplit"];
	return {
		baseline,
		candidate,
		deltas: {
			completionRate: candidate.completionRate - baseline.completionRate,
			qualityScore: candidate.meanQualityScore - baseline.meanQualityScore,
			criteriaPassRate: candidate.meanCriteriaPassRate - baseline.meanCriteriaPassRate,
		},
		ratios: {
			latency: ratio(candidate.meanLatencyMs, baseline.meanLatencyMs),
			tokens: ratio(candidate.meanTokens, baseline.meanTokens),
			cost: ratio(candidate.meanCostUsd, baseline.meanCostUsd),
		},
		hardGateRegressions,
		bySplit,
	};
}

function decide(
	experiment: ExperimentManifest,
	mutation: MutationManifest,
	comparison: PairedComparison,
	attempts: RunAttempt[],
): DecisionRecord {
	const reasons: string[] = [];
	const { thresholds } = experiment;
	if (attempts.some((attempt) => attempt.arm === "candidate" && attempt.outcome !== "completed")) {
		reasons.push("candidate has non-completed attempt outcomes");
	}
	if (comparison.candidate.hardGateFailures > 0) reasons.push("candidate has hard-gate failures");
	if (thresholds.requireNoHardGateRegression && comparison.hardGateRegressions.length > 0) {
		reasons.push("candidate regressed a hard gate that passed on the baseline");
	}
	if (comparison.deltas.completionRate < thresholds.minCompletionRateDelta) {
		reasons.push("completion-rate delta is below the declared threshold");
	}
	if (comparison.deltas.qualityScore < thresholds.minQualityScoreDelta) {
		reasons.push("quality-score delta is below the declared threshold");
	}
	for (const [split, threshold] of Object.entries(thresholds.minQualityScoreDeltaBySplit)) {
		const delta = comparison.bySplit[split as keyof typeof comparison.bySplit].deltas.qualityScore;
		if (threshold !== undefined && delta < threshold) {
			reasons.push(`${split} quality-score delta is below the declared threshold`);
		}
	}
	if (comparison.ratios.latency > thresholds.maxLatencyRatio) reasons.push("latency ratio exceeds the declared limit");
	if (comparison.ratios.tokens > thresholds.maxTokenRatio) reasons.push("token ratio exceeds the declared limit");
	if (comparison.ratios.cost > thresholds.maxCostRatio) reasons.push("cost ratio exceeds the declared limit");
	return {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		decisionId: newRecordId("decision"),
		experimentId: experiment.experimentId,
		mutationId: mutation.mutationId,
		createdAt: new Date().toISOString(),
		decision: reasons.length === 0 ? "promote" : "reject",
		reasons,
		comparison,
		thresholds,
		rollbackTarget: mutation.rollbackTarget,
	};
}

function validateExperiment(
	experiment: ExperimentManifest,
	mutation: MutationManifest,
	tasks: TaskManifest,
	baseline: HarnessSnapshot,
	candidate: HarnessSnapshot,
): void {
	if (experiment.mutationId !== mutation.mutationId) throw new Error("experiment mutation mismatch");
	if (experiment.taskManifestId !== tasks.manifestId || experiment.taskManifestHash !== tasks.contentHash) {
		throw new Error("experiment task manifest mismatch");
	}
	if (mutation.taskManifestId !== tasks.manifestId || mutation.taskManifestHash !== tasks.contentHash) {
		throw new Error("mutation was not proposed against this frozen task manifest");
	}
	if (Date.parse(tasks.frozenAt) > Date.parse(mutation.createdAt)) {
		throw new Error("evaluation task manifest was frozen after the mutation was proposed");
	}
	if (
		experiment.baselineSnapshotId !== baseline.snapshotId ||
		experiment.candidateSnapshotId !== candidate.snapshotId
	) {
		throw new Error("experiment snapshot mismatch");
	}
	if (mutation.parentSnapshotId !== baseline.snapshotId || mutation.candidateSnapshotId !== candidate.snapshotId) {
		throw new Error("mutation snapshot mismatch");
	}
	if (hashValue({ tasks: tasks.tasks }) !== tasks.contentHash) throw new Error("task manifest content hash mismatch");
	for (const split of ["validation", "held_out", "replay", "ood"] as const) {
		if (!tasks.tasks.some((task) => task.split === split)) throw new Error(`task manifest has no ${split} task`);
	}
	if (experiment.samplesPerTask < 1) throw new Error("samplesPerTask must be positive");
}

/** Run parent and candidate concurrently for every task/sample pair. */
export async function runPairedExperiment(options: {
	cwd: string;
	experiment: ExperimentManifest;
	mutation: MutationManifest;
	tasks: TaskManifest;
	baseline: HarnessSnapshot;
	candidate: HarnessSnapshot;
	executor?: AttemptExecutor;
}): Promise<{ attempts: RunAttempt[]; decision: DecisionRecord }> {
	validateExperiment(options.experiment, options.mutation, options.tasks, options.baseline, options.candidate);
	const attempts: RunAttempt[] = [];
	const executor = options.executor ?? commandAttemptExecutor;
	for (const task of options.tasks.tasks) {
		for (let sample = 1; sample <= options.experiment.samplesPerTask; sample += 1) {
			const pair = await Promise.all([
				runAttempt(
					options.cwd,
					options.experiment,
					options.mutation,
					task,
					"baseline",
					sample,
					options.baseline,
					executor,
				),
				runAttempt(
					options.cwd,
					options.experiment,
					options.mutation,
					task,
					"candidate",
					sample,
					options.candidate,
					executor,
				),
			]);
			attempts.push(...pair);
		}
	}
	return { attempts, decision: decide(options.experiment, options.mutation, compare(attempts), attempts) };
}
