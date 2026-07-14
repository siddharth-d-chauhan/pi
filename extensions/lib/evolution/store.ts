import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createSnapshot,
	createTaskManifest,
	type DecisionRecord,
	EVOLUTION_SCHEMA_VERSION,
	type ExperimentManifest,
	type HarnessSnapshot,
	hashValue,
	type MutationLedgerEvent,
	type MutationManifest,
	newRecordId,
	type RunAttempt,
	type TaskManifest,
	type TraceRecord,
} from "./contracts.ts";

const MAX_ARTIFACT_CHARS = 1_000_000;

export function evolutionRoot(cwd: string): string {
	return join(cwd, ".pi", "evolution");
}

function assertRecordId(value: string, label: string): void {
	if (!/^[a-z][a-z0-9_-]*-[A-Za-z0-9-]+$/.test(value)) throw new Error(`invalid ${label}`);
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${newRecordId("tmp")}`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temp, path);
}

function writeImmutable(path: string, value: unknown): void {
	if (existsSync(path)) {
		const existing = JSON.parse(readFileSync(path, "utf-8"));
		if (hashValue(existing) !== hashValue(value))
			throw new Error(`immutable evolution record already exists: ${path}`);
		return;
	}
	writeJsonAtomic(path, value);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function saveSnapshot(cwd: string, snapshot: HarnessSnapshot): void {
	assertRecordId(snapshot.snapshotId, "snapshot id");
	validateSnapshot(snapshot, snapshot.snapshotId);
	const path = join(evolutionRoot(cwd), "snapshots", `${snapshot.snapshotId}.json`);
	if (existsSync(path)) {
		const existing = readJson<HarnessSnapshot>(path);
		validateSnapshot(existing, snapshot.snapshotId);
		if (existing.contentHash !== snapshot.contentHash) throw new Error("snapshot id collision");
		return;
	}
	writeImmutable(path, snapshot);
}

export function loadSnapshot(cwd: string, snapshotId: string): HarnessSnapshot {
	assertRecordId(snapshotId, "snapshot id");
	const snapshot = readJson<HarnessSnapshot>(join(evolutionRoot(cwd), "snapshots", `${snapshotId}.json`));
	validateSnapshot(snapshot, snapshotId);
	return snapshot;
}

function validateSnapshot(snapshot: HarnessSnapshot, expectedId: string): void {
	if (snapshot.schemaVersion !== EVOLUTION_SCHEMA_VERSION) throw new Error("unsupported snapshot schema");
	const expected = createSnapshot(snapshot.steps, snapshot.promptVersion, snapshot.createdAt);
	if (snapshot.contentHash !== expected.contentHash) throw new Error("snapshot content hash mismatch");
	if (snapshot.snapshotId !== expected.snapshotId || snapshot.snapshotId !== expectedId) {
		throw new Error("snapshot id does not match its content");
	}
}

export function saveTaskManifest(cwd: string, manifest: TaskManifest): void {
	assertRecordId(manifest.manifestId, "task manifest id");
	validateTaskManifest(manifest, manifest.manifestId);
	writeImmutable(join(evolutionRoot(cwd), "task-manifests", `${manifest.manifestId}.json`), manifest);
	writeJsonAtomic(join(evolutionRoot(cwd), "active-task-manifest.json"), {
		manifestId: manifest.manifestId,
		contentHash: manifest.contentHash,
	});
}

export function loadTaskManifest(cwd: string, manifestId: string): TaskManifest {
	assertRecordId(manifestId, "task manifest id");
	const manifest = readJson<TaskManifest>(join(evolutionRoot(cwd), "task-manifests", `${manifestId}.json`));
	validateTaskManifest(manifest, manifestId);
	return manifest;
}

function validateTaskManifest(manifest: TaskManifest, expectedId: string): void {
	if (manifest.schemaVersion !== EVOLUTION_SCHEMA_VERSION) throw new Error("unsupported task manifest schema");
	const expected = createTaskManifest(manifest.tasks, manifest.frozenAt);
	if (manifest.contentHash !== expected.contentHash) throw new Error("task manifest hash mismatch");
	if (manifest.manifestId !== expected.manifestId || manifest.manifestId !== expectedId) {
		throw new Error("task manifest id does not match its content");
	}
}

export function loadActiveTaskManifest(cwd: string): TaskManifest | undefined {
	const pointerPath = join(evolutionRoot(cwd), "active-task-manifest.json");
	if (!existsSync(pointerPath)) return undefined;
	const pointer = readJson<{ manifestId: string; contentHash: string }>(pointerPath);
	const manifest = loadTaskManifest(cwd, pointer.manifestId);
	if (pointer.contentHash !== manifest.contentHash) throw new Error("active task manifest pointer hash mismatch");
	return manifest;
}

export function saveMutation(cwd: string, mutation: MutationManifest): void {
	assertRecordId(mutation.mutationId, "mutation id");
	writeImmutable(join(evolutionRoot(cwd), "mutations", mutation.mutationId, "manifest.json"), mutation);
}

export function loadMutation(cwd: string, mutationId: string): MutationManifest {
	assertRecordId(mutationId, "mutation id");
	const mutation = readJson<MutationManifest>(join(evolutionRoot(cwd), "mutations", mutationId, "manifest.json"));
	if (mutation.schemaVersion !== EVOLUTION_SCHEMA_VERSION) throw new Error("unsupported mutation schema");
	if (mutation.mutationId !== mutationId) throw new Error("mutation id does not match its record path");
	return mutation;
}

export function listMutationIds(cwd: string): string[] {
	try {
		return readdirSync(join(evolutionRoot(cwd), "mutations")).sort();
	} catch {
		return [];
	}
}

export function appendLedgerEvent(
	cwd: string,
	event: Omit<MutationLedgerEvent, "schemaVersion" | "eventId" | "at"> & { at?: string },
): MutationLedgerEvent {
	const record: MutationLedgerEvent = {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		eventId: newRecordId("event"),
		at: event.at ?? new Date().toISOString(),
		mutationId: event.mutationId,
		type: event.type,
		recordId: event.recordId,
		details: event.details,
	};
	mkdirSync(evolutionRoot(cwd), { recursive: true });
	appendFileSync(join(evolutionRoot(cwd), "ledger.jsonl"), `${JSON.stringify(record)}\n`);
	return record;
}

export function loadLedger(cwd: string): MutationLedgerEvent[] {
	try {
		return readFileSync(join(evolutionRoot(cwd), "ledger.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as MutationLedgerEvent];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

export function saveExperiment(cwd: string, manifest: ExperimentManifest): void {
	assertRecordId(manifest.experimentId, "experiment id");
	writeImmutable(join(evolutionRoot(cwd), "experiments", manifest.experimentId, "manifest.json"), manifest);
}

export function saveAttempt(cwd: string, attempt: RunAttempt): void {
	assertRecordId(attempt.experimentId, "experiment id");
	assertRecordId(attempt.attemptId, "attempt id");
	writeImmutable(
		join(evolutionRoot(cwd), "experiments", attempt.experimentId, "attempts", `${attempt.attemptId}.json`),
		attempt,
	);
}

export function saveAttemptArtifact(
	cwd: string,
	experimentId: string,
	attemptId: string,
	name: "stdout" | "stderr",
	content: string,
): string {
	assertRecordId(experimentId, "experiment id");
	assertRecordId(attemptId, "attempt id");
	const redacted = content
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
		.replace(
			/\b((?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|token|password|secret|credential)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
			"$1[REDACTED]",
		)
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
		.slice(-MAX_ARTIFACT_CHARS);
	const ref = `artifact-${hashValue(redacted).slice(0, 20)}`;
	writeImmutable(
		join(evolutionRoot(cwd), "experiments", experimentId, "artifacts", `${attemptId}-${ref}-${name}.json`),
		{
			ref,
			attemptId,
			name,
			content: redacted,
		},
	);
	return ref;
}

export function saveDecision(cwd: string, decision: DecisionRecord): void {
	assertRecordId(decision.experimentId, "experiment id");
	assertRecordId(decision.mutationId, "mutation id");
	writeImmutable(join(evolutionRoot(cwd), "experiments", decision.experimentId, "decision.json"), decision);
	writeJsonAtomic(join(evolutionRoot(cwd), "mutations", decision.mutationId, "latest-decision.json"), decision);
}

export function loadLatestDecision(cwd: string, mutationId: string): DecisionRecord {
	assertRecordId(mutationId, "mutation id");
	const decision = readJson<DecisionRecord>(join(evolutionRoot(cwd), "mutations", mutationId, "latest-decision.json"));
	if (decision.schemaVersion !== EVOLUTION_SCHEMA_VERSION) throw new Error("unsupported decision schema");
	if (decision.mutationId !== mutationId) throw new Error("decision mutation does not match its record path");
	return decision;
}

export function appendTrace(cwd: string, trace: TraceRecord): void {
	mkdirSync(join(evolutionRoot(cwd), "traces"), { recursive: true });
	appendFileSync(join(evolutionRoot(cwd), "traces", "runs.jsonl"), `${JSON.stringify(trace)}\n`);
}

export function writeBaselineAtomic(path: string, steps: HarnessSnapshot["steps"]): void {
	writeJsonAtomic(path, steps);
}
