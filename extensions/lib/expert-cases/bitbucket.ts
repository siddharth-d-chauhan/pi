import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import {
	type BitbucketLinkageAudit,
	type BitbucketPullRequestEvidence,
	type BitbucketRepositoryDescriptor,
	type ExpertCaseManifest,
	expertHash,
} from "./contracts.ts";

const DEFAULT_TICKET_PREFIXES = ["CIS", "IDPSEC"];

interface BitbucketPullRequestValue {
	id?: unknown;
	title?: unknown;
	description?: unknown;
	source?: { branch?: { name?: unknown } };
	destination?: { branch?: { name?: unknown } };
	updated_on?: unknown;
	links?: { html?: { href?: unknown } };
}

interface BitbucketPullRequestPage {
	next?: unknown;
	values?: unknown;
}

export interface FetchBitbucketPullRequestsOptions {
	repositories: BitbucketRepositoryDescriptor[];
	username: string;
	password: string;
	ticketPrefixes?: string[];
	concurrency?: number;
	fetchImpl?: typeof fetch;
	onRepository?: (repository: string, pullRequests: number) => void;
}

export interface BuildBitbucketLinkageAuditOptions {
	repositories: BitbucketRepositoryDescriptor[];
	pullRequests: BitbucketPullRequestEvidence[];
	ticketDirectory: string;
	expertManifest?: ExpertCaseManifest;
	expertCaseRepositories?: ReadonlyMap<string, string[]>;
	latestLimit?: number;
	ticketPrefixes?: string[];
}

export interface ReconcileBitbucketLinkageAuditOptions {
	previousAudit: BitbucketLinkageAudit;
	ticketDirectory: string;
	expertManifest: Pick<ExpertCaseManifest, "contentHash">;
	expertCaseRepositories: ReadonlyMap<string, string[]>;
}

function normalizedPrefixes(prefixes: string[]): string[] {
	const normalized = [...new Set(prefixes.map((prefix) => prefix.trim().toUpperCase()).filter(Boolean))].sort();
	if (normalized.length === 0) throw new Error("at least one Jira ticket prefix is required");
	for (const prefix of normalized) {
		if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) throw new Error(`invalid Jira ticket prefix: ${prefix}`);
	}
	return normalized;
}

function ticketPattern(prefixes: string[]): RegExp {
	const alternatives = normalizedPrefixes(prefixes).join("|");
	return new RegExp(`\\b(?:${alternatives})-\\d+\\b`, "g");
}

function ticketKeys(text: string, prefixes: string[]): string[] {
	return [...new Set(text.toUpperCase().match(ticketPattern(prefixes)) ?? [])].sort();
}

export function extractAuthoritativeTicketKeys(
	input: { title?: string; sourceBranch?: string; description?: string },
	prefixes: string[] = DEFAULT_TICKET_PREFIXES,
): { ticketKeys: string[]; descriptionOnlyTicketKeys: string[] } {
	const authoritative = [
		...new Set([...ticketKeys(input.title ?? "", prefixes), ...ticketKeys(input.sourceBranch ?? "", prefixes)]),
	].sort();
	return {
		ticketKeys: authoritative,
		descriptionOnlyTicketKeys: ticketKeys(input.description ?? "", prefixes).filter(
			(ticketKey) => !authoritative.includes(ticketKey),
		),
	};
}

export function parseBitbucketRemote(remote: string): { workspace: string; slug: string } | undefined {
	const trimmed = remote.trim();
	const ssh = /^(?:ssh:\/\/)?git@bitbucket\.org[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
	if (ssh) return { workspace: ssh[1], slug: ssh[2].replace(/\.git$/, "") };
	try {
		const url = new URL(trimmed);
		if (url.hostname !== "bitbucket.org") return undefined;
		const [workspace, rawSlug] = url.pathname.replace(/^\//, "").split("/", 2);
		if (!workspace || !rawSlug) return undefined;
		return { workspace, slug: rawSlug.replace(/\.git$/, "") };
	} catch {
		return undefined;
	}
}

export function resolveBitbucketRepositories(
	repositories: Array<{ repository: string; root: string }>,
	workspace?: string,
): BitbucketRepositoryDescriptor[] {
	return repositories.flatMap((repository) => {
		const remoteNames = execFileSync("git", ["remote"], { cwd: repository.root, encoding: "utf8" })
			.split("\n")
			.map((name) => name.trim())
			.filter(Boolean);
		const preferred = ["upstream", "upstream-ssh", "origin", ...remoteNames];
		for (const remoteName of [...new Set(preferred)]) {
			let remote: string;
			try {
				remote = execFileSync("git", ["remote", "get-url", remoteName], {
					cwd: repository.root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				});
			} catch {
				continue;
			}
			const parsed = parseBitbucketRemote(remote);
			if (!parsed || (workspace && parsed.workspace !== workspace)) continue;
			return [{ repository: repository.repository, ...parsed }];
		}
		return [];
	});
}

function normalizePullRequest(
	repository: BitbucketRepositoryDescriptor,
	value: BitbucketPullRequestValue,
	prefixes: string[],
): BitbucketPullRequestEvidence | undefined {
	if (
		typeof value.id !== "number" ||
		typeof value.title !== "string" ||
		typeof value.source?.branch?.name !== "string" ||
		typeof value.destination?.branch?.name !== "string" ||
		typeof value.updated_on !== "string" ||
		typeof value.links?.html?.href !== "string"
	) {
		return undefined;
	}
	const linkage = extractAuthoritativeTicketKeys(
		{
			title: value.title,
			sourceBranch: value.source.branch.name,
			description: typeof value.description === "string" ? value.description : undefined,
		},
		prefixes,
	);
	return {
		repository: repository.repository,
		id: value.id,
		title: value.title,
		sourceBranch: value.source.branch.name,
		destinationBranch: value.destination.branch.name,
		updatedOn: value.updated_on,
		url: value.links.html.href,
		...linkage,
	};
}

async function fetchRepositoryPullRequests(
	repository: BitbucketRepositoryDescriptor,
	options: FetchBitbucketPullRequestsOptions,
	prefixes: string[],
): Promise<BitbucketPullRequestEvidence[]> {
	const query = encodeURIComponent('state="MERGED" AND destination.branch.name ~ "release/"');
	const fields = [
		"next",
		"values.id",
		"values.title",
		"values.description",
		"values.source.branch.name",
		"values.destination.branch.name",
		"values.updated_on",
		"values.links.html.href",
	].join(",");
	let next: string | undefined =
		`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.slug)}/pullrequests?q=${query}&sort=-updated_on&pagelen=50&fields=${fields}`;
	const pullRequests: BitbucketPullRequestEvidence[] = [];
	const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
	const fetchImpl = options.fetchImpl ?? fetch;
	while (next) {
		const response = await fetchImpl(next, { headers: { authorization, accept: "application/json" } });
		if (!response.ok) {
			throw new Error(
				`Bitbucket REST failed for ${repository.workspace}/${repository.slug}: ${response.status} ${response.statusText}`,
			);
		}
		const page = (await response.json()) as BitbucketPullRequestPage;
		if (!Array.isArray(page.values))
			throw new Error(`Bitbucket REST returned an invalid page for ${repository.slug}`);
		for (const value of page.values) {
			if (!value || typeof value !== "object") continue;
			const pullRequest = normalizePullRequest(repository, value as BitbucketPullRequestValue, prefixes);
			if (pullRequest) pullRequests.push(pullRequest);
		}
		next = typeof page.next === "string" ? page.next : undefined;
	}
	options.onRepository?.(repository.repository, pullRequests.length);
	return pullRequests;
}

export async function fetchMergedReleasePullRequests(
	options: FetchBitbucketPullRequestsOptions,
): Promise<BitbucketPullRequestEvidence[]> {
	if (!options.username || !options.password) throw new Error("Bitbucket credentials are unavailable");
	const prefixes = normalizedPrefixes(options.ticketPrefixes ?? DEFAULT_TICKET_PREFIXES);
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
	const results = new Array<BitbucketPullRequestEvidence[]>(options.repositories.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < options.repositories.length) {
			const index = next++;
			results[index] = await fetchRepositoryPullRequests(options.repositories[index], options, prefixes);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, options.repositories.length) }, () => worker()));
	return results.flat();
}

function snapshotKeys(directory: string, prefixes: string[]): Set<string> {
	const pattern = new RegExp(`_(?:${prefixes.join("|")})-\\d+\\.md$`);
	return new Set(
		readdirSync(directory).flatMap((file) => {
			const match = pattern.exec(file);
			return match ? [match[0].slice(1, -".md".length)] : [];
		}),
	);
}

export function buildBitbucketLinkageAudit(options: BuildBitbucketLinkageAuditOptions): BitbucketLinkageAudit {
	const prefixes = normalizedPrefixes(options.ticketPrefixes ?? DEFAULT_TICKET_PREFIXES);
	const latestLimit = Math.max(1, Math.min(options.latestLimit ?? 300, 10_000));
	const ordered = [...options.pullRequests].sort(
		(left, right) => right.updatedOn.localeCompare(left.updatedOn) || right.id - left.id,
	);
	const latest = ordered.slice(0, latestLimit);
	const latestTicketKeys = [...new Set(latest.flatMap((pullRequest) => pullRequest.ticketKeys))].sort();
	const snapshots = snapshotKeys(options.ticketDirectory, prefixes);
	const expertCaseRepositories = options.expertCaseRepositories ?? new Map<string, string[]>();
	const tickets = latestTicketKeys.map((ticketKey) => {
		const pullRequests = ordered.filter((pullRequest) => pullRequest.ticketKeys.includes(ticketKey));
		const repositories = [...new Set(pullRequests.map((pullRequest) => pullRequest.repository))].sort();
		const expertRepositories = [...new Set(expertCaseRepositories.get(ticketKey) ?? [])].sort();
		const complete = repositories.every((repository) => expertRepositories.includes(repository));
		return {
			ticketKey,
			repositories,
			pullRequests: pullRequests.map(({ repository, id, title, destinationBranch, updatedOn, url }) => ({
				repository,
				id,
				title,
				destinationBranch,
				updatedOn,
				url,
			})),
			snapshotAvailable: snapshots.has(ticketKey),
			expertCaseRepositories: expertRepositories,
			expertCaseCoverage:
				expertRepositories.length === 0
					? ("missing" as const)
					: complete
						? ("complete" as const)
						: ("partial" as const),
		};
	});
	const sourceFingerprint = expertHash({
		repositories: options.repositories,
		pullRequests: ordered,
		latestLimit,
		prefixes,
		expertManifest: options.expertManifest?.contentHash,
	});
	const core = {
		schemaVersion: 1 as const,
		auditId: `bitbucket-audit-${sourceFingerprint.slice(0, 24)}`,
		sourceFingerprint,
		sources: {
			repositories: options.repositories,
			latestLimit,
			ticketPrefixes: prefixes,
			expertManifestHash: options.expertManifest?.contentHash,
		},
		window: {
			newestUpdatedOn: latest[0]?.updatedOn,
			oldestUpdatedOn: latest.at(-1)?.updatedOn,
		},
		stats: {
			historicalReleasePullRequests: ordered.length,
			latestPullRequests: latest.length,
			latestWithAuthoritativeTicket: latest.filter((pullRequest) => pullRequest.ticketKeys.length > 0).length,
			latestWithoutAuthoritativeTicket: latest.filter((pullRequest) => pullRequest.ticketKeys.length === 0).length,
			latestWithDescriptionOnlyTicket: latest.filter(
				(pullRequest) => pullRequest.ticketKeys.length === 0 && pullRequest.descriptionOnlyTicketKeys.length > 0,
			).length,
			latestWithMultipleTickets: latest.filter((pullRequest) => pullRequest.ticketKeys.length > 1).length,
			uniqueTickets: latestTicketKeys.length,
			multiRepositoryTickets: tickets.filter((ticket) => ticket.repositories.length > 1).length,
			ticketsWithSnapshot: tickets.filter((ticket) => ticket.snapshotAvailable).length,
			ticketsWithExpertCase: tickets.filter((ticket) => ticket.expertCaseCoverage !== "missing").length,
			completeExpertCaseCoverage: tickets.filter((ticket) => ticket.expertCaseCoverage === "complete").length,
			partialExpertCaseCoverage: tickets.filter((ticket) => ticket.expertCaseCoverage === "partial").length,
		},
		tickets,
	};
	return { ...core, contentHash: expertHash(core) };
}

export function reconcileBitbucketLinkageAudit(options: ReconcileBitbucketLinkageAuditOptions): BitbucketLinkageAudit {
	const previous = options.previousAudit;
	const prefixes = normalizedPrefixes(previous.sources.ticketPrefixes);
	const snapshots = snapshotKeys(options.ticketDirectory, prefixes);
	const tickets = previous.tickets.map((ticket) => {
		const expertRepositories = [...new Set(options.expertCaseRepositories.get(ticket.ticketKey) ?? [])].sort();
		const complete = ticket.repositories.every((repository) => expertRepositories.includes(repository));
		return {
			...ticket,
			snapshotAvailable: snapshots.has(ticket.ticketKey),
			expertCaseRepositories: expertRepositories,
			expertCaseCoverage:
				expertRepositories.length === 0
					? ("missing" as const)
					: complete
						? ("complete" as const)
						: ("partial" as const),
		};
	});
	const baseAuditId = previous.sources.basedOnAuditId ?? previous.auditId;
	const sources = {
		...previous.sources,
		basedOnAuditId: baseAuditId,
		expertManifestHash: options.expertManifest.contentHash,
	};
	const stats = {
		...previous.stats,
		ticketsWithSnapshot: tickets.filter((ticket) => ticket.snapshotAvailable).length,
		ticketsWithExpertCase: tickets.filter((ticket) => ticket.expertCaseCoverage !== "missing").length,
		completeExpertCaseCoverage: tickets.filter((ticket) => ticket.expertCaseCoverage === "complete").length,
		partialExpertCaseCoverage: tickets.filter((ticket) => ticket.expertCaseCoverage === "partial").length,
	};
	const sourceFingerprint = expertHash({ baseAuditId, sources, window: previous.window, stats, tickets });
	const core = {
		schemaVersion: 1 as const,
		auditId: `bitbucket-audit-${sourceFingerprint.slice(0, 24)}`,
		sourceFingerprint,
		sources,
		window: previous.window,
		stats,
		tickets,
	};
	return { ...core, contentHash: expertHash(core) };
}
