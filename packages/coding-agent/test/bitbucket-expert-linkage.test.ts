import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	buildBitbucketLinkageAudit,
	extractAuthoritativeTicketKeys,
	parseBitbucketRemote,
	reconcileBitbucketLinkageAudit,
} from "../../../extensions/lib/expert-cases/bitbucket.ts";
import type { BitbucketPullRequestEvidence } from "../../../extensions/lib/expert-cases/contracts.ts";
import {
	loadActiveBitbucketLinkageAudit,
	saveBitbucketLinkageAudit,
} from "../../../extensions/lib/expert-cases/store.ts";

function pullRequest(
	repository: string,
	id: number,
	updatedOn: string,
	input: { title: string; sourceBranch?: string; description?: string },
): BitbucketPullRequestEvidence {
	return {
		repository,
		id,
		title: input.title,
		sourceBranch: input.sourceBranch ?? `feature/${id}`,
		destinationBranch: "release/1.0.0",
		updatedOn,
		url: `https://bitbucket.org/miniorange/${repository}/pull-requests/${id}`,
		...extractAuthoritativeTicketKeys(input),
	};
}

test("authoritative Jira linkage excludes descriptions and version-like tokens", () => {
	expect(
		extractAuthoritativeTicketKeys({
			title: "[CIS-42] Sync release/5.4.0 with AES-256 support",
			sourceBranch: "feature/IDPSEC-7",
			description: "Release body transitively mentions CIS-99",
		}),
	).toEqual({
		ticketKeys: ["CIS-42", "IDPSEC-7"],
		descriptionOnlyTicketKeys: ["CIS-99"],
	});
});

test("Bitbucket audit expands latest Jira stories across repositories and multiple PRs", () => {
	const cwd = mkdtempSync(join(tmpdir(), "bitbucket-linkage-"));
	const tickets = join(cwd, "tickets");
	mkdirSync(tickets);
	writeFileSync(join(tickets, "0001_CIS-1.md"), "# CIS-1 — Story — Done\nMulti-repo story\n");
	const pullRequests = [
		pullRequest("repo-a", 10, "2026-07-05T00:00:00Z", {
			title: "CIS-1 backend implementation",
			description: "Release history includes CIS-3",
		}),
		pullRequest("repo-b", 20, "2026-07-04T00:00:00Z", {
			title: "frontend implementation",
			sourceBranch: "feature/CIS-1-ui",
		}),
		pullRequest("repo-b", 21, "2026-07-03T00:00:00Z", {
			title: "CIS-1 CIS-2 follow-up",
		}),
		pullRequest("repo-a", 22, "2026-07-02T00:00:00Z", {
			title: "release branch sync",
			description: "CIS-2 inherited from merged commits",
		}),
		pullRequest("repo-c", 30, "2025-12-01T00:00:00Z", {
			title: "CIS-1 service implementation",
		}),
	];
	const repositories = ["repo-a", "repo-b", "repo-c"].map((repository) => ({
		repository,
		workspace: "miniorange",
		slug: repository,
	}));
	const audit = buildBitbucketLinkageAudit({
		repositories,
		pullRequests,
		ticketDirectory: tickets,
		expertCaseRepositories: new Map([["CIS-1", ["repo-a", "repo-b"]]]),
		latestLimit: 4,
	});

	expect(audit.stats).toEqual({
		historicalReleasePullRequests: 5,
		latestPullRequests: 4,
		latestWithAuthoritativeTicket: 3,
		latestWithoutAuthoritativeTicket: 1,
		latestWithDescriptionOnlyTicket: 1,
		latestWithMultipleTickets: 1,
		uniqueTickets: 2,
		multiRepositoryTickets: 1,
		ticketsWithSnapshot: 1,
		ticketsWithExpertCase: 1,
		completeExpertCaseCoverage: 0,
		partialExpertCaseCoverage: 1,
	});
	const first = audit.tickets.find((ticket) => ticket.ticketKey === "CIS-1");
	expect(first).toMatchObject({
		repositories: ["repo-a", "repo-b", "repo-c"],
		snapshotAvailable: true,
		expertCaseRepositories: ["repo-a", "repo-b"],
		expertCaseCoverage: "partial",
	});
	expect(first?.pullRequests.map((pullRequest) => pullRequest.id)).toEqual([10, 20, 21, 30]);
	expect(audit.tickets.some((ticket) => ticket.ticketKey === "CIS-3")).toBe(false);

	saveBitbucketLinkageAudit(cwd, audit);
	expect(loadActiveBitbucketLinkageAudit(cwd)).toEqual(audit);
	const changedDescriptionEvidence = buildBitbucketLinkageAudit({
		repositories,
		pullRequests: pullRequests.map((pullRequest) =>
			pullRequest.id === 22 ? { ...pullRequest, descriptionOnlyTicketKeys: ["CIS-4"] } : pullRequest,
		),
		ticketDirectory: tickets,
		expertCaseRepositories: new Map([["CIS-1", ["repo-a", "repo-b"]]]),
		latestLimit: 4,
	});
	expect(changedDescriptionEvidence.auditId).not.toBe(audit.auditId);
});

test("Bitbucket remote parser supports canonical HTTPS and SSH remotes without credentials", () => {
	expect(parseBitbucketRemote("https://user:secret@bitbucket.org/miniorange/idp-apps-service.git")).toEqual({
		workspace: "miniorange",
		slug: "idp-apps-service",
	});
	expect(parseBitbucketRemote("git@bitbucket.org:miniorange/mo-workflow.git")).toEqual({
		workspace: "miniorange",
		slug: "mo-workflow",
	});
	expect(parseBitbucketRemote("https://github.com/example/repo.git")).toBeUndefined();
});

test("offline reconciliation updates only snapshot and expert-case coverage with parent provenance", () => {
	const cwd = mkdtempSync(join(tmpdir(), "bitbucket-reconcile-"));
	const tickets = join(cwd, "tickets");
	mkdirSync(tickets);
	const repositories = ["repo-a", "repo-b"].map((repository) => ({
		repository,
		workspace: "miniorange",
		slug: repository,
	}));
	const previous = buildBitbucketLinkageAudit({
		repositories,
		pullRequests: [
			pullRequest("repo-a", 1, "2026-07-05T00:00:00Z", { title: "CIS-1 backend" }),
			pullRequest("repo-b", 2, "2026-07-04T00:00:00Z", { title: "CIS-1 CIS-2 frontend" }),
		],
		ticketDirectory: tickets,
		latestLimit: 2,
	});
	writeFileSync(join(tickets, "0001_CIS-1.md"), "# CIS-1 — Story — Done\nFirst\n");
	writeFileSync(join(tickets, "0002_CIS-2.md"), "# CIS-2 — Story — Done\nSecond\n");
	const options = {
		previousAudit: previous,
		ticketDirectory: tickets,
		expertManifest: { contentHash: "manifest-hash" },
		expertCaseRepositories: new Map([
			["CIS-1", ["repo-a", "repo-b"]],
			["CIS-2", ["repo-b"]],
		]),
	};
	const reconciled = reconcileBitbucketLinkageAudit(options);
	expect(reconciled.sources.basedOnAuditId).toBe(previous.auditId);
	expect(reconciled.stats).toMatchObject({
		historicalReleasePullRequests: 2,
		latestPullRequests: 2,
		ticketsWithSnapshot: 2,
		ticketsWithExpertCase: 2,
		completeExpertCaseCoverage: 2,
		partialExpertCaseCoverage: 0,
	});
	expect(reconcileBitbucketLinkageAudit({ ...options, previousAudit: reconciled })).toEqual(reconciled);
});
