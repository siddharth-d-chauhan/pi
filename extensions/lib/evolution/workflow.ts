import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BaselineStep, Proposal, RunRecord } from "../loop-optimizer.ts";
import {
	createSnapshot,
	createTaskManifest,
	type DecisionRecord,
	EVOLUTION_SCHEMA_VERSION,
	type EvolutionTask,
	type ExperimentManifest,
	hashValue,
	type MutationManifest,
	newRecordId,
	type TaskManifest,
} from "./contracts.ts";
import { runPairedExperiment } from "./evaluator.ts";
import {
	appendLedgerEvent,
	loadActiveTaskManifest,
	loadLatestDecision,
	loadLedger,
	loadMutation,
	loadSnapshot,
	loadTaskManifest,
	saveDecision,
	saveExperiment,
	saveMutation,
	saveSnapshot,
	saveTaskManifest,
	writeBaselineAtomic,
} from "./store.ts";

export function baselineFile(cwd: string): string {
	return join(cwd, ".pi", "loops", "_optimizer", "baseline-steps.json");
}

export function readCurrentBaseline(cwd: string): BaselineStep[] {
	try {
		const parsed = JSON.parse(readFileSync(baselineFile(cwd), "utf-8"));
		return Array.isArray(parsed) ? parsed.filter((step): step is BaselineStep => Boolean(step?.text)) : [];
	} catch {
		return [];
	}
}

export function promptVersionOf(steps: BaselineStep[]): number {
	return steps.reduce((version, step) => Math.max(version, step.version ?? 1), 1);
}

function pathContains(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateTasks(cwd: string, tasks: EvolutionTask[]): void {
	if (!Array.isArray(tasks)) throw new Error("task manifest must be an array");
	if (tasks.length === 0) throw new Error("task manifest must contain at least one task");
	const ids = new Set<string>();
	const splits = new Set(["validation", "held_out", "replay", "ood"]);
	const stateRoot = join(cwd, ".pi", "evolution");
	for (const task of tasks) {
		if (!task || typeof task !== "object") throw new Error("task manifest contains a non-object task");
		if (typeof task.taskId !== "string" || !task.taskId.trim() || ids.has(task.taskId)) {
			throw new Error(`duplicate or empty task id '${String(task.taskId)}'`);
		}
		ids.add(task.taskId);
		if (typeof task.goal !== "string" || !task.goal.trim()) throw new Error(`task '${task.taskId}' has no goal`);
		if (!splits.has(task.split)) throw new Error(`task '${task.taskId}' has invalid split '${String(task.split)}'`);
		if (typeof task.fixtureDir !== "string" || !task.fixtureDir.trim()) {
			throw new Error(`task '${task.taskId}' has no fixtureDir`);
		}
		const fixture = resolve(cwd, task.fixtureDir);
		if (pathContains(fixture, stateRoot)) {
			throw new Error(`task '${task.taskId}' fixtureDir contains the evolution state directory`);
		}
		if (
			!Array.isArray(task.command) ||
			task.command.length === 0 ||
			task.command.some((part) => typeof part !== "string" || !part.trim())
		) {
			throw new Error(`task '${task.taskId}' has an invalid command`);
		}
		if (
			!Array.isArray(task.hardGates) ||
			task.hardGates.length === 0 ||
			task.hardGates.some((gate) => typeof gate !== "string" || !gate.trim())
		) {
			throw new Error(`task '${task.taskId}' declares no valid hard gates`);
		}
		if (new Set(task.hardGates).size !== task.hardGates.length) {
			throw new Error(`task '${task.taskId}' declares duplicate hard gates`);
		}
		if (task.env !== undefined && (!task.env || typeof task.env !== "object" || Array.isArray(task.env))) {
			throw new Error(`task '${task.taskId}' has an invalid env object`);
		}
		for (const [key, value] of Object.entries(task.env ?? {})) {
			if (/(?:api[_-]?key|token|secret|password|credential)/i.test(key)) {
				throw new Error(`task '${task.taskId}' persists secret-like env key '${key}'`);
			}
			if (typeof value !== "string") throw new Error(`task '${task.taskId}' env '${key}' must be a string`);
		}
	}
	for (const split of splits) {
		if (!tasks.some((task) => task.split === split)) throw new Error(`task manifest has no ${split} task`);
	}
}

export function freezeTaskManifest(
	cwd: string,
	tasks: EvolutionTask[],
	frozenAt = new Date().toISOString(),
): TaskManifest {
	validateTasks(cwd, tasks);
	const manifest = createTaskManifest(tasks, frozenAt);
	saveTaskManifest(cwd, manifest);
	return manifest;
}

export function proposeLoopMutation(options: {
	cwd: string;
	proposals: Proposal[];
	runs: RunRecord[];
	taskManifest?: TaskManifest;
	createdAt?: string;
}): MutationManifest {
	if (options.proposals.length === 0) throw new Error("no loop-step proposals to stage");
	const tasks = options.taskManifest ?? loadActiveTaskManifest(options.cwd);
	if (!tasks) throw new Error("freeze an evaluation task manifest before proposing a mutation");
	const createdAt = options.createdAt ?? new Date().toISOString();
	if (Date.parse(tasks.frozenAt) > Date.parse(createdAt))
		throw new Error("task manifest must be frozen before proposal");
	const existing = readCurrentBaseline(options.cwd);
	const parent = createSnapshot(existing, promptVersionOf(existing), createdAt);
	const nextVersion = parent.promptVersion + 1;
	const added: BaselineStep[] = options.proposals.map((proposal) => ({
		cls: proposal.cls,
		text: proposal.text,
		runs: proposal.runs,
		version: nextVersion,
	}));
	const candidate = createSnapshot([...existing, ...added], nextVersion, createdAt);
	saveSnapshot(options.cwd, parent);
	saveSnapshot(options.cwd, candidate);
	const failureClasses = options.proposals.map((proposal) => proposal.cls);
	const mutation: MutationManifest = {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		mutationId: newRecordId("mutation"),
		createdAt,
		surface: "loop_prompt_steps",
		owner: "loop_optimizer",
		parentSnapshotId: parent.snapshotId,
		candidateSnapshotId: candidate.snapshotId,
		taskManifestId: tasks.manifestId,
		taskManifestHash: tasks.contentHash,
		failureClasses,
		evidence: options.runs.flatMap((run) => [
			{
				kind: "run" as const,
				id: `run-${hashValue({ goal: run.goal, promptVersion: run.promptVersion }).slice(0, 20)}`,
			},
			...(run.traceId ? [{ kind: "trace" as const, id: run.traceId }] : []),
		]),
		hypothesis: `Preloading ${failureClasses.join(", ")} instructions will reduce repeated loop failures without regressing hard gates.`,
		expectedMetricMovement:
			"Completion and quality should improve or remain stable; rounds and rejections should fall; hard gates must not regress.",
		candidatePatch: { addSteps: added },
		rollbackTarget: parent.snapshotId,
	};
	saveMutation(options.cwd, mutation);
	appendLedgerEvent(options.cwd, {
		mutationId: mutation.mutationId,
		type: "proposed",
		recordId: mutation.mutationId,
		details: { parent: parent.snapshotId, candidate: candidate.snapshotId, taskManifest: tasks.manifestId },
	});
	return mutation;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function createExperimentManifest(
	mutation: MutationManifest,
	createdAt = new Date().toISOString(),
): ExperimentManifest {
	return {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		experimentId: newRecordId("experiment"),
		mutationId: mutation.mutationId,
		createdAt,
		taskManifestId: mutation.taskManifestId,
		taskManifestHash: mutation.taskManifestHash,
		baselineSnapshotId: mutation.parentSnapshotId,
		candidateSnapshotId: mutation.candidateSnapshotId,
		samplesPerTask: positiveInteger(process.env.PI_EVOLUTION_SAMPLES, 2),
		model: process.env.PI_EVOLUTION_MODEL,
		toolsHash: process.env.PI_EVOLUTION_TOOLS_HASH,
		environmentHash: process.env.PI_EVOLUTION_ENVIRONMENT_HASH,
		budgets: {
			attemptTimeoutMs: positiveInteger(process.env.PI_EVOLUTION_ATTEMPT_TIMEOUT_MS, 300_000),
			maxTokensPerAttempt: process.env.PI_EVOLUTION_MAX_TOKENS
				? positiveInteger(process.env.PI_EVOLUTION_MAX_TOKENS, 1)
				: undefined,
			maxCostUsdPerAttempt: process.env.PI_EVOLUTION_MAX_COST_USD
				? finiteNumber(process.env.PI_EVOLUTION_MAX_COST_USD, 0)
				: undefined,
		},
		thresholds: {
			minCompletionRateDelta: finiteNumber(process.env.PI_EVOLUTION_MIN_COMPLETION_DELTA, 0),
			minQualityScoreDelta: finiteNumber(process.env.PI_EVOLUTION_MIN_QUALITY_DELTA, 0.01),
			minQualityScoreDeltaBySplit: {
				held_out: finiteNumber(process.env.PI_EVOLUTION_MIN_HELD_OUT_QUALITY_DELTA, 0),
				replay: finiteNumber(process.env.PI_EVOLUTION_MIN_REPLAY_QUALITY_DELTA, 0),
				ood: finiteNumber(process.env.PI_EVOLUTION_MIN_OOD_QUALITY_DELTA, 0),
			},
			maxLatencyRatio: finiteNumber(process.env.PI_EVOLUTION_MAX_LATENCY_RATIO, 1.25),
			maxTokenRatio: finiteNumber(process.env.PI_EVOLUTION_MAX_TOKEN_RATIO, 1.25),
			maxCostRatio: finiteNumber(process.env.PI_EVOLUTION_MAX_COST_RATIO, 1.25),
			requireNoHardGateRegression: true,
		},
	};
}

export async function evaluateLoopMutation(cwd: string, mutationId: string): Promise<DecisionRecord> {
	const mutation = loadMutation(cwd, mutationId);
	const tasks = loadTaskManifest(cwd, mutation.taskManifestId);
	const baseline = loadSnapshot(cwd, mutation.parentSnapshotId);
	const candidate = loadSnapshot(cwd, mutation.candidateSnapshotId);
	const experiment = createExperimentManifest(mutation);
	saveExperiment(cwd, experiment);
	appendLedgerEvent(cwd, {
		mutationId,
		type: "evaluation_started",
		recordId: experiment.experimentId,
		details: { samplesPerTask: experiment.samplesPerTask, tasks: tasks.tasks.length },
	});
	const { decision } = await runPairedExperiment({ cwd, experiment, mutation, tasks, baseline, candidate });
	saveDecision(cwd, decision);
	appendLedgerEvent(cwd, {
		mutationId,
		type: "evaluated",
		recordId: decision.decisionId,
		details: { decision: decision.decision, reasons: decision.reasons.length },
	});
	if (decision.decision === "reject") {
		appendLedgerEvent(cwd, { mutationId, type: "rejected", recordId: decision.decisionId });
	}
	return decision;
}

function currentSnapshot(cwd: string): ReturnType<typeof createSnapshot> {
	const steps = readCurrentBaseline(cwd);
	return createSnapshot(steps, promptVersionOf(steps));
}

export function promoteLoopMutation(cwd: string, mutationId: string): void {
	const mutation = loadMutation(cwd, mutationId);
	const mutationEvents = loadLedger(cwd).filter((event) => event.mutationId === mutationId);
	let decision: DecisionRecord;
	try {
		decision = loadLatestDecision(cwd, mutationId);
	} catch {
		throw new Error("mutation has no successful paired evaluation");
	}
	if (decision.decision !== "promote") throw new Error("mutation has no successful paired evaluation");
	let lastEvaluation = -1;
	let lastRollback = -1;
	for (let index = 0; index < mutationEvents.length; index += 1) {
		const event = mutationEvents[index];
		if (event.type === "evaluated" && event.recordId === decision.decisionId) lastEvaluation = index;
		if (event.type === "rolled_back") lastRollback = index;
	}
	if (lastEvaluation === -1) throw new Error("mutation has no successful paired evaluation");
	if (lastRollback > lastEvaluation) throw new Error("mutation requires a new paired evaluation after rollback");
	const current = currentSnapshot(cwd);
	if (current.snapshotId !== mutation.parentSnapshotId) {
		throw new Error("current baseline no longer matches the evaluated parent snapshot");
	}
	const candidate = loadSnapshot(cwd, mutation.candidateSnapshotId);
	appendLedgerEvent(cwd, { mutationId, type: "approved", recordId: decision.decisionId });
	writeBaselineAtomic(baselineFile(cwd), candidate.steps);
	appendLedgerEvent(cwd, {
		mutationId,
		type: "promoted",
		recordId: candidate.snapshotId,
		details: { rollbackTarget: mutation.rollbackTarget },
	});
}

export function rollbackLoopMutation(cwd: string, mutationId: string): void {
	const mutation = loadMutation(cwd, mutationId);
	if (!loadLedger(cwd).some((event) => event.mutationId === mutationId && event.type === "promoted")) {
		throw new Error("mutation was not promoted");
	}
	const current = currentSnapshot(cwd);
	if (current.snapshotId !== mutation.candidateSnapshotId) {
		throw new Error("current baseline is not this mutation's candidate; refusing to overwrite newer state");
	}
	const parent = loadSnapshot(cwd, mutation.rollbackTarget);
	writeBaselineAtomic(baselineFile(cwd), parent.steps);
	appendLedgerEvent(cwd, {
		mutationId,
		type: "rolled_back",
		recordId: parent.snapshotId,
		details: { from: mutation.candidateSnapshotId },
	});
}
