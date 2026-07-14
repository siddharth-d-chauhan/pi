import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExpertLearningClaim, ExpertTransferTaskInput } from "./contracts.ts";
import { searchExpertLearningClaims } from "./search.ts";
import { listExpertLearningRuns, listExpertTransferValidations, loadActiveExpertManifest } from "./store.ts";
import { runExpertTransferEvaluation } from "./transfer.ts";

interface ClaimGroup {
	key: string;
	type: ExpertLearningClaim["type"];
	statement: string;
	authority: ExpertLearningClaim["authority"];
	evidenceStrength: ExpertLearningClaim["evidenceStrength"];
	repositories: string[];
	claimIds: string[];
	ticketKeys: string[];
	sourceTitles: string[];
}

interface PolicyScenario {
	input: Record<string, unknown>;
	expected: string[];
}

interface SemanticTaskSpec {
	claimId: string;
	slug: string;
	label: string;
	actions: string[];
	scenarios: PolicyScenario[];
}

export interface ExpertTransferAllProgress {
	completed: number;
	total: number;
	taskId: string;
	decision: "transfer_validated" | "rejected" | "skipped";
}

export interface ExpertTransferAllResult {
	groups: number;
	claimIds: number;
	alreadyValidated: number;
	skipped: number;
	transferValidated: number;
	rejected: number;
	validatedClaimIds: number;
	rejectedClaimIds: number;
	validationIds: string[];
}

function isOperationalFailure(validation: ReturnType<typeof listExpertTransferValidations>[number]): boolean {
	return (
		validation.attempts.some((attempt) => attempt.error !== undefined) ||
		validation.reasons.some(
			(reason) =>
				reason === "control and learned arms used different models" ||
				reason === "learned arm did not call expert_cases_search exactly once",
		)
	);
}

export interface ExpertTransferPlanAudit {
	groups: number;
	claimIds: number;
	tasks: number;
	issues: Array<{ taskId: string; reason: string }>;
}

const SEMANTIC_TASKS: SemanticTaskSpec[] = [
	{
		claimId: "claim-6a3c147006649b0c9142aa6e",
		slug: "backend-security-validation",
		label: "security-sensitive configuration validation",
		actions: ["backend_validate", "field_specific_errors"],
		scenarios: [
			{
				input: { sensitive: true, frontendAccepted: true, invalidFields: ["origin"] },
				expected: ["backend_validate", "field_specific_errors"],
			},
			{ input: { sensitive: false, frontendAccepted: true, invalidFields: [] }, expected: [] },
		],
	},
	{
		claimId: "claim-00797a698d33136534572c33",
		slug: "frame-ancestor-policy",
		label: "frame-ancestor response policy",
		actions: ["validate_origins", "emit_admin", "emit_sso", "fallback_self"],
		scenarios: [
			{
				input: { configuredOrigins: ["https://portal.example"], pages: ["admin", "sso"] },
				expected: ["validate_origins", "emit_admin", "emit_sso"],
			},
			{
				input: { configuredOrigins: [], pages: ["admin", "sso"] },
				expected: ["emit_admin", "emit_sso", "fallback_self"],
			},
		],
	},
	{
		claimId: "claim-09ee6d63ddd3ead5c36e0475",
		slug: "audit-publication-reporting",
		label: "administrative and domain event auditing",
		actions: ["publish_audit", "searchable", "filterable", "exportable"],
		scenarios: [
			{
				input: { eventKind: "administrative" },
				expected: ["publish_audit", "searchable", "filterable", "exportable"],
			},
			{ input: { eventKind: "domain" }, expected: ["publish_audit", "searchable", "filterable", "exportable"] },
		],
	},
	{
		claimId: "claim-1180b1670cb75f774ceeb0f9",
		slug: "privileged-audit-context",
		label: "privileged operation audit context",
		actions: ["record_actor", "record_action", "record_target", "admin_report"],
		scenarios: [
			{
				input: { operation: "impersonation" },
				expected: ["record_actor", "record_action", "record_target", "admin_report"],
			},
			{
				input: { operation: "idp_administration" },
				expected: ["record_actor", "record_action", "record_target", "admin_report"],
			},
		],
	},
	{
		claimId: "claim-da5c5a6e54df6f8b17d1f01d",
		slug: "push-transaction-reset",
		label: "push-authentication transaction lifecycle",
		actions: ["clear_prior_transaction", "stop_old_polling"],
		scenarios: [
			{
				input: { startingNewRequest: true, priorTransactionTracked: true },
				expected: ["clear_prior_transaction", "stop_old_polling"],
			},
			{ input: { startingNewRequest: false, priorTransactionTracked: true }, expected: [] },
		],
	},
	{
		claimId: "claim-2ffa5e0268ffcd884690435c",
		slug: "authentication-notification-audience",
		label: "authentication state-change notification routing",
		actions: ["notify_user", "notify_admin"],
		scenarios: [
			{ input: { event: "account_lock" }, expected: ["notify_user"] },
			{ input: { event: "identity_failure" }, expected: ["notify_admin"] },
			{ input: { event: "license_failure" }, expected: ["notify_admin"] },
		],
	},
	{
		claimId: "claim-f5f8c1954d227ff05e5af214",
		slug: "authentication-source-context",
		label: "authentication-source context propagation",
		actions: ["carry_validated_claims", "carry_originating_application"],
		scenarios: [
			{ input: { source: "token" }, expected: ["carry_validated_claims"] },
			{ input: { source: "application" }, expected: ["carry_originating_application"] },
		],
	},
	{
		claimId: "claim-98b8973e89c0cc4df99f9aed",
		slug: "broker-idp-discovery",
		label: "broker identity-provider discovery",
		actions: ["central_lookup", "explicit_precedence", "remove_duplicate_branches"],
		scenarios: [
			{
				input: { candidates: 3, legacyBranches: 2 },
				expected: ["central_lookup", "explicit_precedence", "remove_duplicate_branches"],
			},
		],
	},
	{
		claimId: "claim-68528380bb53c0f46deb2b40",
		slug: "quick-social-setup",
		label: "quick social-login connection setup",
		actions: ["minimize_setup_steps"],
		scenarios: [
			{ input: { connectionType: "quick_social" }, expected: ["minimize_setup_steps"] },
			{ input: { connectionType: "custom_enterprise" }, expected: [] },
		],
	},
	{
		claimId: "claim-56fa0b34f62c760eb9ded130",
		slug: "mfa-method-token-selection",
		label: "MFA method and backup-token selection",
		actions: ["configured_enabled_methods_only", "all_assigned_backup_tokens"],
		scenarios: [
			{ input: { operation: "select_methods" }, expected: ["configured_enabled_methods_only"] },
			{ input: { operation: "validate_backup_hardware" }, expected: ["all_assigned_backup_tokens"] },
		],
	},
	{
		claimId: "claim-104fa5eaa4f2c99badae3bb5",
		slug: "multi-token-test-boundaries",
		label: "multi-token MFA test coverage",
		actions: ["test_profile_configuration", "test_token_inventory_crud_assignment"],
		scenarios: [
			{
				input: { change: "multi_token_mfa" },
				expected: ["test_profile_configuration", "test_token_inventory_crud_assignment"],
			},
		],
	},
	{
		claimId: "claim-7617c68c2cecc2997a9c65b9",
		slug: "password-lifecycle-reverification",
		label: "password lifecycle and passwordless first-login behavior",
		actions: ["explicit_reverification", "preserve_broker_first_login", "preserve_external_directory_first_login"],
		scenarios: [
			{ input: { flow: "password_lifecycle_change" }, expected: ["explicit_reverification"] },
			{
				input: { flow: "broker_first_login" },
				expected: ["explicit_reverification", "preserve_broker_first_login"],
			},
			{
				input: { flow: "external_directory_first_login" },
				expected: ["explicit_reverification", "preserve_external_directory_first_login"],
			},
		],
	},
	{
		claimId: "claim-09b6af7a30ba691929c56377",
		slug: "password-lock-policy",
		label: "centrally configurable account lock and recovery policy",
		actions: [
			"central_password_policy",
			"lock_threshold",
			"timed_unlock",
			"lock_notification",
			"self_service_unlock",
		],
		scenarios: [
			{
				input: { policyArea: "account_recovery" },
				expected: [
					"central_password_policy",
					"lock_threshold",
					"timed_unlock",
					"lock_notification",
					"self_service_unlock",
				],
			},
		],
	},
	{
		claimId: "claim-3c8970abbc544497eb73ccb9",
		slug: "privileged-capability-impersonation",
		label: "privileged capability and impersonation governance",
		actions: ["explicit_capability", "traceable_session", "audit_record"],
		scenarios: [
			{ input: { feature: "privileged_admin" }, expected: ["explicit_capability"] },
			{
				input: { feature: "impersonation" },
				expected: ["explicit_capability", "traceable_session", "audit_record"],
			},
		],
	},
	{
		claimId: "claim-e92d1c83a288c83646f187bd",
		slug: "workflow-layer-separation",
		label: "workflow navigation, execution, and persistence separation",
		actions: ["capability_gated_navigation", "rule_engine_execution", "persistent_rule_configuration"],
		scenarios: [
			{ input: { layer: "administrator_navigation" }, expected: ["capability_gated_navigation"] },
			{ input: { layer: "rule_runtime" }, expected: ["rule_engine_execution"] },
			{ input: { layer: "rule_storage" }, expected: ["persistent_rule_configuration"] },
		],
	},
	{
		claimId: "claim-6deededc073f65ec4788e02d",
		slug: "user-event-rule-boundary",
		label: "rule-driven user event execution boundaries",
		actions: ["execute_on_create", "execute_on_update", "transform_attributes", "assign_group_or_role"],
		scenarios: [
			{
				input: { event: "user_create" },
				expected: ["execute_on_create", "transform_attributes", "assign_group_or_role"],
			},
			{
				input: { event: "user_update" },
				expected: ["execute_on_update", "transform_attributes", "assign_group_or_role"],
			},
		],
	},
	{
		claimId: "claim-1f6771cb2b9396a56d1f6a13",
		slug: "rule-trigger-action-model",
		label: "rule trigger/action model across user flows",
		actions: ["separate_trigger_and_action", "execute_create_flow", "execute_update_flow"],
		scenarios: [
			{ input: { event: "user_create" }, expected: ["separate_trigger_and_action", "execute_create_flow"] },
			{ input: { event: "user_update" }, expected: ["separate_trigger_and_action", "execute_update_flow"] },
		],
	},
	{
		claimId: "claim-e417e1b9b08a9b59a2122ec2",
		slug: "ad-service-ownership",
		label: "Active Directory and identity integration service ownership",
		actions: ["ad_via_provisioning_ldap", "idp_configuration_owner", "application_integration_owner"],
		scenarios: [
			{ input: { operation: "active_directory" }, expected: ["ad_via_provisioning_ldap"] },
			{ input: { operation: "identity_provider_configuration" }, expected: ["idp_configuration_owner"] },
			{ input: { operation: "application_integration" }, expected: ["application_integration_owner"] },
		],
	},
];

function sanitizeTaskText(value: string): string {
	return value
		.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function collectClaimGroups(cwd: string): ClaimGroup[] {
	const manifest = loadActiveExpertManifest(cwd);
	if (!manifest) throw new Error("no active expert-case manifest");
	const groups = new Map<string, ClaimGroup>();
	for (const run of listExpertLearningRuns(cwd)) {
		if (run.validation.status !== "passed" || run.packet.sourceManifestHash !== manifest.contentHash) continue;
		const evidenceById = new Map(
			run.packet.cases.flatMap((item) => item.evidence).map((evidence) => [evidence.evidenceId, evidence]),
		);
		const caseById = new Map(run.packet.cases.map((item) => [item.caseId, item]));
		for (const claim of run.claims) {
			const key = `${claim.type}\0${claim.statement}\0${claim.scope.repositories.join("\0")}`;
			const evidence = claim.evidenceIds
				.map((evidenceId) => evidenceById.get(evidenceId))
				.filter((item): item is NonNullable<typeof item> => item !== undefined);
			const ticketKeys = [...new Set(evidence.map((item) => item.ticketKey))];
			const sourceTitles = [
				...new Set(
					evidence
						.map((item) => caseById.get(item.caseId)?.title)
						.filter((title): title is string => title !== undefined),
				),
			];
			const previous = groups.get(key);
			groups.set(key, {
				key,
				type: claim.type,
				statement: claim.statement,
				authority: claim.authority,
				evidenceStrength: claim.evidenceStrength,
				repositories: claim.scope.repositories,
				claimIds: [...new Set([...(previous?.claimIds ?? []), claim.claimId])].sort(),
				ticketKeys: [...new Set([...(previous?.ticketKeys ?? []), ...ticketKeys])].sort(),
				sourceTitles: [...new Set([...(previous?.sourceTitles ?? []), ...sourceTitles])].sort(),
			});
		}
	}
	return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function writeSemanticTask(group: ClaimGroup, spec: SemanticTaskSpec): ExpertTransferTaskInput {
	const root = mkdtempSync(join(tmpdir(), `pi-semantic-${spec.slug}-`));
	const fixtureDir = join(root, "fixture");
	mkdirSync(fixtureDir);
	const actionObject = Object.fromEntries(spec.actions.map((action) => [action.toUpperCase(), action]));
	writeFileSync(join(fixtureDir, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		join(fixtureDir, "policy.js"),
		`export const ACTIONS = Object.freeze(${JSON.stringify(actionObject, null, 2)});\n\nexport const SCENARIOS = Object.freeze(${JSON.stringify(
			spec.scenarios.map((scenario) => scenario.input),
			null,
			2,
		)});\n\nexport function applyPolicy(scenario) {\n\treturn [];\n}\n`,
	);
	const judgePath = join(root, "judge.mjs");
	writeFileSync(
		judgePath,
		`import { resolve } from "node:path";\nimport { pathToFileURL } from "node:url";\nconst expected = ${JSON.stringify(spec.scenarios.map((scenario) => scenario.expected))};\nlet allowed = new Set();\nlet order = new Map();\nlet first = [];\nlet second = [];\nlet shape = true;\ntry {\n  const { ACTIONS, SCENARIOS, applyPolicy } = await import(pathToFileURL(resolve(process.cwd(), "policy.js")).href);\n  allowed = new Set(Object.values(ACTIONS));\n  order = new Map(Object.values(ACTIONS).map((action, index) => [action, index]));\n  first = SCENARIOS.map((scenario) => applyPolicy(scenario));\n  second = SCENARIOS.map((scenario) => applyPolicy(scenario));\n  shape = first.every((actions) => Array.isArray(actions) && actions.every((action) => allowed.has(action)) && new Set(actions).size === actions.length && actions.every((action, index) => index === 0 || order.get(actions[index - 1]) < order.get(action)));\n} catch {\n  shape = false;\n}\nconst correct = shape ? first.filter((actions, index) => JSON.stringify(actions) === JSON.stringify(expected[index])).length : 0;\nconst contract = correct === expected.length;\nconst deterministic = JSON.stringify(first) === JSON.stringify(second);\nconst qualityScore = Math.min(1, (shape ? 0.15 : 0) + (correct / expected.length) * 0.7 + (deterministic ? 0.15 : 0));\nconsole.log(JSON.stringify({ completed: shape && contract && deterministic, qualityScore, hardGates: { allowed_actions: shape, contract, deterministic } }));\n`,
	);
	return {
		taskId: `semantic-${spec.slug}-v1`,
		goal: `Complete applyPolicy in policy.js for ${spec.label}. For each exported SCENARIOS entry, return an ordered array containing only the ACTIONS values required by the established repository policy. Use ACTIONS declaration order and keep the result deterministic.`,
		query: group.statement,
		fixtureDir,
		judgeCommand: [process.execPath, judgePath],
		hardGates: ["allowed_actions", "contract", "deterministic"],
		expectedClaimIds: group.claimIds,
		timeoutMs: 300_000,
	};
}

function writeUuidTask(group: ClaimGroup): ExpertTransferTaskInput {
	const root = mkdtempSync(join(tmpdir(), "pi-semantic-uuid-matrix-"));
	const fixtureDir = join(root, "fixture");
	mkdirSync(fixtureDir);
	writeFileSync(join(fixtureDir, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		join(fixtureDir, "uuid-matrix.js"),
		'export const GUARANTEES = Object.freeze({ BACKFILL: "backfill", UNIQUE: "unique", NOT_NULL: "not_null" });\n\nexport function buildUuidMigrationMatrix() {\n\treturn {};\n}\n',
	);
	const judgePath = join(root, "judge.mjs");
	writeFileSync(
		judgePath,
		`import { resolve } from "node:path";\nimport { pathToFileURL } from "node:url";\nconst engines = ["mssql", "mysql", "orasql", "pgsql"];\nconst guarantees = ["backfill", "not_null", "unique"];\nlet first; let second;\ntry { const { buildUuidMigrationMatrix } = await import(pathToFileURL(resolve(process.cwd(), "uuid-matrix.js")).href); first = buildUuidMigrationMatrix(); second = buildUuidMigrationMatrix(); } catch { first = undefined; second = undefined; }\nconst shape = first !== null && typeof first === "object" && !Array.isArray(first) && Object.values(first).every((steps) => Array.isArray(steps) && steps.every((step) => typeof step === "string"));\nconst keys = shape ? Object.keys(first).sort() : [];\nconst engineCoverage = JSON.stringify(keys) === JSON.stringify(engines);\nconst correct = shape ? engines.filter((engine) => JSON.stringify([...new Set(first[engine] ?? [])].sort()) === JSON.stringify(guarantees)).length : 0;\nconst contract = correct === engines.length;\nconst deterministic = JSON.stringify(first) === JSON.stringify(second);\nconst qualityScore = Math.min(1, (shape ? 0.15 : 0) + (correct / engines.length) * 0.55 + (engineCoverage ? 0.15 : 0) + (deterministic ? 0.15 : 0));\nconsole.log(JSON.stringify({ completed: shape && engineCoverage && contract && deterministic, qualityScore, hardGates: { contract, deterministic, engine_coverage: engineCoverage } }));\n`,
	);
	return {
		taskId: "semantic-uuid-migration-matrix-v2",
		goal: "Complete buildUuidMigrationMatrix in uuid-matrix.js. Return the repository's production UUID migration contract as Record<engine, string[]> using the exported GUARANTEES values. Keep output deterministic and do not execute migrations.",
		query: group.statement,
		fixtureDir,
		judgeCommand: [process.execPath, judgePath],
		hardGates: ["contract", "deterministic", "engine_coverage"],
		expectedClaimIds: group.claimIds,
		timeoutMs: 300_000,
	};
}

function writeStructuralTask(group: ClaimGroup, index: number): ExpertTransferTaskInput {
	const match = group.statement.match(
		/^Historical changes in (.+?) repeatedly modify the (.+?) area for related implementation work\.$/,
	);
	const isTestStrategy = group.type === "test_strategy";
	if (!isTestStrategy && !match) throw new Error(`unsupported structural claim: ${group.statement}`);
	const repository = group.repositories[0] ?? match?.[1] ?? "repository";
	const targetArea = match?.[2];
	const sourceTitle = sanitizeTaskText(group.sourceTitles[0] ?? "related repository implementation change");
	const root = mkdtempSync(join(tmpdir(), `pi-structural-${index}-`));
	const fixtureDir = join(root, "fixture");
	mkdirSync(fixtureDir);
	writeFileSync(join(fixtureDir, "package.json"), '{"type":"module"}\n');
	writeFileSync(
		join(fixtureDir, "routing.js"),
		`export const CHANGE = Object.freeze(${JSON.stringify({ repository, description: sourceTitle }, null, 2)});\n\nexport function planChange() {\n\treturn { areas: [], includeFocusedTests: false };\n}\n`,
	);
	const judgePath = join(root, "judge.mjs");
	writeFileSync(
		judgePath,
		`import { resolve } from "node:path";\nimport { pathToFileURL } from "node:url";\nlet first; let second;\ntry { const { planChange } = await import(pathToFileURL(resolve(process.cwd(), "routing.js")).href); first = planChange(); second = planChange(); } catch { first = undefined; second = undefined; }\nconst shape = first !== null && typeof first === "object" && Array.isArray(first.areas) && first.areas.every((area) => typeof area === "string") && typeof first.includeFocusedTests === "boolean";\nconst targetPattern = ${isTestStrategy ? "shape && first.includeFocusedTests === true" : `shape && first.areas.includes(${JSON.stringify(targetArea)})`};\nconst deterministic = JSON.stringify(first) === JSON.stringify(second);\nconst qualityScore = Math.min(1, (shape ? 0.2 : 0) + (targetPattern ? 0.6 : 0) + (deterministic ? 0.2 : 0));\nconsole.log(JSON.stringify({ completed: shape && targetPattern && deterministic, qualityScore, hardGates: { deterministic, shape, target_pattern: targetPattern } }));\n`,
	);
	const query = `${repository} ${sourceTitle}`.trim();
	return {
		taskId: `structural-${index.toString().padStart(2, "0")}-${group.claimIds[0]!.slice("claim-".length, "claim-".length + 8)}-v1`,
		goal: `Complete planChange in routing.js for a new ${repository} change analogous to CHANGE.description. Return repository-relative areas likely to be modified and whether focused tests belong in the change. Keep the result minimal and deterministic.`,
		query,
		fixtureDir,
		judgeCommand: [process.execPath, judgePath],
		hardGates: ["deterministic", "shape", "target_pattern"],
		expectedClaimIds: group.claimIds,
		timeoutMs: 300_000,
	};
}

function buildTask(group: ClaimGroup, index: number): ExpertTransferTaskInput {
	if (group.evidenceStrength === "structural") return writeStructuralTask(group, index);
	if (group.claimIds.includes("claim-25c2f07bd788992773d865bb")) return writeUuidTask(group);
	const spec = SEMANTIC_TASKS.find((candidate) => group.claimIds.includes(candidate.claimId));
	if (!spec) throw new Error(`no semantic transfer task for ${group.claimIds.join(", ")}`);
	return writeSemanticTask(group, spec);
}

export function auditAllExpertTransferTasks(cwd: string): ExpertTransferPlanAudit {
	const groups = collectClaimGroups(cwd);
	const issues: ExpertTransferPlanAudit["issues"] = [];
	for (const [index, group] of groups.entries()) {
		let task: ExpertTransferTaskInput;
		try {
			task = buildTask(group, index);
		} catch (error) {
			issues.push({ taskId: `group-${index}`, reason: (error as Error).message });
			continue;
		}
		const matches = searchExpertLearningClaims(cwd, task.query, 20);
		const matchedIds = new Set(matches.flatMap((claim) => claim.equivalentClaimIds));
		const missing = group.claimIds.filter((claimId) => !matchedIds.has(claimId));
		if (missing.length > 0) {
			issues.push({ taskId: task.taskId, reason: `query missed ${missing.length} expected claim ids` });
		}
		const leakedTickets = group.ticketKeys.filter((ticketKey) =>
			`${task.goal}\n${task.query}`.toUpperCase().includes(ticketKey.toUpperCase()),
		);
		if (leakedTickets.length > 0) {
			issues.push({ taskId: task.taskId, reason: `task names source tickets: ${leakedTickets.join(", ")}` });
		}
	}
	return {
		groups: groups.length,
		claimIds: groups.reduce((sum, group) => sum + group.claimIds.length, 0),
		tasks: groups.length,
		issues,
	};
}

export async function runAllExpertTransferEvaluations(options: {
	cwd: string;
	concurrency?: number;
	retryOperationalFailures?: boolean;
	onProgress?: (progress: ExpertTransferAllProgress) => void;
}): Promise<ExpertTransferAllResult> {
	const concurrency = options.concurrency ?? 2;
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
		throw new Error("transfer-all concurrency must be between 1 and 3");
	}
	const groups = collectClaimGroups(options.cwd);
	const existing = listExpertTransferValidations(options.cwd);
	const built = groups.map((group, index) => ({ group, task: buildTask(group, index) }));
	const protocolTwoValidatedClaims = new Set(
		existing
			.filter((validation) => validation.decision === "transfer_validated" && validation.task.protocolVersion === 2)
			.flatMap((validation) => validation.claimIds),
	);
	const pending = built.filter(
		({ group }) => !group.claimIds.every((claimId) => protocolTwoValidatedClaims.has(claimId)),
	);
	const completedTaskIds = new Set(
		existing
			.filter(
				(validation) =>
					validation.task.protocolVersion === 2 &&
					(!options.retryOperationalFailures || !isOperationalFailure(validation)),
			)
			.map((validation) => validation.task.taskId),
	);
	const queue = pending.filter((item) => !completedTaskIds.has(item.task.taskId));
	const skipped = pending.length - queue.length;
	let cursor = 0;
	let completed = 0;
	const validations: Awaited<ReturnType<typeof runExpertTransferEvaluation>>[] = [];
	const worker = async () => {
		while (true) {
			const current = cursor;
			cursor += 1;
			const item = queue[current];
			if (!item) return;
			const validation = await runExpertTransferEvaluation({ cwd: options.cwd, task: item.task });
			validations.push(validation);
			completed += 1;
			options.onProgress?.({
				completed: completed + skipped,
				total: pending.length,
				taskId: item.task.taskId,
				decision: validation.decision,
			});
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
	const transferValidated = validations.filter((validation) => validation.decision === "transfer_validated");
	const rejected = validations.filter((validation) => validation.decision === "rejected");
	return {
		groups: groups.length,
		claimIds: groups.reduce((sum, group) => sum + group.claimIds.length, 0),
		alreadyValidated: groups.length - pending.length,
		skipped,
		transferValidated: transferValidated.length,
		rejected: rejected.length,
		validatedClaimIds: transferValidated.reduce((sum, validation) => sum + validation.claimIds.length, 0),
		rejectedClaimIds: rejected.reduce((sum, validation) => sum + validation.claimIds.length, 0),
		validationIds: validations.map((validation) => validation.validationId),
	};
}
