import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExpertCaseCompilation } from "./compiler.ts";
import {
	type BitbucketLinkageAudit,
	EXPERT_CASE_SCHEMA_VERSION,
	EXPERT_LEARNING_SCHEMA_VERSION,
	EXPERT_TRANSFER_SCHEMA_VERSION,
	type ExpertCaseManifest,
	type ExpertCasePublic,
	type ExpertCaseSealed,
	type ExpertLearningRun,
	type ExpertTransferValidation,
	expertHash,
} from "./contracts.ts";

export function expertCasesRoot(cwd: string): string {
	return join(cwd, ".pi", "expert-cases");
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temp, path);
}

function writeImmutable(path: string, value: unknown): void {
	if (existsSync(path)) {
		const current = JSON.parse(readFileSync(path, "utf-8"));
		if (expertHash(current) !== expertHash(value)) throw new Error(`immutable expert-case record differs: ${path}`);
		return;
	}
	writeJsonAtomic(path, value);
}

function validatePublic(value: ExpertCasePublic): void {
	if (value.schemaVersion !== EXPERT_CASE_SCHEMA_VERSION) throw new Error("unsupported public expert-case schema");
	const { contentHash: _contentHash, ...core } = value;
	if (value.contentHash !== expertHash(core)) throw new Error(`public case hash mismatch: ${value.caseId}`);
	if (value.eligibility.leakageFreeEvaluation && value.eligibility.reasons.length > 0) {
		throw new Error(`evaluation-ready case has leakage warnings: ${value.caseId}`);
	}
}

function validateSealed(value: ExpertCaseSealed): void {
	if (value.schemaVersion !== EXPERT_CASE_SCHEMA_VERSION) throw new Error("unsupported sealed expert-case schema");
	const { contentHash: _contentHash, ...core } = value;
	if (value.contentHash !== expertHash(core)) throw new Error(`sealed case hash mismatch: ${value.caseId}`);
}

function validateManifest(value: ExpertCaseManifest): void {
	if (value.schemaVersion !== EXPERT_CASE_SCHEMA_VERSION) throw new Error("unsupported expert-case manifest schema");
	const { contentHash: _contentHash, ...core } = value;
	if (value.contentHash !== expertHash(core)) throw new Error("expert-case manifest hash mismatch");
	if (value.manifestId !== `expert-${value.sourceFingerprint.slice(0, 24)}`) {
		throw new Error("expert-case manifest id does not match its source fingerprint");
	}
}

function validateBitbucketLinkageAudit(value: BitbucketLinkageAudit): void {
	if (value.schemaVersion !== 1) throw new Error("unsupported Bitbucket linkage audit schema");
	const { contentHash: _contentHash, ...core } = value;
	if (value.contentHash !== expertHash(core))
		throw new Error(`Bitbucket linkage audit hash mismatch: ${value.auditId}`);
	if (value.auditId !== `bitbucket-audit-${value.sourceFingerprint.slice(0, 24)}`) {
		throw new Error("Bitbucket linkage audit id does not match its source fingerprint");
	}
}

export function saveExpertCompilation(cwd: string, compilation: ExpertCaseCompilation): ExpertCaseManifest {
	const root = expertCasesRoot(cwd);
	for (const publicCase of compilation.publicCases) {
		validatePublic(publicCase);
		writeImmutable(join(root, "cases", "public", `${publicCase.caseId}.json`), publicCase);
	}
	for (const sealedCase of compilation.sealedCases) {
		validateSealed(sealedCase);
		writeImmutable(join(root, "cases", "sealed", `${sealedCase.caseId}.json`), sealedCase);
	}
	validateManifest(compilation.manifest);
	writeImmutable(join(root, "manifests", `${compilation.manifest.manifestId}.json`), compilation.manifest);
	writeJsonAtomic(join(root, "active-manifest.json"), {
		manifestId: compilation.manifest.manifestId,
		contentHash: compilation.manifest.contentHash,
	});
	return compilation.manifest;
}

export function loadActiveExpertManifest(cwd: string): ExpertCaseManifest | undefined {
	const pointerPath = join(expertCasesRoot(cwd), "active-manifest.json");
	if (!existsSync(pointerPath)) return undefined;
	const pointer = JSON.parse(readFileSync(pointerPath, "utf-8")) as { manifestId: string; contentHash: string };
	const manifest = JSON.parse(
		readFileSync(join(expertCasesRoot(cwd), "manifests", `${pointer.manifestId}.json`), "utf-8"),
	) as ExpertCaseManifest;
	validateManifest(manifest);
	if (pointer.contentHash !== manifest.contentHash) throw new Error("active expert-case pointer hash mismatch");
	return manifest;
}

export function loadExpertCase(
	cwd: string,
	caseId: string,
): { publicCase: ExpertCasePublic; sealedCase: ExpertCaseSealed } {
	if (!/^case-[a-f0-9]{24}$/.test(caseId)) throw new Error("invalid expert case id");
	const root = expertCasesRoot(cwd);
	const publicCase = JSON.parse(
		readFileSync(join(root, "cases", "public", `${caseId}.json`), "utf-8"),
	) as ExpertCasePublic;
	const sealedCase = JSON.parse(
		readFileSync(join(root, "cases", "sealed", `${caseId}.json`), "utf-8"),
	) as ExpertCaseSealed;
	validatePublic(publicCase);
	validateSealed(sealedCase);
	if (sealedCase.publicCaseHash !== publicCase.contentHash) throw new Error(`public/sealed case mismatch: ${caseId}`);
	return { publicCase, sealedCase };
}

export function auditExpertCases(cwd: string): { manifestId: string; cases: number; valid: number } {
	const manifest = loadActiveExpertManifest(cwd);
	if (!manifest) throw new Error("no active expert-case manifest");
	let valid = 0;
	for (const ref of manifest.cases) {
		const item = loadExpertCase(cwd, ref.caseId);
		if (item.publicCase.contentHash !== ref.publicHash || item.sealedCase.contentHash !== ref.sealedHash) {
			throw new Error(`manifest case hash mismatch: ${ref.caseId}`);
		}
		valid += 1;
	}
	return { manifestId: manifest.manifestId, cases: manifest.cases.length, valid };
}

export function saveBitbucketLinkageAudit(cwd: string, audit: BitbucketLinkageAudit): BitbucketLinkageAudit {
	validateBitbucketLinkageAudit(audit);
	const root = expertCasesRoot(cwd);
	writeImmutable(join(root, "linkage-audits", `${audit.auditId}.json`), audit);
	writeJsonAtomic(join(root, "active-linkage-audit.json"), {
		auditId: audit.auditId,
		contentHash: audit.contentHash,
	});
	return audit;
}

export function loadActiveBitbucketLinkageAudit(cwd: string): BitbucketLinkageAudit | undefined {
	const root = expertCasesRoot(cwd);
	const pointerPath = join(root, "active-linkage-audit.json");
	if (!existsSync(pointerPath)) return undefined;
	const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { auditId: string; contentHash: string };
	if (!/^bitbucket-audit-[a-f0-9]{24}$/.test(pointer.auditId)) throw new Error("invalid Bitbucket linkage audit id");
	const audit = JSON.parse(
		readFileSync(join(root, "linkage-audits", `${pointer.auditId}.json`), "utf8"),
	) as BitbucketLinkageAudit;
	validateBitbucketLinkageAudit(audit);
	if (pointer.contentHash !== audit.contentHash)
		throw new Error("active Bitbucket linkage audit pointer hash mismatch");
	return audit;
}

function validateLearningRun(value: ExpertLearningRun): void {
	if (value.schemaVersion !== EXPERT_LEARNING_SCHEMA_VERSION) throw new Error("unsupported expert-learning schema");
	const { contentHash: _contentHash, ...core } = value;
	if (value.contentHash !== expertHash(core)) throw new Error(`expert-learning run hash mismatch: ${value.runId}`);
	const { runId: _runId, ...identityCore } = core;
	if (value.runId !== `learning-${expertHash(identityCore).slice(0, 24)}`) {
		throw new Error(`expert-learning run id mismatch: ${value.runId}`);
	}
	const { contentHash: _packetHash, ...packetCore } = value.packet;
	if (value.packet.contentHash !== expertHash(packetCore))
		throw new Error(`learning packet hash mismatch: ${value.runId}`);
	for (const claim of value.claims) {
		const { contentHash: _claimHash, ...claimCore } = claim;
		if (claim.contentHash !== expertHash(claimCore))
			throw new Error(`learning claim hash mismatch: ${claim.claimId}`);
		const { claimId: _claimId, ...claimIdentity } = claimCore;
		if (claim.claimId !== `claim-${expertHash(claimIdentity).slice(0, 24)}`) {
			throw new Error(`learning claim id mismatch: ${claim.claimId}`);
		}
		const modelGovernance =
			(value.executedVia === "pi-rpc" || value.executedVia === "governed-review") &&
			claim.authority === "strong_model" &&
			claim.evidenceStrength === "semantic";
		const localGovernance =
			value.executedVia === "local-deterministic" &&
			claim.authority === "deterministic" &&
			claim.evidenceStrength === "structural";
		if (claim.state !== "proposed" || (!modelGovernance && !localGovernance)) {
			throw new Error(`learning claim governance mismatch: ${claim.claimId}`);
		}
	}
	const minimaxExecutor =
		value.model.provider === "minimax" && value.model.id === "MiniMax-M3" && value.executedVia === "pi-rpc";
	const localExecutor =
		value.model.provider === "local" &&
		value.model.id === "structural-v1" &&
		value.executedVia === "local-deterministic";
	const governedReviewExecutor =
		value.model.provider === "codex" && value.model.id === "gpt-5" && value.executedVia === "governed-review";
	if (!minimaxExecutor && !localExecutor && !governedReviewExecutor) {
		throw new Error(`unsupported expert-learning executor: ${value.runId}`);
	}
	const passed = value.claims.length > 0 && value.rejectedClaims.length === 0 && value.validation.errors.length === 0;
	if (
		value.validation.status !== (passed ? "passed" : "failed") ||
		value.validation.publicationGate !== (passed ? "eligible" : "blocked")
	) {
		throw new Error(`expert-learning validation state mismatch: ${value.runId}`);
	}
	if (value.validation.published) throw new Error(`shadow learning run cannot be published: ${value.runId}`);
}

export function saveExpertLearningRun(cwd: string, run: ExpertLearningRun): ExpertLearningRun {
	validateLearningRun(run);
	writeImmutable(join(expertCasesRoot(cwd), "learning-runs", `${run.runId}.json`), run);
	return run;
}

export function loadExpertLearningRun(cwd: string, runId: string): ExpertLearningRun {
	if (!/^learning-[a-f0-9]{24}$/.test(runId)) throw new Error("invalid expert-learning run id");
	const run = JSON.parse(
		readFileSync(join(expertCasesRoot(cwd), "learning-runs", `${runId}.json`), "utf-8"),
	) as ExpertLearningRun;
	validateLearningRun(run);
	return run;
}

export function listExpertLearningRuns(cwd: string): ExpertLearningRun[] {
	const directory = join(expertCasesRoot(cwd), "learning-runs");
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((file) => /^learning-[a-f0-9]{24}\.json$/.test(file))
		.map((file) => loadExpertLearningRun(cwd, file.slice(0, -".json".length)))
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function auditExpertLearningRuns(cwd: string): { runs: number; valid: number; passed: number } {
	const runs = listExpertLearningRuns(cwd);
	return {
		runs: runs.length,
		valid: runs.length,
		passed: runs.filter((run) => run.validation.status === "passed").length,
	};
}

function validateTransferValidation(value: ExpertTransferValidation): void {
	if (value.schemaVersion !== EXPERT_TRANSFER_SCHEMA_VERSION) throw new Error("unsupported expert-transfer schema");
	const { contentHash: _contentHash, ...core } = value;
	if (value.contentHash !== expertHash(core)) {
		throw new Error(`expert-transfer validation hash mismatch: ${value.validationId}`);
	}
	const { validationId: _validationId, ...identityCore } = core;
	if (value.validationId !== `transfer-${expertHash(identityCore).slice(0, 24)}`) {
		throw new Error(`expert-transfer validation id mismatch: ${value.validationId}`);
	}
	const { contentHash: _taskHash, ...taskCore } = value.task;
	if (value.task.contentHash !== expertHash(taskCore)) {
		throw new Error(`expert-transfer task hash mismatch: ${value.validationId}`);
	}
	if (value.claimIds.length === 0 || new Set(value.claimIds).size !== value.claimIds.length) {
		throw new Error(`expert-transfer validation has invalid claims: ${value.validationId}`);
	}
	if (
		value.task.expectedClaimIds.length !== value.claimIds.length ||
		value.task.expectedClaimIds.some((claimId) => !value.claimIds.includes(claimId))
	) {
		throw new Error(`expert-transfer task claim mismatch: ${value.validationId}`);
	}
	const control = value.attempts.find((attempt) => attempt.arm === "control");
	const learned = value.attempts.find((attempt) => attempt.arm === "learned");
	if (value.attempts.length !== 2 || !control || !learned) {
		throw new Error(`expert-transfer validation requires one paired attempt: ${value.validationId}`);
	}
	const sameModel = control.model.provider === learned.model.provider && control.model.id === learned.model.id;
	for (const attempt of value.attempts) {
		if (attempt.metrics.qualityScore < 0 || attempt.metrics.qualityScore > 1) {
			throw new Error(`expert-transfer quality score is out of range: ${value.validationId}`);
		}
		for (const gate of value.task.hardGates) {
			if (typeof attempt.metrics.hardGates[gate] !== "boolean") {
				throw new Error(`expert-transfer attempt omitted hard gate '${gate}': ${value.validationId}`);
			}
		}
	}
	const qualifies =
		sameModel &&
		learned.metrics.completed &&
		value.task.hardGates.every((gate) => learned.metrics.hardGates[gate]) &&
		learned.toolCalls.filter((tool) => tool === "expert_cases_search").length === 1 &&
		value.claimIds.every((claimId) => learned.usedClaimIds.includes(claimId)) &&
		learned.metrics.qualityScore > control.metrics.qualityScore &&
		value.reasons.length === 0;
	if (value.decision !== (qualifies ? "transfer_validated" : "rejected")) {
		throw new Error(`expert-transfer decision mismatch: ${value.validationId}`);
	}
}

export function saveExpertTransferValidation(
	cwd: string,
	validation: ExpertTransferValidation,
): ExpertTransferValidation {
	validateTransferValidation(validation);
	writeImmutable(join(expertCasesRoot(cwd), "transfer-validations", `${validation.validationId}.json`), validation);
	return validation;
}

export function listExpertTransferValidations(cwd: string): ExpertTransferValidation[] {
	const directory = join(expertCasesRoot(cwd), "transfer-validations");
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((file) => /^transfer-[a-f0-9]{24}\.json$/.test(file))
		.map((file) => {
			const value = JSON.parse(readFileSync(join(directory, file), "utf-8")) as ExpertTransferValidation;
			validateTransferValidation(value);
			return value;
		})
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function auditExpertTransferValidations(cwd: string): {
	validations: number;
	valid: number;
	transferValidated: number;
	currentProtocolValidations: number;
	currentProtocolTransferValidated: number;
	currentProtocolLearnedClaimIds: number;
} {
	const validations = listExpertTransferValidations(cwd);
	const currentProtocol = validations.filter((validation) => validation.task.protocolVersion === 2);
	const currentProtocolPassed = currentProtocol.filter((validation) => validation.decision === "transfer_validated");
	return {
		validations: validations.length,
		valid: validations.length,
		transferValidated: validations.filter((validation) => validation.decision === "transfer_validated").length,
		currentProtocolValidations: currentProtocol.length,
		currentProtocolTransferValidated: currentProtocolPassed.length,
		currentProtocolLearnedClaimIds: new Set(currentProtocolPassed.flatMap((validation) => validation.claimIds)).size,
	};
}
