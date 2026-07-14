import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { auditEvolution } from "../../../extensions/lib/evolution/audit.ts";
import type { EvaluationSplit, EvolutionTask } from "../../../extensions/lib/evolution/contracts.ts";
import type { AttemptExecutor } from "../../../extensions/lib/evolution/evaluator.ts";
import { runPairedExperiment } from "../../../extensions/lib/evolution/evaluator.ts";
import {
	appendLedgerEvent,
	loadLedger,
	loadMutation,
	loadSnapshot,
	loadTaskManifest,
	saveAttemptArtifact,
	saveDecision,
} from "../../../extensions/lib/evolution/store.ts";
import {
	createExperimentManifest,
	evaluateLoopMutation,
	freezeTaskManifest,
	promoteLoopMutation,
	proposeLoopMutation,
	readCurrentBaseline,
	rollbackLoopMutation,
} from "../../../extensions/lib/evolution/workflow.ts";
import type { Proposal, RunRecord } from "../../../extensions/lib/loop-optimizer.ts";

const PROPOSAL: Proposal = {
	cls: "criteria",
	text: "Run the objective criteria before claiming completion.",
	runs: 3,
	sampleGoals: ["a", "b", "c"],
};

const RUNS: RunRecord[] = ["a", "b", "c"].map((goal) => ({
	goal,
	promptVersion: 1,
	rounds: 4,
	rejections: 2,
	completed: true,
	learned: [{ cls: "criteria", text: PROPOSAL.text }],
}));

function taskSet(fixtureDir: string, barrierDir: string): EvolutionTask[] {
	const splits: EvaluationSplit[] = ["validation", "held_out", "replay", "ood"];
	return splits.map((split) => ({
		taskId: `task-${split}`,
		goal: `exercise ${split}`,
		split,
		fixtureDir,
		command: [process.execPath, "runner.mjs"],
		hardGates: ["verify"],
		env: { PI_EVOLUTION_BARRIER_DIR: barrierDir },
	}));
}

function writeBarrierRunner(fixtureDir: string): void {
	writeFileSync(
		join(fixtureDir, "runner.mjs"),
		`import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const barrier = process.env.PI_EVOLUTION_BARRIER_DIR;
const task = process.env.PI_EVOLUTION_TASK_ID;
const arm = process.env.PI_EVOLUTION_ARM;
const sample = process.env.PI_EVOLUTION_SAMPLE;
mkdirSync(barrier, { recursive: true });
writeFileSync(join(barrier, task + "-" + sample + "-" + arm), process.env.PI_EVOLUTION_ATTEMPT_ID);
const other = join(barrier, task + "-" + sample + "-" + (arm === "baseline" ? "candidate" : "baseline"));
for (let i = 0; i < 200 && !existsSync(other); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
if (!existsSync(other)) throw new Error("paired arm never overlapped");
const steps = JSON.parse(process.env.PI_EVOLUTION_PROMPT_STEPS_JSON || "[]");
const candidate = steps.length > 0;
console.log(JSON.stringify({
  completed: true,
  qualityScore: candidate ? 0.8 : 0.6,
  criteriaPassRate: candidate ? 1 : 0.9,
  rounds: candidate ? 2 : 3,
  rejections: candidate ? 0 : 1,
  latencyMs: 100,
  tokens: 100,
  costUsd: 0.01,
  hardGates: { verify: true }
}));
`,
	);
}

test("paired evaluator overlaps baseline and candidate, then promotion and rollback are gated", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-paired-"));
	const fixtureDir = join(cwd, "fixture");
	const barrierDir = join(cwd, "barriers");
	mkdirSync(fixtureDir, { recursive: true });
	writeBarrierRunner(fixtureDir);
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, barrierDir), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});

	const decision = await evaluateLoopMutation(cwd, mutation.mutationId);
	expect(decision.decision).toBe("promote");
	expect(decision.comparison.deltas.qualityScore).toBeCloseTo(0.2);
	expect(decision.comparison.hardGateRegressions).toEqual([]);
	for (const task of tasks.tasks) {
		for (const sample of [1, 2]) {
			expect(existsSync(join(barrierDir, `${task.taskId}-${sample}-baseline`))).toBe(true);
			expect(existsSync(join(barrierDir, `${task.taskId}-${sample}-candidate`))).toBe(true);
		}
	}

	promoteLoopMutation(cwd, mutation.mutationId);
	expect(readCurrentBaseline(cwd)).toHaveLength(1);
	expect(readCurrentBaseline(cwd)[0].text).toBe(PROPOSAL.text);
	let audit = auditEvolution(cwd);
	expect(audit.promoted).toBe(1);
	expect(audit.promotable).toBe(0);

	rollbackLoopMutation(cwd, mutation.mutationId);
	expect(readCurrentBaseline(cwd)).toEqual([]);
	audit = auditEvolution(cwd);
	expect(audit.promoted).toBe(0);
	expect(audit.rolledBack).toBe(1);
	expect(audit.promotable).toBe(0);
	expect(() => promoteLoopMutation(cwd, mutation.mutationId)).toThrow(
		"requires a new paired evaluation after rollback",
	);
	expect(loadLedger(cwd).map((event) => event.type)).toEqual([
		"proposed",
		"evaluation_started",
		"evaluated",
		"approved",
		"promoted",
		"rolled_back",
	]);
});

test("paired evaluator rejects a candidate that regresses a passing hard gate", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-reject-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	const executor: AttemptExecutor = async ({ arm }) => ({
		metrics: {
			completed: true,
			qualityScore: arm === "candidate" ? 1 : 0.5,
			criteriaPassRate: 1,
			rounds: 1,
			rejections: 0,
			latencyMs: 100,
			tokens: 100,
			costUsd: 0.01,
			hardGates: { verify: arm === "baseline" },
		},
	});
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(result.decision.decision).toBe("reject");
	expect(result.decision.comparison.hardGateRegressions).toHaveLength(8);
	expect(result.decision.reasons).toContain("candidate regressed a hard gate that passed on the baseline");
});

test("attempt timeout is enforced even when an executor ignores abort", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-timeout-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	experiment.budgets.attemptTimeoutMs = 10;
	const executor: AttemptExecutor = async () => new Promise(() => {});
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(result.attempts).toHaveLength(16);
	expect(result.attempts.every((attempt) => attempt.outcome === "timed_out")).toBe(true);
	expect(result.decision.decision).toBe("reject");
});

test("held-out regression cannot be hidden by a larger validation gain", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-held-out-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	const executor: AttemptExecutor = async ({ arm, task }) => {
		const baseline = 0.5;
		const candidate = task.split === "validation" ? 1 : task.split === "held_out" ? 0.4 : 0.5;
		return {
			metrics: {
				completed: true,
				qualityScore: arm === "candidate" ? candidate : baseline,
				criteriaPassRate: 1,
				rounds: 1,
				rejections: 0,
				latencyMs: 100,
				tokens: 100,
				costUsd: 0.01,
				hardGates: { verify: true },
			},
		};
	};
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(result.decision.comparison.deltas.qualityScore).toBeGreaterThan(0);
	expect(result.decision.comparison.bySplit.held_out.deltas.qualityScore).toBeLessThan(0);
	expect(result.decision.decision).toBe("reject");
	expect(result.decision.reasons).toContain("held_out quality-score delta is below the declared threshold");
});

test("promotion requires an evaluation and rejects a stale parent snapshot", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-stale-parent-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	expect(() => promoteLoopMutation(cwd, mutation.mutationId)).toThrow("no successful paired evaluation");

	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	const executor: AttemptExecutor = async ({ arm }) => ({
		metrics: {
			completed: true,
			qualityScore: arm === "candidate" ? 1 : 0.8,
			criteriaPassRate: 1,
			rounds: 1,
			rejections: 0,
			latencyMs: 100,
			tokens: 100,
			costUsd: 0.01,
			hardGates: { verify: true },
		},
	});
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(result.decision.decision).toBe("promote");
	saveDecision(cwd, result.decision);
	expect(() => promoteLoopMutation(cwd, mutation.mutationId)).toThrow("no successful paired evaluation");
	appendLedgerEvent(cwd, {
		mutationId: mutation.mutationId,
		type: "evaluated",
		recordId: result.decision.decisionId,
		details: { decision: result.decision.decision, reasons: result.decision.reasons.length },
	});
	mkdirSync(join(cwd, ".pi", "loops", "_optimizer"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "loops", "_optimizer", "baseline-steps.json"),
		JSON.stringify([{ cls: "other", text: "newer state", runs: 1, version: 2 }]),
	);
	expect(() => promoteLoopMutation(cwd, mutation.mutationId)).toThrow("no longer matches the evaluated parent");
});

test("task sets must be frozen before a mutation is proposed", () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-freeze-order-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-03T00:00:00.000Z");
	expect(() =>
		proposeLoopMutation({
			cwd,
			proposals: [PROPOSAL],
			runs: RUNS,
			taskManifest: tasks,
			createdAt: "2026-01-02T00:00:00.000Z",
		}),
	).toThrow("task manifest must be frozen before proposal");
});

test("snapshot artifacts are content-addressed and immutable", () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-snapshot-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const candidate = loadSnapshot(cwd, mutation.candidateSnapshotId);
	expect(candidate.snapshotId).toMatch(/^snapshot-[a-f0-9]{20}$/);
	expect(candidate.contentHash).toHaveLength(64);
	const repeated = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T01:00:00.000Z",
	});
	expect(repeated.parentSnapshotId).toBe(mutation.parentSnapshotId);
	expect(repeated.candidateSnapshotId).toBe(mutation.candidateSnapshotId);
	expect(repeated.mutationId).not.toBe(mutation.mutationId);
	expect(
		readFileSync(join(cwd, ".pi", "evolution", "mutations", mutation.mutationId, "manifest.json"), "utf-8"),
	).toContain(mutation.parentSnapshotId);

	const snapshotPath = join(cwd, ".pi", "evolution", "snapshots", `${mutation.candidateSnapshotId}.json`);
	const tampered = JSON.parse(readFileSync(snapshotPath, "utf-8")) as { steps: Array<{ text: string }> };
	tampered.steps[0].text = "tampered without updating the content hash";
	writeFileSync(snapshotPath, JSON.stringify(tampered));
	expect(() => loadSnapshot(cwd, mutation.candidateSnapshotId)).toThrow("snapshot content hash mismatch");
});

test("task manifests reject persisted secret env and stored output is redacted", () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-redaction-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = taskSet(fixtureDir, join(cwd, "barriers"));
	tasks[0].env = { OPENAI_API_KEY: "must-not-persist" };
	expect(() => freezeTaskManifest(cwd, tasks)).toThrow("persists secret-like env key");

	const ref = saveAttemptArtifact(
		cwd,
		"experiment-redaction",
		"attempt-redaction",
		"stdout",
		`${"x".repeat(1_000_100)} token=plain-secret OPENAI_API_KEY="quoted secret" GITHUB_TOKEN='two words' DATABASE_CREDENTIAL=credential-secret Authorization: Bearer bearer-secret sk-abcdefghijklmnop`,
	);
	const artifactDir = join(cwd, ".pi", "evolution", "experiments", "experiment-redaction", "artifacts");
	const payload = readFileSync(join(artifactDir, readdirSync(artifactDir)[0]), "utf-8");
	const artifact = JSON.parse(payload) as { content: string };
	expect(ref).toMatch(/^artifact-/);
	expect(artifact.content.length).toBeLessThanOrEqual(1_000_000);
	expect(payload).not.toContain("plain-secret");
	expect(payload).not.toContain("quoted secret");
	expect(payload).not.toContain("two words");
	expect(payload).not.toContain("credential-secret");
	expect(payload).not.toContain("bearer-secret");
	expect(payload).not.toContain("sk-abcdefghijklmnop");
	expect(payload).toContain("[REDACTED]");
});

test("record identifiers cannot escape the evolution store", () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-paths-"));
	expect(() => loadMutation(cwd, "../../outside")).toThrow("invalid mutation id");
	expect(() => loadSnapshot(cwd, "../snapshot-outside")).toThrow("invalid snapshot id");
});

test("task manifests reject malformed runtime JSON and require every evaluation split", () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-task-validation-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });

	const invalidCommand = taskSet(fixtureDir, join(cwd, "barriers"));
	invalidCommand[0].command = "node runner.mjs" as unknown as string[];
	expect(() => freezeTaskManifest(cwd, invalidCommand)).toThrow("invalid command");

	const invalidSplit = taskSet(fixtureDir, join(cwd, "barriers"));
	invalidSplit[0].split = "training" as EvaluationSplit;
	expect(() => freezeTaskManifest(cwd, invalidSplit)).toThrow("invalid split");

	const invalidEnv = taskSet(fixtureDir, join(cwd, "barriers"));
	invalidEnv[0].env = { SAFE_SETTING: 42 } as unknown as Record<string, string>;
	expect(() => freezeTaskManifest(cwd, invalidEnv)).toThrow("must be a string");

	expect(() => freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")).slice(0, 3))).toThrow(
		"task manifest has no ood task",
	);
	expect(() => freezeTaskManifest(cwd, { tasks: [] } as unknown as EvolutionTask[])).toThrow(
		"task manifest must be an array",
	);

	const recursiveFixture = taskSet(cwd, join(cwd, "barriers"));
	expect(() => freezeTaskManifest(cwd, recursiveFixture)).toThrow("fixtureDir contains the evolution state directory");
});

test("task manifests are verified when loaded from the immutable store", () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-task-integrity-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const manifest = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const path = join(cwd, ".pi", "evolution", "task-manifests", `${manifest.manifestId}.json`);
	const tampered = JSON.parse(readFileSync(path, "utf-8")) as { tasks: Array<{ goal: string }> };
	tampered.tasks[0].goal = "tampered after freezing";
	writeFileSync(path, JSON.stringify(tampered));
	expect(() => loadTaskManifest(cwd, manifest.manifestId)).toThrow("task manifest hash mismatch");
});

test("candidate budget overruns and missing budget metrics cannot be promoted", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-budget-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	experiment.samplesPerTask = 1;
	experiment.budgets.maxTokensPerAttempt = 100;
	const executor: AttemptExecutor = async ({ arm }) => ({
		metrics: {
			completed: true,
			qualityScore: arm === "candidate" ? 1 : 0.5,
			criteriaPassRate: 1,
			rounds: 1,
			rejections: 0,
			latencyMs: 100,
			tokens: arm === "candidate" ? undefined : 100,
			costUsd: 0.01,
			hardGates: { verify: true },
		},
	});
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(
		result.attempts
			.filter((attempt) => attempt.arm === "candidate")
			.every((attempt) => attempt.outcome === "budget_exceeded"),
	).toBe(true);
	expect(result.decision.decision).toBe("reject");
	expect(result.decision.reasons).toContain("candidate has non-completed attempt outcomes");
});

test("latency decisions use measured wall time when a runner under-reports", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-wall-latency-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	experiment.samplesPerTask = 1;
	const executor: AttemptExecutor = async ({ arm }) => {
		await new Promise((resolve) => setTimeout(resolve, arm === "candidate" ? 30 : 2));
		return {
			metrics: {
				completed: true,
				qualityScore: arm === "candidate" ? 1 : 0.5,
				criteriaPassRate: 1,
				rounds: 1,
				rejections: 0,
				latencyMs: 1,
				tokens: 100,
				costUsd: 0.01,
				hardGates: { verify: true },
			},
		};
	};
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(result.decision.comparison.ratios.latency).toBeGreaterThan(experiment.thresholds.maxLatencyRatio);
	expect(result.decision.reasons).toContain("latency ratio exceeds the declared limit");
	expect(result.decision.decision).toBe("reject");
});

test("invalid negative metrics are rejected instead of entering comparisons", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-invalid-metrics-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	experiment.samplesPerTask = 1;
	const executor: AttemptExecutor = async () => ({
		metrics: {
			completed: true,
			qualityScore: 1,
			criteriaPassRate: 1,
			rounds: 1,
			rejections: 0,
			latencyMs: -1,
			tokens: 100,
			costUsd: 0.01,
			hardGates: { verify: true },
		},
	});
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(result.attempts.every((attempt) => attempt.outcome === "invalid_result")).toBe(true);
	expect(result.decision.decision).toBe("reject");
});

test("comparison ratios remain finite when the baseline reports zero usage", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-finite-ratio-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	const tasks = freezeTaskManifest(cwd, taskSet(fixtureDir, join(cwd, "barriers")), "2026-01-01T00:00:00.000Z");
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	experiment.samplesPerTask = 1;
	const executor: AttemptExecutor = async ({ arm }) => ({
		metrics: {
			completed: true,
			qualityScore: arm === "candidate" ? 1 : 0.5,
			criteriaPassRate: 1,
			rounds: 1,
			rejections: 0,
			latencyMs: 100,
			tokens: arm === "candidate" ? 100 : 0,
			costUsd: 0,
			hardGates: { verify: true },
		},
	});
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
		executor,
	});
	expect(Number.isFinite(result.decision.comparison.ratios.tokens)).toBe(true);
	expect(result.decision.comparison.ratios.tokens).toBe(1_000_000_000);
	expect(result.decision.decision).toBe("reject");
});

test("command runners must emit metrics as their final non-empty stdout line", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "evolution-final-line-"));
	const fixtureDir = join(cwd, "fixture");
	mkdirSync(fixtureDir, { recursive: true });
	writeFileSync(
		join(fixtureDir, "runner.mjs"),
		`console.log(JSON.stringify({ completed: true, qualityScore: 1, criteriaPassRate: 1, rounds: 1, rejections: 0, latencyMs: 1, tokens: 1, costUsd: 0, hardGates: { verify: true } }));\nconsole.log("trailing output");\n`,
	);
	const rawTasks = taskSet(fixtureDir, join(cwd, "barriers"));
	const tasks = freezeTaskManifest(
		cwd,
		rawTasks.map((task) => ({ ...task, env: undefined })),
		"2026-01-01T00:00:00.000Z",
	);
	const mutation = proposeLoopMutation({
		cwd,
		proposals: [PROPOSAL],
		runs: RUNS,
		taskManifest: tasks,
		createdAt: "2026-01-02T00:00:00.000Z",
	});
	const experiment = createExperimentManifest(mutation, "2026-01-03T00:00:00.000Z");
	experiment.samplesPerTask = 1;
	const result = await runPairedExperiment({
		cwd,
		experiment,
		mutation,
		tasks,
		baseline: loadSnapshot(cwd, mutation.parentSnapshotId),
		candidate: loadSnapshot(cwd, mutation.candidateSnapshotId),
	});
	expect(result.attempts.every((attempt) => attempt.outcome === "invalid_result")).toBe(true);
	expect(result.attempts.every((attempt) => attempt.error?.includes("runner final line"))).toBe(true);
	expect(result.decision.decision).toBe("reject");
});
