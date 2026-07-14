import { createHash } from "node:crypto";

export const EXPERT_CASE_SCHEMA_VERSION: 1 = 1;
export const EXPERT_LEARNING_SCHEMA_VERSION: 1 = 1;
export const EXPERT_TRANSFER_SCHEMA_VERSION: 1 = 1;
export const EXPERT_TRANSFER_PROTOCOL_VERSION: 2 = 2;

export type ExpertCaseSplit = "train" | "calibration" | "held_out";

export interface KpFact {
	src: string;
	rel: string;
	dst: string;
	fact: string;
	state: string;
}

export interface TicketSnapshot {
	key: string;
	type: string;
	status: string;
	title: string;
	taskText: string;
	createdAtLocal?: string;
	resolvedAtLocal?: string;
	sourceLocator: string;
	snapshotPath: string;
	snapshotHash: string;
}

export interface RepositoryDescriptor {
	repository: string;
	root: string;
	branch?: string;
}

export interface CommitEvidence {
	hash: string;
	parents: string[];
	authorDate: string;
	committerDate: string;
	summary: string;
	changedPaths: string[];
	kind: "pull_request_merge" | "direct" | "revert" | "branch_sync";
	pullRequestId?: string;
}

export interface GitChangeSet {
	changeSetId: string;
	kind: CommitEvidence["kind"];
	pullRequestId?: string;
	preChangeRevision: string;
	postChangeRevision: string;
	commits: CommitEvidence[];
	changedPaths: string[];
	testPaths: string[];
	firstImplementationAt: string;
	lastImplementationAt: string;
}

export interface RepositoryOutcome {
	repository: string;
	root: string;
	preChangeRevision: string;
	postChangeRevision: string;
	commits: CommitEvidence[];
	changeSets: GitChangeSet[];
	changedPaths: string[];
	testPaths: string[];
	verificationHints: string[];
	firstImplementationAt: string;
	lastImplementationAt: string;
	linkage: {
		method: "exact_ticket_key_in_commit_summary" | "authoritative_bitbucket_pr_to_merge_commit";
		confidence: "high" | "medium" | "low";
		reasons: string[];
	};
}

export interface ExpertCasePublic {
	schemaVersion: typeof EXPERT_CASE_SCHEMA_VERSION;
	caseId: string;
	ticket: TicketSnapshot;
	split: ExpertCaseSplit;
	repositories: Array<{ repository: string; preChangeRevision: string }>;
	temporalCutoff?: string;
	eligibility: {
		learning: boolean;
		leakageFreeEvaluation: boolean;
		reasons: string[];
	};
	contentHash: string;
}

export interface ExpertCaseSealed {
	schemaVersion: typeof EXPERT_CASE_SCHEMA_VERSION;
	caseId: string;
	publicCaseHash: string;
	kpFacts: KpFact[];
	outcomes: RepositoryOutcome[];
	contentHash: string;
}

export interface ExpertCaseRef {
	caseId: string;
	ticketKey: string;
	split: ExpertCaseSplit;
	publicHash: string;
	sealedHash: string;
}

export interface ExpertCaseManifest {
	schemaVersion: typeof EXPERT_CASE_SCHEMA_VERSION;
	manifestId: string;
	groupId: string;
	sourceFingerprint: string;
	sources: {
		ticketDirectory: string;
		ticketCorpusHash: string;
		repositories: Array<{ repository: string; root: string; head: string }>;
	};
	cases: ExpertCaseRef[];
	stats: {
		ticketsSeen: number;
		linkedTickets: number;
		unlinkedTickets: number;
		cases: number;
		repositories: number;
		multiRepositoryCases: number;
		learningReadyCases: number;
		evaluationReadyCases: number;
		kpFactCoverage: number;
		linkageConfidence: Record<"high" | "medium" | "low", number>;
		bySplit: Record<ExpertCaseSplit, number>;
	};
	contentHash: string;
}

export interface BitbucketRepositoryDescriptor {
	repository: string;
	workspace: string;
	slug: string;
}

export interface BitbucketPullRequestEvidence {
	repository: string;
	id: number;
	title: string;
	sourceBranch: string;
	destinationBranch: string;
	updatedOn: string;
	url: string;
	ticketKeys: string[];
	descriptionOnlyTicketKeys: string[];
}

export interface BitbucketTicketLinkage {
	ticketKey: string;
	repositories: string[];
	pullRequests: Array<
		Pick<BitbucketPullRequestEvidence, "repository" | "id" | "title" | "destinationBranch" | "updatedOn" | "url">
	>;
	snapshotAvailable: boolean;
	expertCaseRepositories: string[];
	expertCaseCoverage: "complete" | "partial" | "missing";
}

export interface BitbucketLinkageAudit {
	schemaVersion: 1;
	auditId: string;
	sourceFingerprint: string;
	sources: {
		repositories: BitbucketRepositoryDescriptor[];
		latestLimit: number;
		ticketPrefixes: string[];
		basedOnAuditId?: string;
		expertManifestHash?: string;
	};
	window: {
		newestUpdatedOn?: string;
		oldestUpdatedOn?: string;
	};
	stats: {
		historicalReleasePullRequests: number;
		latestPullRequests: number;
		latestWithAuthoritativeTicket: number;
		latestWithoutAuthoritativeTicket: number;
		latestWithDescriptionOnlyTicket: number;
		latestWithMultipleTickets: number;
		uniqueTickets: number;
		multiRepositoryTickets: number;
		ticketsWithSnapshot: number;
		ticketsWithExpertCase: number;
		completeExpertCaseCoverage: number;
		partialExpertCaseCoverage: number;
	};
	tickets: BitbucketTicketLinkage[];
	contentHash: string;
}

export type ExpertLearningClaimType = "implementation_pattern" | "rationale" | "contract" | "test_strategy";

export interface ExpertLearningEvidence {
	evidenceId: string;
	caseId: string;
	ticketKey: string;
	kind: "ticket" | "kp_fact" | "change_set" | "changed_path" | "test_path";
	locator: string;
	value: string;
	repositories: string[];
}

export interface ExpertLearningCase {
	caseId: string;
	ticketKey: string;
	title: string;
	repositories: string[];
	evidence: ExpertLearningEvidence[];
}

export interface ExpertLearningPacket {
	schemaVersion: typeof EXPERT_LEARNING_SCHEMA_VERSION;
	sourceManifestId: string;
	sourceManifestHash: string;
	query: string;
	cases: ExpertLearningCase[];
	contentHash: string;
}

export interface ExpertLearningClaim {
	claimId: string;
	type: ExpertLearningClaimType;
	statement: string;
	confidence: number;
	evidenceIds: string[];
	scope: { repositories: string[] };
	state: "proposed";
	authority: "strong_model" | "deterministic";
	evidenceStrength: "semantic" | "structural";
	contentHash: string;
}

export interface ExpertLearningRejectedClaim {
	index: number;
	reasons: string[];
	value: unknown;
}

export interface ExpertLearningRun {
	schemaVersion: typeof EXPERT_LEARNING_SCHEMA_VERSION;
	runId: string;
	createdAt: string;
	mode: "shadow";
	executedVia: "pi-rpc" | "local-deterministic" | "governed-review";
	model: { provider: string; id: string };
	packet: ExpertLearningPacket;
	promptHash: string;
	rawOutput: string;
	claims: ExpertLearningClaim[];
	rejectedClaims: ExpertLearningRejectedClaim[];
	validation: {
		status: "passed" | "failed";
		publicationGate: "eligible" | "blocked";
		published: false;
		errors: string[];
	};
	contentHash: string;
}

export type ExpertTransferArm = "control" | "learned";

export interface ExpertTransferTaskInput {
	taskId: string;
	goal: string;
	query: string;
	fixtureDir: string;
	judgeCommand: string[];
	hardGates: string[];
	expectedClaimIds?: string[];
	timeoutMs?: number;
}

export interface ExpertTransferTaskSnapshot {
	protocolVersion?: number;
	taskId: string;
	goal: string;
	query: string;
	fixtureHash: string;
	judgeCommand: string[];
	judgeHash: string;
	hardGates: string[];
	expectedClaimIds: string[];
	timeoutMs: number;
	contentHash: string;
}

export interface ExpertTransferAttempt {
	arm: ExpertTransferArm;
	startedAt: string;
	finishedAt: string;
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
	assistantHash: string;
	judgeOutputHash: string;
	error?: string;
}

export interface ExpertTransferValidation {
	schemaVersion: typeof EXPERT_TRANSFER_SCHEMA_VERSION;
	validationId: string;
	createdAt: string;
	sourceManifestId: string;
	sourceManifestHash: string;
	task: ExpertTransferTaskSnapshot;
	claimIds: string[];
	sourceTicketKeys: string[];
	attempts: ExpertTransferAttempt[];
	decision: "transfer_validated" | "rejected";
	reasons: string[];
	contentHash: string;
}

function normalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, normalize(entry)]),
		);
	}
	return value;
}

export function expertStableJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

export function expertHash(value: unknown): string {
	return createHash("sha256").update(expertStableJson(value)).digest("hex");
}
