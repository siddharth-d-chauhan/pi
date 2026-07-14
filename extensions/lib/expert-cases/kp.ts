import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callKp } from "../kp-bridge.ts";
import { expertHash } from "./contracts.ts";
import { listExpertLearningClaims } from "./search.ts";
import { expertCasesRoot, loadActiveExpertManifest } from "./store.ts";

const KP_EXPERT_PROJECT = "expert-cases";
const KP_SYNC_SCHEMA_VERSION = 1 as const;

export interface ExpertKpSearchResult {
	query: string;
	group?: string;
	project?: string;
	returned?: number;
	hits?: Array<{ fact?: string; state?: string }>;
}

export interface ExpertKpSyncResult {
	stateKey?: string;
	total: number;
	supported: number;
	unchanged: number;
	failed: number;
	skipped: boolean;
}

interface ExpertKpSyncLedger extends ExpertKpSyncResult {
	schemaVersion: typeof KP_SYNC_SCHEMA_VERSION;
	manifestHash: string;
}

function ledgerPath(cwd: string): string {
	return join(expertCasesRoot(cwd), "kp-sync-v1.json");
}

function readLedger(cwd: string): ExpertKpSyncLedger | undefined {
	const path = ledgerPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf-8")) as ExpertKpSyncLedger;
		return value.schemaVersion === KP_SYNC_SCHEMA_VERSION ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeLedger(cwd: string, value: ExpertKpSyncLedger): void {
	const path = ledgerPath(cwd);
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
		chmodSync(path, 0o600);
	} catch (error) {
		try {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		} catch {
			// Best-effort cleanup; KP already has the successfully written facts.
		}
		throw error;
	}
}

export async function searchExpertKnowledgeInKp(
	query: string,
	limit: number,
	timeoutMs: number,
): Promise<ExpertKpSearchResult | undefined> {
	const result = await callKp<ExpertKpSearchResult>(
		"knowledge.search",
		{
			query,
			include_proposed: false,
			recipe: "hot",
			project: KP_EXPERT_PROJECT,
			limit: Math.max(1, Math.min(limit, 20)),
		},
		timeoutMs,
	);
	if (!result?.hits) return result;
	const targetTicketKeys = new Set(query.toUpperCase().match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []);
	const hits = result.hits
		.filter((hit) => {
			const fact = hit.fact?.toUpperCase() ?? "";
			return [...targetTicketKeys].every((ticketKey) => !fact.includes(ticketKey));
		})
		.map((hit) => ({ ...hit, fact: hit.fact?.slice(0, 1_500) }));
	return { ...result, returned: hits.length, hits };
}

export async function syncTransferValidatedPoliciesToKp(
	cwd: string,
	timeoutMs: number,
	force = false,
): Promise<ExpertKpSyncResult> {
	const manifest = loadActiveExpertManifest(cwd);
	if (!manifest) return { total: 0, supported: 0, unchanged: 0, failed: 0, skipped: true };
	const policies = listExpertLearningClaims(cwd).filter((claim) => claim.learningStatus === "transfer_validated");
	const stateKey = expertHash({
		manifestHash: manifest.contentHash,
		policies: policies.map((claim) => ({
			claimIds: claim.equivalentClaimIds,
			validationIds: claim.validationIds,
		})),
	});
	const previous = readLedger(cwd);
	if (!force && previous?.stateKey === stateKey && previous.failed === 0) {
		return { ...previous, skipped: true };
	}

	let supported = 0;
	let unchanged = 0;
	let failed = 0;
	for (const policy of policies) {
		const response = await callKp<{ decision?: string; queued?: boolean; reconciliation?: string }>(
			"pi.memory_writeback",
			{
				kind: policy.type === "testing_strategy" || policy.type === "test_strategy" ? "procedure" : "knowledge",
				summary: `Transfer-validated expert policy: ${policy.statement}`,
				text: [
					`Repositories: ${policy.repositories.join(", ") || "unspecified"}`,
					`Source Jira: ${policy.ticketKeys.join(", ") || "unspecified"}`,
				].join("\n"),
				project: KP_EXPERT_PROJECT,
				inject_class: "SEARCH_ONLY",
				evidence: {
					gates: policy.validationIds.map(
						(validationId) => `paired same-model hidden-judge transfer gate passed: ${validationId}`,
					),
				},
				metadata: {
					source: "pi-expert-cases",
					sourceManifestId: manifest.manifestId,
					claimIds: policy.equivalentClaimIds,
					validationIds: policy.validationIds,
					ticketLocators: policy.ticketKeys.map((key) => `jira://${key}`),
				},
			},
			timeoutMs,
		);
		if (response?.decision !== "supported" || !response.queued) {
			failed += 1;
			continue;
		}
		if (response.reconciliation === "NOOP") unchanged += 1;
		else supported += 1;
	}

	const result: ExpertKpSyncResult = {
		stateKey,
		total: policies.length,
		supported,
		unchanged,
		failed,
		skipped: false,
	};
	if (failed === 0) {
		writeLedger(cwd, {
			...result,
			schemaVersion: KP_SYNC_SCHEMA_VERSION,
			manifestHash: manifest.contentHash,
		});
	}
	return result;
}
