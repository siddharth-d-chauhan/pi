import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expertHash } from "./contracts.ts";
import {
	expertCasesRoot,
	listExpertLearningRuns,
	listExpertTransferValidations,
	loadActiveExpertManifest,
	loadExpertCase,
} from "./store.ts";

const STOP = new Set([
	"add",
	"about",
	"after",
	"and",
	"are",
	"before",
	"bug",
	"change",
	"check",
	"could",
	"create",
	"fix",
	"for",
	"from",
	"have",
	"implement",
	"inside",
	"into",
	"issue",
	"make",
	"must",
	"not",
	"only",
	"please",
	"problem",
	"repo",
	"repository",
	"should",
	"solve",
	"that",
	"the",
	"their",
	"there",
	"these",
	"this",
	"update",
	"use",
	"using",
	"was",
	"were",
	"when",
	"while",
	"will",
	"with",
	"work",
]);

function terms(value: string): Set<string> {
	return new Set((value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((term) => !STOP.has(term)));
}

export function expertSearchTerms(value: string): string[] {
	return [...terms(value)];
}

export interface ExpertCaseSearchHit {
	ticketKey: string;
	title: string;
	split: string;
	score: number;
	repositories: string[];
	changedPaths: string[];
	testPaths: string[];
	facts: string[];
}

export interface ExpertLearningClaimHit {
	claimId: string;
	runId: string;
	equivalentClaimIds: string[];
	runIds: string[];
	type: string;
	statement: string;
	confidence: number;
	state: "proposed";
	authority: "strong_model" | "deterministic";
	evidenceStrength: "semantic" | "structural";
	repositories: string[];
	ticketKeys: string[];
	sourceTitles: string[];
	learningStatus: "remembered" | "transfer_validated";
	validationIds: string[];
	score: number;
}

type IndexedCase = Omit<ExpertCaseSearchHit, "score"> & { searchTerms: string[] };
type IndexedClaim = Omit<ExpertLearningClaimHit, "score"> & { searchTerms: string[] };

interface ExpertSearchIndex {
	schemaVersion: 1;
	builderVersion: 4;
	stateKey: string;
	manifestHash: string;
	cases: IndexedCase[];
	claims: IndexedClaim[];
	contentHash: string;
}

const searchIndexCache = new Map<string, ExpertSearchIndex>();
const SEARCH_INDEX_BUILDER_VERSION = 4 as const;

function sourceFileNames(cwd: string, directory: string, pattern: RegExp): string[] {
	const path = join(expertCasesRoot(cwd), directory);
	if (!existsSync(path)) return [];
	return readdirSync(path)
		.filter((file) => pattern.test(file))
		.sort();
}

function searchIndexStateKey(cwd: string, manifestHash: string): string {
	return expertHash({
		builderVersion: SEARCH_INDEX_BUILDER_VERSION,
		manifestHash,
		learningRuns: sourceFileNames(cwd, "learning-runs", /^learning-[a-f0-9]{24}\.json$/),
		transferValidations: sourceFileNames(cwd, "transfer-validations", /^transfer-[a-f0-9]{24}\.json$/),
	});
}

function buildSearchIndex(
	cwd: string,
	manifest: NonNullable<ReturnType<typeof loadActiveExpertManifest>>,
	stateKey: string,
): ExpertSearchIndex {
	const validationIdsByClaim = new Map<string, string[]>();
	for (const validation of listExpertTransferValidations(cwd)) {
		if (
			validation.decision !== "transfer_validated" ||
			validation.task.protocolVersion !== 2 ||
			validation.sourceManifestHash !== manifest.contentHash
		) {
			continue;
		}
		for (const claimId of validation.claimIds) {
			validationIdsByClaim.set(claimId, [...(validationIdsByClaim.get(claimId) ?? []), validation.validationId]);
		}
	}
	const byStatement = new Map<string, IndexedClaim>();
	for (const run of listExpertLearningRuns(cwd)) {
		if (run.validation.status !== "passed" || run.packet.sourceManifestHash !== manifest.contentHash) continue;
		const evidenceById = new Map(
			run.packet.cases.flatMap((item) => item.evidence).map((item) => [item.evidenceId, item]),
		);
		const caseById = new Map(run.packet.cases.map((item) => [item.caseId, item]));
		for (const claim of run.claims) {
			const ticketKeys = [
				...new Set(
					claim.evidenceIds
						.map((evidenceId) => evidenceById.get(evidenceId)?.ticketKey)
						.filter((ticketKey): ticketKey is string => ticketKey !== undefined),
				),
			];
			const sourceTitles = [
				...new Set(
					claim.evidenceIds
						.map((evidenceId) => evidenceById.get(evidenceId)?.caseId)
						.filter((caseId): caseId is string => caseId !== undefined)
						.map((caseId) => caseById.get(caseId)?.title)
						.filter((title): title is string => title !== undefined),
				),
			];
			const hit: IndexedClaim = {
				claimId: claim.claimId,
				runId: run.runId,
				equivalentClaimIds: [claim.claimId],
				runIds: [run.runId],
				type: claim.type,
				statement: claim.statement,
				confidence: claim.confidence,
				state: claim.state,
				authority: claim.authority,
				evidenceStrength: claim.evidenceStrength,
				repositories: claim.scope.repositories,
				ticketKeys,
				sourceTitles,
				learningStatus: validationIdsByClaim.has(claim.claimId) ? "transfer_validated" : "remembered",
				validationIds: validationIdsByClaim.get(claim.claimId) ?? [],
				searchTerms: [
					...terms(`${claim.statement} ${claim.scope.repositories.join(" ")} ${sourceTitles.join(" ")}`),
				],
			};
			const key = `${claim.type}\0${claim.statement}\0${claim.scope.repositories.join("\0")}`;
			const previous = byStatement.get(key);
			if (!previous) {
				byStatement.set(key, hit);
				continue;
			}
			const preferred = hit.confidence > previous.confidence ? hit : previous;
			byStatement.set(key, {
				...preferred,
				equivalentClaimIds: [...new Set([...previous.equivalentClaimIds, claim.claimId])].sort(),
				runIds: [...new Set([...previous.runIds, run.runId])].sort(),
				ticketKeys: [...new Set([...previous.ticketKeys, ...ticketKeys])].sort(),
				sourceTitles: [...new Set([...previous.sourceTitles, ...sourceTitles])].sort(),
				searchTerms: [
					...terms(
						`${claim.statement} ${claim.scope.repositories.join(" ")} ${[...previous.sourceTitles, ...sourceTitles].join(" ")}`,
					),
				],
			});
		}
	}
	const claims = [...byStatement.values()].map((hit) => {
		const validationIds = [
			...new Set(hit.equivalentClaimIds.flatMap((claimId) => validationIdsByClaim.get(claimId) ?? [])),
		].sort();
		return {
			...hit,
			learningStatus: hit.equivalentClaimIds.every((claimId) => validationIdsByClaim.has(claimId))
				? ("transfer_validated" as const)
				: ("remembered" as const),
			validationIds,
		};
	});
	const cases: IndexedCase[] = [];
	for (const ref of manifest.cases) {
		const { publicCase, sealedCase } = loadExpertCase(cwd, ref.caseId);
		if (sealedCase.outcomes.some((outcome) => outcome.linkage.confidence === "low")) continue;
		const facts = sealedCase.kpFacts
			.filter((fact) => fact.state === "confirmed" || fact.state === "supported")
			.map((fact) => fact.fact);
		const changedPaths = [...new Set(sealedCase.outcomes.flatMap((outcome) => outcome.changedPaths))];
		const text = [publicCase.ticket.title, publicCase.ticket.taskText, ...facts, ...changedPaths].join(" ");
		cases.push({
			ticketKey: publicCase.ticket.key,
			title: publicCase.ticket.title,
			split: publicCase.split,
			repositories: sealedCase.outcomes.map((outcome) => outcome.repository),
			changedPaths: changedPaths.slice(0, 12),
			testPaths: [...new Set(sealedCase.outcomes.flatMap((outcome) => outcome.testPaths))].slice(0, 8),
			facts: facts.slice(0, 3),
			searchTerms: [...terms(text)],
		});
	}
	const core = {
		schemaVersion: 1 as const,
		builderVersion: SEARCH_INDEX_BUILDER_VERSION,
		stateKey,
		manifestHash: manifest.contentHash,
		cases,
		claims,
	};
	return { ...core, contentHash: expertHash(core) };
}

function loadSearchIndex(cwd: string): ExpertSearchIndex | undefined {
	const manifest = loadActiveExpertManifest(cwd);
	if (!manifest) return undefined;
	const stateKey = searchIndexStateKey(cwd, manifest.contentHash);
	const cached = searchIndexCache.get(cwd);
	if (cached?.stateKey === stateKey) return cached;
	const path = join(expertCasesRoot(cwd), "search-index-v1.json");
	if (existsSync(path)) {
		try {
			const value = JSON.parse(readFileSync(path, "utf-8")) as ExpertSearchIndex;
			const { contentHash, ...core } = value;
			if (
				value.schemaVersion === 1 &&
				value.builderVersion === SEARCH_INDEX_BUILDER_VERSION &&
				value.stateKey === stateKey &&
				value.manifestHash === manifest.contentHash &&
				Array.isArray(value.cases) &&
				Array.isArray(value.claims) &&
				expertHash(core) === contentHash
			) {
				searchIndexCache.set(cwd, value);
				return value;
			}
		} catch {
			// Derived cache is rebuilt from immutable source records below.
		}
	}
	const index = buildSearchIndex(cwd, manifest, stateKey);
	searchIndexCache.set(cwd, index);
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(index)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch {
		try {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		} catch {
			// Best-effort cleanup of a derived cache file.
		}
		// Retrieval remains available from the in-memory index when the cache is read-only.
	}
	return index;
}

function excludedTicketKeys(query: string): Set<string> {
	return new Set((query.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []).map((key) => key.toUpperCase()));
}

function scoreTerms(queryTerms: Set<string>, candidateTerms: string[]): number {
	let score = 0;
	const candidates = new Set(candidateTerms);
	for (const term of queryTerms) if (candidates.has(term)) score += 1;
	return score;
}

export function warmExpertSearchIndex(cwd: string): boolean {
	return loadSearchIndex(cwd) !== undefined;
}

export function listExpertLearningClaims(cwd: string): ExpertLearningClaimHit[] {
	const index = loadSearchIndex(cwd);
	if (!index) return [];
	return index.claims.map(({ searchTerms: _searchTerms, ...hit }) => ({ ...hit, score: 0 }));
}

export function searchExpertLearningClaims(cwd: string, query: string, limit = 5): ExpertLearningClaimHit[] {
	const index = loadSearchIndex(cwd);
	if (!index) return [];
	const queryTerms = terms(query);
	const excludedKeys = excludedTicketKeys(query);
	const minimumScore = queryTerms.size >= 2 ? 2 : 1;
	return index.claims
		.filter((hit) => !hit.ticketKeys.some((ticketKey) => excludedKeys.has(ticketKey.toUpperCase())))
		.map(({ searchTerms, ...hit }) => ({ ...hit, score: scoreTerms(queryTerms, searchTerms) }))
		.filter((hit) => hit.score >= minimumScore)
		.sort((left, right) => right.score - left.score || right.confidence - left.confidence)
		.slice(0, Math.max(1, Math.min(limit, 20)));
}

export function searchExpertCases(cwd: string, query: string, limit = 5): ExpertCaseSearchHit[] {
	const index = loadSearchIndex(cwd);
	if (!index) return [];
	const queryTerms = terms(query);
	const excludedKeys = excludedTicketKeys(query);
	return index.cases
		.filter((hit) => !excludedKeys.has(hit.ticketKey.toUpperCase()))
		.map(({ searchTerms, ...hit }) => ({ ...hit, score: scoreTerms(queryTerms, searchTerms) }))
		.filter((hit) => hit.score > 0)
		.sort((left, right) => right.score - left.score || right.ticketKey.localeCompare(left.ticketKey))
		.slice(0, Math.max(1, Math.min(limit, 20)));
}
