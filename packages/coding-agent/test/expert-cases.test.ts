import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { formatExpertSearchResult } from "../../../extensions/expert-cases.ts";
import { compileExpertCases, parseTicketSnapshot } from "../../../extensions/lib/expert-cases/compiler.ts";
import { searchExpertCases } from "../../../extensions/lib/expert-cases/search.ts";
import {
	auditExpertCases,
	expertCasesRoot,
	loadActiveExpertManifest,
	loadExpertCase,
	saveExpertCompilation,
} from "../../../extensions/lib/expert-cases/store.ts";

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...env } }).trim();
}

function writeTicket(directory: string, index: number): void {
	const key = `CIS-${index}`;
	writeFileSync(
		join(directory, `${index.toString().padStart(4, "0")}_${key}.md`),
		`# ${key} — Story — Done
Reusable SAML flow ${index}

## What it does / how it works
Require a repository-specific SAML handler and regression coverage for flow ${index}.

## Code & release context
- **Fix version**: 1.0.${index}

_meta: ${key} · Story · reporter Test · assignee Test · created ${index.toString().padStart(2, "0")}/Jan/24 10:00 AM · resolved ${index.toString().padStart(2, "0")}/Jan/24 11:00 AM_
`,
	);
}

function fixture(): { cwd: string; repo: string; tickets: string; base: string; commits: string[] } {
	const cwd = mkdtempSync(join(tmpdir(), "expert-cases-"));
	const repo = join(cwd, "repo");
	const tickets = join(cwd, "tickets");
	mkdirSync(repo);
	mkdirSync(tickets);
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.email", "expert@example.com"]);
	git(repo, ["config", "user.name", "Expert Fixture"]);
	writeFileSync(join(repo, "handler.ts"), "export const value = 0;\n");
	git(repo, ["add", "handler.ts"]);
	git(repo, ["commit", "-m", "initial"]);
	const base = git(repo, ["rev-parse", "HEAD"]);
	const commits: string[] = [];
	for (let index = 1; index <= 10; index += 1) {
		writeTicket(tickets, index);
		writeFileSync(join(repo, "handler.ts"), `export const value = ${index};\n`);
		writeFileSync(join(repo, `handler-${index}.test.ts`), `export const covered = ${index};\n`);
		git(repo, ["add", "handler.ts", `handler-${index}.test.ts`]);
		const date = `2024-01-${index.toString().padStart(2, "0")}T12:00:00Z`;
		git(repo, ["commit", "-m", `CIS-${index} implement reusable SAML flow`], {
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		});
		commits.push(git(repo, ["rev-parse", "HEAD"]));
	}
	writeTicket(tickets, 11);
	writeFileSync(join(repo, "unrelated.ts"), "export const unrelated = true;\n");
	git(repo, ["add", "unrelated.ts"]);
	git(repo, ["commit", "-m", "unrelated release work", "-m", "release notes mention CIS-11"]);
	writeTicket(tickets, 12);
	writeFileSync(join(repo, "predates-ticket.ts"), "export const historical = true;\n");
	git(repo, ["add", "predates-ticket.ts"]);
	git(repo, ["commit", "-m", "CIS-12 historical implementation"], {
		GIT_AUTHOR_DATE: "2023-12-01T12:00:00Z",
		GIT_COMMITTER_DATE: "2023-12-01T12:00:00Z",
	});
	return { cwd, repo, tickets, base, commits };
}

test("manual expert search output stays valid JSON within its token budget", () => {
	const repeated = "large evidence ".repeat(2_000);
	const claim = {
		claimId: "claim-1",
		type: "procedure",
		statement: repeated,
		confidence: 0.9,
		authority: "deterministic" as const,
		evidenceStrength: "structural" as const,
		repositories: ["repo"],
		ticketKeys: ["CIS-1"],
		sourceTitles: [repeated],
		learningStatus: "remembered" as const,
		validationIds: [],
		score: 2,
	};
	const result: Parameters<typeof formatExpertSearchResult>[0] = {
		manifestId: "manifest-1",
		query: "license allocation",
		hits: [],
		learnedPolicies: [],
		rememberedClaims: Array.from({ length: 20 }, (_, index) => ({ ...claim, claimId: `claim-${index}` })),
		kpKnowledge: {
			query: "license allocation",
			returned: 20,
			hits: Array.from({ length: 20 }, () => ({ state: "confirmed", fact: repeated })),
		},
	};

	const output = formatExpertSearchResult(result);
	expect(output.length).toBeLessThanOrEqual(24_000);
	expect(() => JSON.parse(output)).not.toThrow();
	expect(JSON.parse(output).truncation ?? JSON.parse(output).truncated).toBeTruthy();
});

test("compiler links Jira snapshots to git while keeping outcomes sealed", async () => {
	const f = fixture();
	writeFileSync(join(f.repo, "handler-1.test.ts"), "export const covered = 'follow-up';\n");
	git(f.repo, ["add", "handler-1.test.ts"]);
	git(f.repo, ["commit", "-m", "CIS-1 add follow-up regression coverage"], {
		GIT_AUTHOR_DATE: "2024-01-11T12:00:00Z",
		GIT_COMMITTER_DATE: "2024-01-11T12:00:00Z",
	});
	const followup = git(f.repo, ["rev-parse", "HEAD"]);
	const compilation = await compileExpertCases({
		ticketDirectory: f.tickets,
		repositories: [
			{ repository: "fixture", root: f.repo, branch: "main" },
			{ repository: "duplicate-alias", root: f.repo, branch: "main" },
		],
		groupId: "iam_v2",
		getFacts: async (key) => [
			{
				src: `feature:${key.toLowerCase()}`,
				rel: "WORKS_BY",
				dst: "concept:saml",
				fact: "reuses SAML handler",
				state: "supported",
			},
		],
	});

	expect(compilation.manifest.stats).toMatchObject({
		ticketsSeen: 12,
		linkedTickets: 11,
		unlinkedTickets: 1,
		cases: 11,
		repositories: 1,
		learningReadyCases: 10,
		evaluationReadyCases: 0,
		bySplit: { train: 8, calibration: 1, held_out: 2 },
		linkageConfidence: { high: 10, medium: 0, low: 1 },
	});
	const publicCase = compilation.publicCases[0];
	const sealedCase = compilation.sealedCases[0];
	expect(publicCase.repositories).toEqual([{ repository: "fixture", preChangeRevision: f.base }]);
	expect(JSON.stringify(publicCase)).not.toContain(f.commits[0]);
	expect(JSON.stringify(publicCase)).not.toContain("handler-1.test.ts");
	expect(JSON.stringify(publicCase)).not.toContain("reuses SAML handler");
	expect(sealedCase.outcomes[0].postChangeRevision).toBe(followup);
	expect(sealedCase.outcomes[0].commits).toHaveLength(2);
	expect(sealedCase.outcomes[0].changeSets).toHaveLength(1);
	expect(sealedCase.outcomes[0].changeSets[0].commits).toHaveLength(2);
	expect(sealedCase.outcomes[0].testPaths).toContain("handler-1.test.ts");
	expect(sealedCase.kpFacts[0].fact).toBe("reuses SAML handler");
	expect(publicCase.ticket.taskText).not.toContain("Code & release context");
});

test("stored cases are immutable, auditable, idempotent, and target-key excluded from search", async () => {
	const f = fixture();
	const options = {
		ticketDirectory: f.tickets,
		repositories: [{ repository: "fixture", root: f.repo, branch: "main" }],
		groupId: "iam_v2",
		getFacts: async (key: string) => [
			{
				src: `feature:${key.toLowerCase()}`,
				rel: "WORKS_BY",
				dst: "concept:saml",
				fact: "reuses SAML handler",
				state: "supported",
			},
		],
	};
	const first = await compileExpertCases(options);
	const second = await compileExpertCases(options);
	expect(second.manifest).toEqual(first.manifest);
	saveExpertCompilation(f.cwd, first);
	saveExpertCompilation(f.cwd, second);
	expect(loadActiveExpertManifest(f.cwd)?.manifestId).toBe(first.manifest.manifestId);
	expect(auditExpertCases(f.cwd)).toEqual({ manifestId: first.manifest.manifestId, cases: 11, valid: 11 });

	const hits = searchExpertCases(f.cwd, "CIS-10 reusable SAML handler", 20);
	expect(hits.length).toBeGreaterThan(0);
	expect(hits.some((hit) => hit.ticketKey === "CIS-10")).toBe(false);
	expect(hits.some((hit) => hit.ticketKey === "CIS-12")).toBe(false);
	expect(hits[0].changedPaths.length).toBeGreaterThan(0);

	const caseId = first.manifest.cases[0].caseId;
	const loaded = loadExpertCase(f.cwd, caseId);
	const path = join(expertCasesRoot(f.cwd), "cases", "public", `${caseId}.json`);
	const tampered = { ...loaded.publicCase, split: "held_out" };
	writeFileSync(path, JSON.stringify(tampered));
	expect(() => auditExpertCases(f.cwd)).toThrow("public case hash mismatch");
});

test("case identity changes when corpus growth changes its dataset split", async () => {
	const f = fixture();
	const options = {
		ticketDirectory: f.tickets,
		repositories: [{ repository: "fixture", root: f.repo, branch: "main" }],
		groupId: "iam_v2",
	};
	const first = await compileExpertCases(options);
	saveExpertCompilation(f.cwd, first);
	const previous = first.manifest.cases.find((item) => item.ticketKey === "CIS-9");
	expect(previous?.split).toBe("calibration");

	writeTicket(f.tickets, 13);
	writeFileSync(join(f.repo, "handler-13.ts"), "export const value = 13;\n");
	git(f.repo, ["add", "handler-13.ts"]);
	git(f.repo, ["commit", "-m", "CIS-13 implement reusable SAML flow"], {
		GIT_AUTHOR_DATE: "2024-01-13T12:00:00Z",
		GIT_COMMITTER_DATE: "2024-01-13T12:00:00Z",
	});

	const grown = await compileExpertCases(options);
	const current = grown.manifest.cases.find((item) => item.ticketKey === "CIS-9");
	expect(current?.split).toBe("train");
	expect(current?.caseId).not.toBe(previous?.caseId);
	expect(() => saveExpertCompilation(f.cwd, grown)).not.toThrow();
	expect(auditExpertCases(f.cwd)).toEqual({ manifestId: grown.manifest.manifestId, cases: 12, valid: 12 });
});

test("compiler joins authoritative Bitbucket PR metadata to an SSH-fetched merge commit", async () => {
	const f = fixture();
	writeTicket(f.tickets, 13);
	writeFileSync(join(f.repo, "group-attributes.ts"), "export const groupAttributes = true;\n");
	git(f.repo, ["add", "group-attributes.ts"]);
	git(f.repo, ["commit", "-m", "Merged in feature/custom-group-attr (pull request #11532)"], {
		GIT_AUTHOR_DATE: "2024-01-13T12:00:00Z",
		GIT_COMMITTER_DATE: "2024-01-13T12:00:00Z",
	});
	const options = {
		ticketDirectory: f.tickets,
		repositories: [{ repository: "fixture", root: f.repo, branch: "main" }],
		groupId: "iam_v2",
	};
	const unlinked = await compileExpertCases(options);
	expect(unlinked.manifest.cases.some((item) => item.ticketKey === "CIS-13")).toBe(false);

	const linked = await compileExpertCases({
		...options,
		pullRequestTicketKeys: new Map([["fixture\0" + "11532", ["CIS-13"]]]),
	});
	const ref = linked.manifest.cases.find((item) => item.ticketKey === "CIS-13");
	expect(ref).toBeDefined();
	const sealed = linked.sealedCases.find((item) => item.caseId === ref?.caseId);
	expect(sealed?.outcomes[0]).toMatchObject({
		commits: [{ pullRequestId: "11532" }],
		linkage: {
			method: "authoritative_bitbucket_pr_to_merge_commit",
			confidence: "high",
		},
	});
});

test("ticket parser preserves local temporal provenance and strips implementation context", () => {
	const f = fixture();
	const ticket = parseTicketSnapshot(join(f.tickets, "0001_CIS-1.md"));
	expect(ticket.createdAtLocal).toBe("2024-01-01T10:00:00");
	expect(ticket.resolvedAtLocal).toBe("2024-01-01T11:00:00");
	expect(ticket.sourceLocator).toBe("jira://CIS-1");
	expect(ticket.taskText).not.toContain("Fix version");
	expect(readFileSync(ticket.snapshotPath, "utf-8")).toContain("Fix version");
});
