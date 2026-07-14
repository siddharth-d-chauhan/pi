import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import expertCasesExtension from "../../../extensions/expert-cases.ts";
import type { ExpertCaseCompilation } from "../../../extensions/lib/expert-cases/compiler.ts";
import {
	EXPERT_CASE_SCHEMA_VERSION,
	type ExpertCasePublic,
	type ExpertCaseSealed,
	type ExpertCaseSplit,
	type ExpertTransferTaskInput,
	expertHash,
} from "../../../extensions/lib/expert-cases/contracts.ts";
import {
	searchExpertKnowledgeInKp,
	syncTransferValidatedPoliciesToKp,
} from "../../../extensions/lib/expert-cases/kp.ts";
import type { ExpertLearningExtractor } from "../../../extensions/lib/expert-cases/learning.ts";
import {
	GovernedReviewLearningExtractor,
	LocalStructuralLearningExtractor,
	planExpertLearningBatches,
	prepareExpertLearningPacket,
	runAllExpertLearning,
	runExpertLearningPipeline,
	validateExpertLearningOutput,
} from "../../../extensions/lib/expert-cases/learning.ts";
import { searchExpertLearningClaims } from "../../../extensions/lib/expert-cases/search.ts";
import {
	auditExpertLearningRuns,
	auditExpertTransferValidations,
	loadExpertLearningRun,
	saveExpertCompilation,
} from "../../../extensions/lib/expert-cases/store.ts";
import {
	type ExpertTransferExecutor,
	runExpertTransferEvaluation,
} from "../../../extensions/lib/expert-cases/transfer.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

interface CapturedExpertTool {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (
		id: string,
		input: { query: string; limit?: number },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface AutomaticContextMessage {
	role: string;
	content: Array<{ type: string; text: string }>;
	timestamp?: number;
}

type CapturedBeforeStartHook = (event: { prompt: string }, context: { cwd: string }) => Promise<unknown>;
type CapturedContextHook = (event: {
	messages: AutomaticContextMessage[];
}) => Promise<{ messages: AutomaticContextMessage[] } | undefined>;

function fixtureCase(
	index: number,
	split: ExpertCaseSplit,
): { publicCase: ExpertCasePublic; sealedCase: ExpertCaseSealed } {
	const caseId = `case-${expertHash(index).slice(0, 24)}`;
	const publicCore = {
		schemaVersion: EXPERT_CASE_SCHEMA_VERSION,
		caseId,
		ticket: {
			key: `CIS-${index}`,
			type: "Story",
			status: "Done",
			title: `Reusable SAML handler regression ${index}`,
			taskText:
				"Reuse the repository SAML handler and add focused regression coverage. api_key=fixture-secret-value",
			sourceLocator: `jira://CIS-${index}`,
			snapshotPath: `/tickets/CIS-${index}.md`,
			snapshotHash: expertHash(`ticket-${index}`),
		},
		split,
		repositories: [{ repository: "fixture", preChangeRevision: `base-${index}` }],
		eligibility: { learning: split === "train", leakageFreeEvaluation: false, reasons: [] },
	};
	const publicCase = { ...publicCore, contentHash: expertHash(publicCore) };
	const commit = {
		hash: expertHash(`commit-${index}`),
		parents: [expertHash(`parent-${index}`)],
		authorDate: "2024-01-01T12:00:00Z",
		committerDate: "2024-01-01T12:00:00Z",
		summary: `CIS-${index} reuse SAML handler`,
		changedPaths: ["src/saml-handler.ts", "test/saml-handler.test.ts"],
		kind: "direct" as const,
	};
	const changeSet = {
		changeSetId: `change-${index}`,
		kind: "direct" as const,
		preChangeRevision: `base-${index}`,
		postChangeRevision: commit.hash,
		commits: [commit],
		changedPaths: commit.changedPaths,
		testPaths: ["test/saml-handler.test.ts"],
		firstImplementationAt: commit.authorDate,
		lastImplementationAt: commit.authorDate,
	};
	const sealedCore = {
		schemaVersion: EXPERT_CASE_SCHEMA_VERSION,
		caseId,
		publicCaseHash: publicCase.contentHash,
		kpFacts: [
			{
				src: "feature:saml",
				rel: "WORKS_BY",
				dst: "concept:handler",
				fact: "reuses the repository SAML handler",
				state: "supported",
			},
		],
		outcomes: [
			{
				repository: "fixture",
				root: "/repo",
				preChangeRevision: `base-${index}`,
				postChangeRevision: commit.hash,
				commits: [commit],
				changeSets: [changeSet],
				changedPaths: commit.changedPaths,
				testPaths: ["test/saml-handler.test.ts"],
				verificationHints: ["run focused tests"],
				firstImplementationAt: commit.authorDate,
				lastImplementationAt: commit.authorDate,
				linkage: {
					method: "exact_ticket_key_in_commit_summary" as const,
					confidence: "high" as const,
					reasons: ["exact key"],
				},
			},
		],
	};
	return { publicCase, sealedCase: { ...sealedCore, contentHash: expertHash(sealedCore) } };
}

function fixture(): { cwd: string; compilation: ExpertCaseCompilation } {
	const cwd = mkdtempSync(join(tmpdir(), "expert-learning-"));
	const items = [
		fixtureCase(1, "train"),
		fixtureCase(2, "train"),
		fixtureCase(3, "train"),
		fixtureCase(4, "held_out"),
	];
	const sourceFingerprint = expertHash("learning-fixture");
	const manifestCore = {
		schemaVersion: EXPERT_CASE_SCHEMA_VERSION,
		manifestId: `expert-${sourceFingerprint.slice(0, 24)}`,
		groupId: "fixture",
		sourceFingerprint,
		sources: {
			ticketDirectory: "/tickets",
			ticketCorpusHash: expertHash("tickets"),
			repositories: [{ repository: "fixture", root: cwd, head: "head" }],
		},
		cases: items.map(({ publicCase, sealedCase }) => ({
			caseId: publicCase.caseId,
			ticketKey: publicCase.ticket.key,
			split: publicCase.split,
			publicHash: publicCase.contentHash,
			sealedHash: sealedCase.contentHash,
		})),
		stats: {
			ticketsSeen: 4,
			linkedTickets: 4,
			unlinkedTickets: 0,
			cases: 4,
			repositories: 1,
			multiRepositoryCases: 0,
			learningReadyCases: 3,
			evaluationReadyCases: 0,
			kpFactCoverage: 1,
			linkageConfidence: { high: 4, medium: 0, low: 0 },
			bySplit: { train: 3, calibration: 0, held_out: 1 },
		},
	};
	const compilation = {
		manifest: { ...manifestCore, contentHash: expertHash(manifestCore) },
		publicCases: items.map((item) => item.publicCase),
		sealedCases: items.map((item) => item.sealedCase),
	};
	saveExpertCompilation(cwd, compilation);
	return { cwd, compilation };
}

async function addSemanticClaim(cwd: string) {
	const packet = prepareExpertLearningPacket(cwd, "reusable SAML handler regression", 3);
	const evidenceIds = packet.cases
		.slice(0, 2)
		.map((item) => item.evidence.find((entry) => entry.kind === "kp_fact")!.evidenceId);
	return runExpertLearningPipeline({
		cwd,
		query: "reusable SAML handler regression",
		extractor: new GovernedReviewLearningExtractor(
			JSON.stringify({
				claims: [
					{
						type: "implementation_pattern",
						statement: "SAML changes reuse the shared repository handler and retain focused regression coverage.",
						confidence: 0.9,
						evidenceIds,
						scope: { repositories: ["fixture"] },
					},
				],
			}),
		),
		createdAt: "2026-07-13T12:02:00.000Z",
	});
}

test("shadow learning selects only eligible train cases and stores grounded proposed claims", async () => {
	const f = fixture();
	const packet = prepareExpertLearningPacket(f.cwd, "reusable SAML handler regression", 4);
	expect(packet.cases).toHaveLength(3);
	expect(JSON.stringify(packet)).not.toContain("fixture-secret-value");
	expect(JSON.stringify(packet)).toContain("api_key=[REDACTED]");
	const heldOutId = f.compilation.manifest.cases.find((item) => item.split === "held_out")?.caseId;
	expect(packet.cases.some((item) => item.caseId === heldOutId)).toBe(false);
	const evidenceIds = packet.cases
		.slice(0, 2)
		.map((item) => item.evidence.find((entry) => entry.kind === "ticket")!.evidenceId);
	const extractor: ExpertLearningExtractor = {
		provider: "minimax",
		model: "MiniMax-M3",
		executedVia: "pi-rpc",
		authority: "strong_model",
		evidenceStrength: "semantic",
		extract: async () =>
			JSON.stringify({
				claims: [
					{
						type: "implementation_pattern",
						statement: "SAML changes reuse the repository handler and add focused regression coverage.",
						confidence: 0.88,
						evidenceIds,
						scope: { repositories: ["fixture"] },
					},
				],
			}),
	};
	const run = await runExpertLearningPipeline({
		cwd: f.cwd,
		query: "reusable SAML handler regression",
		extractor,
		createdAt: "2026-07-13T12:00:00.000Z",
	});
	expect(run.validation).toMatchObject({ status: "passed", publicationGate: "eligible", published: false });
	expect(run.claims[0]).toMatchObject({ state: "proposed", authority: "strong_model" });
	expect(loadExpertLearningRun(f.cwd, run.runId)).toEqual(run);
	expect(auditExpertLearningRuns(f.cwd)).toEqual({ runs: 1, valid: 1, passed: 1 });
});

test("shadow learning blocks non-JSON output and never publishes it", async () => {
	const f = fixture();
	const packet = prepareExpertLearningPacket(f.cwd, "reusable SAML regression");
	const singleEvidenceId = packet.cases[0].evidence.find((entry) => entry.kind === "ticket")!.evidenceId;
	const weak = validateExpertLearningOutput(
		packet,
		JSON.stringify({
			claims: [
				{
					type: "implementation_pattern",
					statement: "SAML changes should consistently reuse one shared repository handler.",
					confidence: 0.9,
					evidenceIds: [singleEvidenceId],
					scope: { repositories: ["fixture"] },
				},
			],
		}),
	);
	expect(weak.claims).toEqual([]);
	expect(weak.rejectedClaims[0].reasons).toContain("implementation_pattern requires evidence from 2 cases");
	const extractor: ExpertLearningExtractor = {
		provider: "minimax",
		model: "MiniMax-M3",
		executedVia: "pi-rpc",
		authority: "strong_model",
		evidenceStrength: "semantic",
		extract: async () => '```json\n{"claims":[]}\n```',
	};
	const run = await runExpertLearningPipeline({
		cwd: f.cwd,
		query: "reusable SAML regression",
		extractor,
		createdAt: "2026-07-13T12:01:00.000Z",
	});
	expect(run.validation).toMatchObject({ status: "failed", publicationGate: "blocked", published: false });
	expect(run.validation.errors).toContain("model output is not exact JSON");
	expect(run.claims).toEqual([]);
	expect(auditExpertLearningRuns(f.cwd)).toEqual({ runs: 1, valid: 1, passed: 0 });
});

test("expert-cases command requires explicit external-data approval before learning", async () => {
	let handler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		on: () => {},
		registerTool: () => {},
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			if (name === "expert-cases") handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	expertCasesExtension(pi);
	const notifications: string[] = [];
	const context = {
		cwd: "/synthetic",
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	if (!handler) throw new Error("expert-cases command was not registered");
	await handler("learn synthetic handler", context);
	expect(notifications).toEqual([
		"MiniMax learning sends selected Jira/git evidence to an external provider; rerun with allow-external only when that data egress is approved",
	]);
});

test("expert-cases command requires explicit external-data approval before paired transfer", async () => {
	let handler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		on: () => {},
		registerTool: () => {},
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			if (name === "expert-cases") handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	expertCasesExtension(pi);
	const notifications: string[] = [];
	const context = {
		cwd: "/synthetic",
		ui: { notify: (message: string) => notifications.push(message) },
	} as unknown as ExtensionCommandContext;
	if (!handler) throw new Error("expert-cases command was not registered");
	await handler("transfer-all", context);
	expect(notifications).toEqual([
		"Paired transfer evaluation sends private Jira/git evidence to MiniMax and incurs provider charges; rerun with allow-external only when approved",
	]);
});

test("expert search is visible to Pi and returns grounded cases and active claims without target leakage", async () => {
	const f = fixture();
	await runAllExpertLearning({
		cwd: f.cwd,
		createExtractor: () => new LocalStructuralLearningExtractor(),
	});
	let tool: CapturedExpertTool | undefined;
	const pi = {
		on: () => {},
		registerTool: (candidate: CapturedExpertTool) => {
			if (candidate.name === "expert_cases_search") tool = candidate;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	expertCasesExtension(pi);
	if (!tool) throw new Error("expert_cases_search was not registered");
	expect(tool.promptSnippet).toContain("Jira-to-git");
	expect(tool.promptGuidelines).toHaveLength(2);

	const usefulResult = await tool.execute(
		"expert-search",
		{ query: "historical focused test-path", limit: 10 },
		undefined,
		undefined,
		{ cwd: f.cwd },
	);
	const useful = JSON.parse(usefulResult.content[0].text) as {
		manifestId: string;
		hits: unknown[];
		learnedPolicies: unknown[];
		rememberedClaims: unknown[];
	};
	expect(useful.manifestId).toBe(f.compilation.manifest.manifestId);
	expect(useful.hits.length).toBeGreaterThan(0);
	expect(useful.learnedPolicies).toEqual([]);
	expect(useful.rememberedClaims.length).toBeGreaterThan(0);

	const leakageResult = await tool.execute(
		"expert-search-target",
		{ query: "CIS-1 reusable SAML handler regression", limit: 20 },
		undefined,
		undefined,
		{ cwd: f.cwd },
	);
	const leakage = JSON.parse(leakageResult.content[0].text) as {
		hits: Array<{ ticketKey: string }>;
		learnedPolicies: Array<{ ticketKeys: string[] }>;
		rememberedClaims: Array<{ ticketKeys: string[] }>;
	};
	expect(leakage.hits.every((hit) => hit.ticketKey !== "CIS-1")).toBe(true);
	expect(
		[...leakage.learnedPolicies, ...leakage.rememberedClaims].every((claim) => !claim.ticketKeys.includes("CIS-1")),
	).toBe(true);
});

test("learn-all covers every train case once and resumes passed batches", async () => {
	const f = fixture();
	const batches = planExpertLearningBatches(f.cwd, 2);
	const caseIds = batches.flatMap((batch) => batch.caseIds);
	expect(caseIds).toHaveLength(3);
	expect(new Set(caseIds).size).toBe(3);
	expect(caseIds).not.toContain(f.compilation.manifest.cases.find((item) => item.split === "held_out")?.caseId);
	let calls = 0;
	const createExtractor = (): ExpertLearningExtractor => ({
		provider: "minimax",
		model: "MiniMax-M3",
		executedVia: "pi-rpc",
		authority: "strong_model",
		evidenceStrength: "semantic",
		extract: async (prompt) => {
			calls += 1;
			const marker = "Evidence packet:\n";
			const packet = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as {
				cases: Array<{ evidence: Array<{ evidenceId: string; kind: string }> }>;
			};
			return JSON.stringify({
				claims: [
					{
						type: "implementation_pattern",
						statement:
							"Related changes consistently reuse the shared handler and preserve focused regression coverage.",
						confidence: 0.8,
						evidenceIds: packet.cases
							.slice(0, 2)
							.map((item) => item.evidence.find((entry) => entry.kind === "ticket")!.evidenceId),
						scope: { repositories: ["fixture"] },
					},
				],
			});
		},
	});
	const first = await runAllExpertLearning({ cwd: f.cwd, batchSize: 2, concurrency: 2, createExtractor });
	expect(first).toMatchObject({ totalCases: 3, totalBatches: 1, passed: 1, failed: 0, skipped: 0, claims: 1 });
	const resumed = await runAllExpertLearning({ cwd: f.cwd, batchSize: 2, concurrency: 2, createExtractor });
	expect(resumed).toMatchObject({ totalCases: 3, totalBatches: 1, passed: 0, failed: 0, skipped: 1, claims: 1 });
	expect(calls).toBe(1);
});

test("local structural learn-all keeps private evidence local and proposed", async () => {
	const f = fixture();
	const result = await runAllExpertLearning({
		cwd: f.cwd,
		batchSize: 8,
		concurrency: 2,
		createExtractor: () => new LocalStructuralLearningExtractor(),
	});
	expect(result).toMatchObject({ totalCases: 3, totalBatches: 1, passed: 1, failed: 0, claims: 3 });
	expect(auditExpertLearningRuns(f.cwd)).toEqual({ runs: 1, valid: 1, passed: 1 });
	const hits = searchExpertLearningClaims(f.cwd, "fixture test", 5);
	expect(hits.length).toBeGreaterThan(0);
	expect(hits[0]).toMatchObject({ state: "proposed", authority: "deterministic", evidenceStrength: "structural" });
});

test("local structural learn-all resumes batches with no reusable pattern as no-ops", async () => {
	const f = fixture();
	let calls = 0;
	const createExtractor = (): ExpertLearningExtractor => ({
		provider: "local",
		model: "structural-v1",
		executedVia: "local-deterministic",
		authority: "deterministic",
		evidenceStrength: "structural",
		extract: async () => {
			calls += 1;
			return '{"claims":[]}';
		},
	});
	const first = await runAllExpertLearning({ cwd: f.cwd, createExtractor });
	expect(first).toMatchObject({ totalCases: 3, totalBatches: 1, passed: 0, failed: 0, skipped: 1, claims: 0 });
	const resumed = await runAllExpertLearning({ cwd: f.cwd, createExtractor });
	expect(resumed).toMatchObject({ totalCases: 3, totalBatches: 1, passed: 0, failed: 0, skipped: 1, claims: 0 });
	expect(calls).toBe(1);
});

test("governed semantic review is validated, immutable, and never published", async () => {
	const f = fixture();
	const run = await addSemanticClaim(f.cwd);
	expect(run).toMatchObject({
		executedVia: "governed-review",
		model: { provider: "codex", id: "gpt-5" },
		validation: { status: "passed", publicationGate: "eligible", published: false },
	});
	expect(run.claims[0]).toMatchObject({
		state: "proposed",
		authority: "strong_model",
		evidenceStrength: "semantic",
	});
	expect(loadExpertLearningRun(f.cwd, run.runId)).toEqual(run);
	await runAllExpertLearning({
		cwd: f.cwd,
		createExtractor: () => new LocalStructuralLearningExtractor(),
	});
	const hits = searchExpertLearningClaims(f.cwd, "fixture changes", 20);
	expect(hits).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ authority: "strong_model", evidenceStrength: "semantic" }),
			expect.objectContaining({ authority: "deterministic", evidenceStrength: "structural" }),
		]),
	);
});

test("unseen paired transfer evaluation promotes only a claim that improves hidden quality", async () => {
	const f = fixture();
	const run = await addSemanticClaim(f.cwd);
	const claimId = run.claims[0]!.claimId;
	const task: ExpertTransferTaskInput = {
		taskId: "saml-handler-transfer",
		goal: "Implement the repository-specific SAML behavior in the fixture.",
		query: "SAML shared handler regression",
		fixtureDir: mkdtempSync(join(tmpdir(), "expert-transfer-fixture-")),
		judgeCommand: ["node"],
		hardGates: ["behavior"],
		expectedClaimIds: [claimId],
	};
	const executor: ExpertTransferExecutor = async (input) => ({
		model: { provider: "fixture", id: "same-model" },
		toolCalls: input.arm === "learned" ? ["expert_cases_search"] : [],
		usedClaimIds: input.arm === "learned" ? input.claimIds : [],
		metrics: {
			completed: true,
			qualityScore: input.arm === "learned" ? 1 : 0.25,
			hardGates: { behavior: input.arm === "learned" },
			latencyMs: 10,
		},
		assistantText: input.arm,
		judgeOutput: input.arm,
	});
	const validation = await runExpertTransferEvaluation({
		cwd: f.cwd,
		task,
		executor,
		createdAt: "2026-07-13T12:03:00.000Z",
	});
	expect(validation).toMatchObject({ decision: "transfer_validated", claimIds: [claimId], reasons: [] });
	expect(auditExpertTransferValidations(f.cwd)).toEqual({
		validations: 1,
		valid: 1,
		transferValidated: 1,
		currentProtocolValidations: 1,
		currentProtocolTransferValidated: 1,
		currentProtocolLearnedClaimIds: 1,
	});
	const hit = searchExpertLearningClaims(f.cwd, "SAML shared handler regression", 5).find(
		(claim) => claim.claimId === claimId,
	);
	expect(hit).toMatchObject({
		learningStatus: "transfer_validated",
		validationIds: [validation.validationId],
	});
	let tool: CapturedExpertTool | undefined;
	let beforeStart: CapturedBeforeStartHook | undefined;
	let contextHook: CapturedContextHook | undefined;
	expertCasesExtension({
		on: (event: string, handler: unknown) => {
			if (event === "before_agent_start") beforeStart = handler as CapturedBeforeStartHook;
			if (event === "context") contextHook = handler as CapturedContextHook;
		},
		registerTool: (candidate: CapturedExpertTool) => {
			if (candidate.name === "expert_cases_search") tool = candidate;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI);
	if (!beforeStart || !contextHook) throw new Error("automatic expert context hooks were not registered");
	await beforeStart({ prompt: "Fix the SAML shared handler regression" }, { cwd: f.cwd });
	const automatic = await contextHook({ messages: [] });
	const automaticText = automatic?.messages.at(-1)?.content[0]?.text ?? "";
	expect(automaticText).toContain('<expert-case-context mode="automatic"');
	expect(automaticText).toContain("Transfer-validated policies");
	expect(automaticText).toContain(claimId);
	await beforeStart({ prompt: "retry" }, { cwd: f.cwd });
	const retried = await contextHook({ messages: [] });
	expect(retried?.messages.at(-1)?.content[0]?.text ?? "").toContain(claimId);
	await beforeStart({ prompt: "Fix CIS-1 SAML shared handler regression" }, { cwd: f.cwd });
	const leakageSafe = await contextHook({ messages: [] });
	expect(leakageSafe?.messages.at(-1)?.content[0]?.text ?? "").not.toContain("CIS-1");
	await beforeStart({ prompt: "hello" }, { cwd: f.cwd });
	expect(await contextHook({ messages: [] })).toBeUndefined();
	const previousExpertCwd = process.env.PI_EXPERT_CASES_CWD;
	const previousAutoRepository = process.env.PI_EXPERT_AUTO_CONTEXT_REPOSITORY;
	process.env.PI_EXPERT_CASES_CWD = f.cwd;
	process.env.PI_EXPERT_AUTO_CONTEXT_REPOSITORY = "fixture";
	const harness = await createHarness({ extensionFactories: [expertCasesExtension] });
	try {
		let providerText = "";
		harness.setResponses([
			(context) => {
				providerText = context.messages.map((message) => getMessageText(message)).join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Fix the SAML shared handler regression");
		expect(providerText).toContain("<expert-case-context");
		expect(providerText).toContain(claimId);
	} finally {
		harness.cleanup();
		if (previousExpertCwd === undefined) delete process.env.PI_EXPERT_CASES_CWD;
		else process.env.PI_EXPERT_CASES_CWD = previousExpertCwd;
		if (previousAutoRepository === undefined) delete process.env.PI_EXPERT_AUTO_CONTEXT_REPOSITORY;
		else process.env.PI_EXPERT_AUTO_CONTEXT_REPOSITORY = previousAutoRepository;
	}
	if (!tool) throw new Error("expert_cases_search was not registered");
	const result = await tool.execute(
		"transfer-search",
		{ query: "SAML shared handler regression" },
		undefined,
		undefined,
		{ cwd: f.cwd },
	);
	const search = JSON.parse(result.content[0].text) as {
		learnedPolicies: Array<{ claimId: string }>;
		rememberedClaims: Array<{ claimId: string }>;
	};
	expect(search.learnedPolicies.map((claim) => claim.claimId)).toContain(claimId);
	expect(search.rememberedClaims.map((claim) => claim.claimId)).not.toContain(claimId);
});

test("transfer-validated policies synchronize to KP and manual LLM search queries KP", async () => {
	const f = fixture();
	const run = await addSemanticClaim(f.cwd);
	const claimId = run.claims[0]!.claimId;
	await runAllExpertLearning({
		cwd: f.cwd,
		createExtractor: () => new LocalStructuralLearningExtractor(),
	});
	await runExpertTransferEvaluation({
		cwd: f.cwd,
		task: {
			taskId: "saml-kp-sync",
			goal: "Implement the repository-specific SAML behavior in the fixture.",
			query: "SAML shared handler regression",
			fixtureDir: mkdtempSync(join(tmpdir(), "expert-transfer-kp-")),
			judgeCommand: ["node"],
			hardGates: ["behavior"],
			expectedClaimIds: [claimId],
		},
		executor: async (input) => ({
			model: { provider: "fixture", id: "same-model" },
			toolCalls: input.arm === "learned" ? ["expert_cases_search"] : [],
			usedClaimIds: input.arm === "learned" ? input.claimIds : [],
			metrics: {
				completed: true,
				qualityScore: input.arm === "learned" ? 1 : 0,
				hardGates: { behavior: input.arm === "learned" },
				latencyMs: 1,
			},
			assistantText: input.arm,
			judgeOutput: input.arm,
		}),
	});

	const previousKp = (globalThis as Record<string, unknown>).__pi_kp__;
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	(globalThis as Record<string, unknown>).__pi_kp__ = {
		timeoutMs: 1_000,
		connect: async () => ({
			callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
				calls.push(request);
				const payload =
					request.name === "knowledge.search"
						? {
								query: request.arguments.query,
								group: "fixture",
								project: "expert-cases",
								returned: 1,
								hits: [
									{
										fact: String(request.arguments.query).includes("CIS-1")
											? "Transfer-validated expert policy from KP. Source Jira: CIS-1"
											: "Transfer-validated expert policy from KP",
										state: "supported",
									},
								],
							}
						: { decision: "supported", queued: true, reconciliation: "ADD" };
				return { content: [{ type: "text", text: JSON.stringify(payload) }] };
			},
		}),
	};
	try {
		const sync = await syncTransferValidatedPoliciesToKp(f.cwd, 1_000);
		expect(sync).toMatchObject({ total: 1, supported: 1, unchanged: 0, failed: 0, skipped: false });
		const writes = calls.filter((call) => call.name === "pi.memory_writeback");
		expect(writes).toHaveLength(1);
		expect(writes[0]!.arguments).toMatchObject({
			project: "expert-cases",
			inject_class: "SEARCH_ONLY",
			evidence: { gates: [expect.stringContaining("paired same-model hidden-judge transfer gate passed")] },
			metadata: { claimIds: [claimId] },
		});
		const resumed = await syncTransferValidatedPoliciesToKp(f.cwd, 1_000);
		expect(resumed.skipped).toBe(true);
		expect(calls.filter((call) => call.name === "pi.memory_writeback")).toHaveLength(1);

		let tool: CapturedExpertTool | undefined;
		expertCasesExtension({
			on: () => {},
			registerTool: (candidate: CapturedExpertTool) => {
				if (candidate.name === "expert_cases_search") tool = candidate;
			},
			registerCommand: () => {},
		} as unknown as ExtensionAPI);
		if (!tool) throw new Error("expert_cases_search was not registered");
		expect(tool.promptSnippet).toContain("Manually search KP");
		expect(tool.promptGuidelines?.[0]).toContain("call expert_cases_search manually");
		const result = await tool.execute(
			"kp-search",
			{ query: "SAML shared handler regression" },
			undefined,
			undefined,
			{ cwd: f.cwd },
		);
		const parsed = JSON.parse(result.content[0].text) as {
			kpKnowledge: { project: string; hits: Array<{ state: string }> };
		};
		expect(parsed.kpKnowledge).toMatchObject({ project: "expert-cases", hits: [{ state: "supported" }] });
		expect(calls.find((call) => call.name === "knowledge.search")?.arguments).toMatchObject({
			include_proposed: false,
			recipe: "hot",
			project: "expert-cases",
		});
		const targetSafe = await searchExpertKnowledgeInKp("CIS-1 SAML shared handler", 5, 1_000);
		expect(targetSafe?.hits).toEqual([]);
	} finally {
		if (previousKp === undefined) delete (globalThis as Record<string, unknown>).__pi_kp__;
		else (globalThis as Record<string, unknown>).__pi_kp__ = previousKp;
	}
});

test("default transfer executor runs isolated Pi RPC arms and a hidden process judge", async () => {
	const f = fixture();
	const run = await addSemanticClaim(f.cwd);
	const claimId = run.claims[0]!.claimId;
	const fixtureDir = mkdtempSync(join(tmpdir(), "expert-transfer-process-fixture-"));
	const helperDir = mkdtempSync(join(tmpdir(), "expert-transfer-process-helper-"));
	writeFileSync(join(fixtureDir, "work.txt"), "unmodified\n");
	const cliPath = join(helperDir, "fake-pi-rpc.mjs");
	writeFileSync(
		cliPath,
		`import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const toolsIndex = process.argv.indexOf("--tools");
const allowedTools = toolsIndex >= 0 ? process.argv[toolsIndex + 1].split(",") : [];
const learned = process.argv.includes("--extension") && allowedTools.includes("expert_cases_search");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type === "get_state") {
    console.log(JSON.stringify({ id: input.id, type: "response", data: { model: { provider: "fixture", id: "same-model" } } }));
  }
  if (input.type === "prompt") {
    writeFileSync("result.json", JSON.stringify({ learned }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: learned ? [{ type: "toolCall", name: "expert_cases_search" }] : [] } }));
    if (learned) console.log(JSON.stringify({ type: "message_end", message: { role: "toolResult", toolName: "expert_cases_search", content: [{ type: "text", text: process.env.FAKE_EXPERT_CLAIM_ID }] } }));
    console.log(JSON.stringify({ type: "agent_settled" }));
  }
});
`,
	);
	const judgePath = join(helperDir, "judge.sh");
	writeFileSync(
		judgePath,
		`#!/bin/sh
if grep -q '"learned":true' result.json; then
  printf '%s\n' '{"completed":true,"qualityScore":1,"hardGates":{"behavior":true}}'
else
  printf '%s\n' '{"completed":false,"qualityScore":0.2,"hardGates":{"behavior":false}}'
fi
`,
	);
	chmodSync(judgePath, 0o755);
	const previousCli = process.env.PI_EXPERT_RPC_CLI;
	const previousClaim = process.env.FAKE_EXPERT_CLAIM_ID;
	process.env.PI_EXPERT_RPC_CLI = cliPath;
	process.env.FAKE_EXPERT_CLAIM_ID = claimId;
	try {
		const validation = await runExpertTransferEvaluation({
			cwd: f.cwd,
			task: {
				taskId: "process-level-transfer",
				goal: "Implement the repository-specific SAML behavior in the fixture.",
				query: "SAML shared handler regression",
				fixtureDir,
				judgeCommand: [judgePath],
				hardGates: ["behavior"],
				expectedClaimIds: [claimId],
				timeoutMs: 10_000,
			},
		});
		expect(validation.decision, JSON.stringify(validation, null, 2)).toBe("transfer_validated");
		expect(validation.attempts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ arm: "control", metrics: expect.objectContaining({ qualityScore: 0.2 }) }),
				expect.objectContaining({ arm: "learned", metrics: expect.objectContaining({ qualityScore: 1 }) }),
			]),
		);
	} finally {
		if (previousCli === undefined) delete process.env.PI_EXPERT_RPC_CLI;
		else process.env.PI_EXPERT_RPC_CLI = previousCli;
		if (previousClaim === undefined) delete process.env.FAKE_EXPERT_CLAIM_ID;
		else process.env.FAKE_EXPERT_CLAIM_ID = previousClaim;
	}
});

test("transfer evaluation persists model mismatch as rejection instead of learning", async () => {
	const f = fixture();
	const run = await addSemanticClaim(f.cwd);
	const task: ExpertTransferTaskInput = {
		taskId: "saml-model-mismatch",
		goal: "Implement the repository-specific SAML behavior in the fixture.",
		query: "SAML shared handler regression",
		fixtureDir: mkdtempSync(join(tmpdir(), "expert-transfer-rejected-")),
		judgeCommand: ["node"],
		hardGates: ["behavior"],
		expectedClaimIds: [run.claims[0]!.claimId],
	};
	const executor: ExpertTransferExecutor = async (input) => ({
		model: { provider: "fixture", id: input.arm },
		toolCalls: input.arm === "learned" ? ["expert_cases_search"] : [],
		usedClaimIds: input.arm === "learned" ? input.claimIds : [],
		metrics: {
			completed: true,
			qualityScore: input.arm === "learned" ? 1 : 0,
			hardGates: { behavior: true },
			latencyMs: 1,
		},
		assistantText: "done",
		judgeOutput: "done",
	});
	const validation = await runExpertTransferEvaluation({ cwd: f.cwd, task, executor });
	expect(validation.decision).toBe("rejected");
	expect(validation.reasons).toContain("control and learned arms used different models");
	expect(searchExpertLearningClaims(f.cwd, "SAML shared handler regression", 5)[0]).toMatchObject({
		learningStatus: "remembered",
		validationIds: [],
	});
});

test("transfer task cannot name a source Jira ticket", async () => {
	const f = fixture();
	const run = await addSemanticClaim(f.cwd);
	await expect(
		runExpertTransferEvaluation({
			cwd: f.cwd,
			task: {
				taskId: "leaking-transfer-task",
				goal: "Copy the behavior from CIS-1 into this fixture.",
				query: "SAML shared handler regression",
				fixtureDir: mkdtempSync(join(tmpdir(), "expert-transfer-leak-")),
				judgeCommand: ["node"],
				hardGates: ["behavior"],
				expectedClaimIds: [run.claims[0]!.claimId],
			},
			executor: async () => {
				throw new Error("must not run");
			},
		}),
	).rejects.toThrow("transfer task is not unseen");
});

test("claim retrieval excludes passed runs from a stale expert manifest", async () => {
	const f = fixture();
	await runAllExpertLearning({
		cwd: f.cwd,
		createExtractor: () => new LocalStructuralLearningExtractor(),
	});
	expect(searchExpertLearningClaims(f.cwd, "fixture test", 5).length).toBeGreaterThan(0);
	const { contentHash: _contentHash, ...previousCore } = f.compilation.manifest;
	const sourceFingerprint = expertHash("next-learning-fixture");
	const nextCore = {
		...previousCore,
		manifestId: `expert-${sourceFingerprint.slice(0, 24)}`,
		sourceFingerprint,
	};
	saveExpertCompilation(f.cwd, {
		...f.compilation,
		manifest: { ...nextCore, contentHash: expertHash(nextCore) },
	});
	expect(searchExpertLearningClaims(f.cwd, "fixture test", 5)).toEqual([]);
});
