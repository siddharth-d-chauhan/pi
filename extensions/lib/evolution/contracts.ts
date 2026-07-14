import { createHash, randomUUID } from "node:crypto";
import type { BaselineStep } from "../loop-optimizer.ts";

export const EVOLUTION_SCHEMA_VERSION = 1;

export type EvaluationSplit = "validation" | "held_out" | "replay" | "ood";
export type EvaluationArm = "baseline" | "candidate";
export type MutationEventType =
	| "proposed"
	| "evaluation_started"
	| "evaluated"
	| "approved"
	| "rejected"
	| "promoted"
	| "rolled_back";

export interface EvidenceRef {
	kind: "run" | "trace" | "fact" | "context_packet" | "artifact";
	id: string;
	hash?: string;
}

export interface HarnessSnapshot {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	snapshotId: string;
	surface: "loop_prompt_steps";
	createdAt: string;
	promptVersion: number;
	steps: BaselineStep[];
	contentHash: string;
}

export interface EvolutionTask {
	taskId: string;
	goal: string;
	split: EvaluationSplit;
	/** Directory copied into an isolated attempt directory for each arm. */
	fixtureDir: string;
	/** Executed without a shell from the isolated fixture copy. */
	command: string[];
	hardGates: string[];
	env?: Record<string, string>;
}

export interface TaskManifest {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	manifestId: string;
	frozenAt: string;
	tasks: EvolutionTask[];
	contentHash: string;
}

export interface EvaluationBudgets {
	attemptTimeoutMs: number;
	maxTokensPerAttempt?: number;
	maxCostUsdPerAttempt?: number;
}

export interface EvaluationThresholds {
	minCompletionRateDelta: number;
	minQualityScoreDelta: number;
	minQualityScoreDeltaBySplit: Partial<Record<EvaluationSplit, number>>;
	maxLatencyRatio: number;
	maxTokenRatio: number;
	maxCostRatio: number;
	requireNoHardGateRegression: boolean;
}

export interface ExperimentManifest {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	experimentId: string;
	mutationId: string;
	createdAt: string;
	taskManifestId: string;
	taskManifestHash: string;
	baselineSnapshotId: string;
	candidateSnapshotId: string;
	samplesPerTask: number;
	model?: string;
	sampling?: Record<string, number | string | boolean>;
	toolsHash?: string;
	environmentHash?: string;
	budgets: EvaluationBudgets;
	thresholds: EvaluationThresholds;
}

export interface MutationManifest {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	mutationId: string;
	createdAt: string;
	surface: "loop_prompt_steps";
	owner: "loop_optimizer";
	parentSnapshotId: string;
	candidateSnapshotId: string;
	taskManifestId: string;
	taskManifestHash: string;
	failureClasses: string[];
	evidence: EvidenceRef[];
	hypothesis: string;
	expectedMetricMovement: string;
	candidatePatch: { addSteps: BaselineStep[] };
	rollbackTarget: string;
}

export interface AttemptMetrics {
	completed: boolean;
	qualityScore: number;
	criteriaPassRate: number;
	rounds: number;
	rejections: number;
	latencyMs: number;
	wallLatencyMs?: number;
	tokens?: number;
	costUsd?: number;
	hardGates: Record<string, boolean>;
}

export type AttemptOutcome = "completed" | "failed" | "timed_out" | "budget_exceeded" | "invalid_result";

export interface RunAttempt {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	attemptId: string;
	experimentId: string;
	mutationId: string;
	arm: EvaluationArm;
	taskId: string;
	split: EvaluationSplit;
	sample: number;
	snapshotId: string;
	startedAt: string;
	finishedAt: string;
	outcome: AttemptOutcome;
	metrics: AttemptMetrics;
	artifactRefs: string[];
	error?: string;
}

export interface AggregateMetrics {
	attempts: number;
	completionRate: number;
	meanQualityScore: number;
	meanCriteriaPassRate: number;
	meanRounds: number;
	meanRejections: number;
	meanLatencyMs: number;
	meanTokens: number;
	meanCostUsd: number;
	hardGateFailures: number;
}

export interface PairedComparison {
	baseline: AggregateMetrics;
	candidate: AggregateMetrics;
	deltas: {
		completionRate: number;
		qualityScore: number;
		criteriaPassRate: number;
	};
	ratios: {
		latency: number;
		tokens: number;
		cost: number;
	};
	hardGateRegressions: Array<{ taskId: string; sample: number; gate: string }>;
	bySplit: Record<
		EvaluationSplit,
		{
			baseline: AggregateMetrics;
			candidate: AggregateMetrics;
			deltas: { completionRate: number; qualityScore: number; criteriaPassRate: number };
		}
	>;
}

export interface DecisionRecord {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	decisionId: string;
	experimentId: string;
	mutationId: string;
	createdAt: string;
	decision: "promote" | "reject";
	reasons: string[];
	comparison: PairedComparison;
	thresholds: EvaluationThresholds;
	rollbackTarget: string;
}

export interface MutationLedgerEvent {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	eventId: string;
	mutationId: string;
	at: string;
	type: MutationEventType;
	recordId?: string;
	details?: Record<string, string | number | boolean>;
}

export interface TraceRecord {
	schemaVersion: typeof EVOLUTION_SCHEMA_VERSION;
	traceId: string;
	taskId: string;
	sessionId?: string;
	goal: string;
	startedAt: string;
	finishedAt: string;
	snapshotId: string;
	gitRevision?: string;
	model?: string;
	environmentHash: string;
	contextPacketIds: string[];
	toolResultRefs: string[];
	rootCauseLabels: Array<{ source: "deterministic" | "reviewer" | "user" | "model"; label: string }>;
	metrics: AttemptMetrics;
}

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, normalize(entry)]),
		);
	}
	return value;
}

export function stableJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function hashValue(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function newRecordId(prefix: string): string {
	return `${prefix}-${randomUUID()}`;
}

export function createSnapshot(
	steps: BaselineStep[],
	promptVersion: number,
	createdAt = new Date().toISOString(),
): HarnessSnapshot {
	const contentHash = hashValue({ promptVersion, steps });
	return {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		snapshotId: `snapshot-${contentHash.slice(0, 20)}`,
		surface: "loop_prompt_steps",
		createdAt,
		promptVersion,
		steps,
		contentHash,
	};
}

export function createTaskManifest(tasks: EvolutionTask[], frozenAt = new Date().toISOString()): TaskManifest {
	const contentHash = hashValue({ tasks });
	return {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		manifestId: `tasks-${hashValue({ tasks, frozenAt }).slice(0, 20)}`,
		frozenAt,
		tasks,
		contentHash,
	};
}
