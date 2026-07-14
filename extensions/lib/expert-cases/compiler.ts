import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	type ExpertCaseManifest,
	type ExpertCasePublic,
	type ExpertCaseSealed,
	type ExpertCaseSplit,
	expertHash,
	type GitChangeSet,
	type KpFact,
	type RepositoryDescriptor,
	type RepositoryOutcome,
	type TicketSnapshot,
} from "./contracts.ts";

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const TEST_PATH = /(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\.[^.]+$/i;
const EXPERT_CASE_COMPILER_VERSION = 4;

export interface ExpertCaseCompilation {
	manifest: ExpertCaseManifest;
	publicCases: ExpertCasePublic[];
	sealedCases: ExpertCaseSealed[];
}

export interface CompileExpertCasesOptions {
	ticketDirectory: string;
	repositories: RepositoryDescriptor[];
	groupId: string;
	getFacts?: (ticketKey: string) => Promise<KpFact[]>;
	maxCases?: number;
	pullRequestTicketKeys?: ReadonlyMap<string, readonly string[]>;
}

function parseJiraDate(value: string): string | undefined {
	const match = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec(value.trim());
	if (!match) return undefined;
	const months: Record<string, number> = {
		Jan: 1,
		Feb: 2,
		Mar: 3,
		Apr: 4,
		May: 5,
		Jun: 6,
		Jul: 7,
		Aug: 8,
		Sep: 9,
		Oct: 10,
		Nov: 11,
		Dec: 12,
	};
	const month = months[match[2]];
	if (!month) return undefined;
	let hour = Number(match[4]) % 12;
	if (match[6] === "PM") hour += 12;
	const year = 2000 + Number(match[3]);
	return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${match[1].padStart(2, "0")}T${hour.toString().padStart(2, "0")}:${match[5]}:00`;
}

export function parseTicketSnapshot(path: string): TicketSnapshot {
	const raw = readFileSync(path, "utf-8");
	const lines = raw.split("\n");
	const header = /^#\s+([A-Z][A-Z0-9]+-\d+)\s+—\s+(.+?)\s+—\s+(.+)$/.exec(lines[0]?.trim() ?? "");
	if (!header) throw new Error(`invalid Jira snapshot header: ${path}`);
	const meta = raw.match(/_meta:\s*[^·]+\s*·\s*[^·]+\s*·[\s\S]*?created\s+(.+?)\s*·\s*resolved\s*(.*?)_/);
	const title = (lines[1] ?? "").trim();
	const bodyStart = Math.max(
		2,
		lines.findIndex((line, index) => index > 0 && line.trim().length > 0),
	);
	const taskLines: string[] = [];
	for (const line of lines.slice(bodyStart)) {
		if (/^## (?:Code & release context|Implementation & discussion notes)/i.test(line)) break;
		if (/^_meta:/.test(line)) break;
		taskLines.push(line);
	}
	const taskBody = taskLines.join("\n").trim();
	return {
		key: header[1],
		type: header[2].trim(),
		status: header[3].trim(),
		title,
		taskText: taskBody ? `${title}\n\n${taskBody}` : title,
		createdAtLocal: meta?.[1] ? parseJiraDate(meta[1]) : undefined,
		resolvedAtLocal: meta?.[2] ? parseJiraDate(meta[2]) : undefined,
		sourceLocator: `jira://${header[1]}`,
		snapshotPath: path,
		snapshotHash: expertHash(raw),
	};
}

function git(repo: string, args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}

function repositoryHead(root: string): string {
	return git(root, ["rev-parse", "HEAD"]).trim();
}

function verificationHints(root: string): string[] {
	const hints: string[] = [];
	if (existsSync(join(root, "package.json"))) hints.push("use the repository's focused package test script");
	if (existsSync(join(root, "pom.xml"))) hints.push("run the affected Maven module tests");
	if (existsSync(join(root, "gradlew"))) hints.push("run the affected Gradle test task");
	if (existsSync(join(root, "test.sh"))) hints.push("run ./test.sh or the narrow equivalent");
	return hints;
}

function scanRepository(
	repo: RepositoryDescriptor,
	pullRequestTicketKeys: ReadonlyMap<string, readonly string[]>,
): Map<string, RepositoryOutcome> {
	const format = "%x1e%H%x1f%P%x1f%aI%x1f%cI%x1f%B%x1d";
	const raw = git(repo.root, ["log", "--all", "--name-only", "--diff-merges=first-parent", `--format=${format}`]);
	const grouped = new Map<
		string,
		{
			commits: RepositoryOutcome["commits"];
			methods: Set<RepositoryOutcome["linkage"]["method"]>;
		}
	>();
	for (const record of raw.split("\x1e")) {
		if (!record.trim()) continue;
		const [metadata, pathBlock = ""] = record.split("\x1d", 2);
		const [hash, parentText, authorDate, committerDate, ...bodyParts] = metadata.split("\x1f");
		if (!hash || !authorDate || !committerDate) continue;
		const body = bodyParts.join("\x1f").trim();
		const summary = body.split("\n")[0]?.slice(0, 500) ?? "";
		const summaryKeys = new Set((summary.toUpperCase().match(TICKET_KEY) ?? []).map((key) => key.toUpperCase()));
		const pullRequestId = /pull request #(\d+)/i.exec(summary)?.[1];
		const mappedKeys = new Set(
			pullRequestId ? (pullRequestTicketKeys.get(`${repo.repository}\0${pullRequestId}`) ?? []) : [],
		);
		const keys = new Set([...summaryKeys, ...mappedKeys]);
		if (keys.size === 0) continue;
		const kind = /^revert\b/i.test(summary)
			? ("revert" as const)
			: pullRequestId
				? ("pull_request_merge" as const)
				: /^merge(?:d|ing)?\b/i.test(summary)
					? ("branch_sync" as const)
					: ("direct" as const);
		const changedPaths = [
			...new Set(
				pathBlock
					.split("\n")
					.map((path) => path.trim())
					.filter(Boolean),
			),
		].sort();
		const commit = {
			hash,
			parents: parentText.trim() ? parentText.trim().split(/\s+/) : [],
			authorDate,
			committerDate,
			summary,
			changedPaths,
			kind,
			pullRequestId,
		};
		for (const key of keys) {
			const group = grouped.get(key) ?? { commits: [], methods: new Set() };
			group.commits.push(commit);
			group.methods.add(
				summaryKeys.has(key) ? "exact_ticket_key_in_commit_summary" : "authoritative_bitbucket_pr_to_merge_commit",
			);
			grouped.set(key, group);
		}
	}
	const outcomes = new Map<string, RepositoryOutcome>();
	for (const [key, group] of grouped) {
		const { commits, methods } = group;
		commits.sort(
			(left, right) => left.committerDate.localeCompare(right.committerDate) || left.hash.localeCompare(right.hash),
		);
		const authoritative = commits.filter((commit) => commit.kind !== "branch_sync");
		const selected = authoritative.length > 0 ? authoritative : commits;
		const first = selected[0];
		const last = selected[selected.length - 1];
		if (!first.parents[0]) continue;
		const changedPaths = [...new Set(selected.flatMap((commit) => commit.changedPaths))].sort();
		const method = methods.has("exact_ticket_key_in_commit_summary")
			? "exact_ticket_key_in_commit_summary"
			: "authoritative_bitbucket_pr_to_merge_commit";
		outcomes.set(key, {
			repository: repo.repository,
			root: repo.root,
			preChangeRevision: first.parents[0],
			postChangeRevision: last.hash,
			commits: selected,
			changeSets: createChangeSets(repo.repository, key, selected),
			changedPaths,
			testPaths: changedPaths.filter((path) => TEST_PATH.test(path)),
			verificationHints: verificationHints(repo.root),
			firstImplementationAt: first.committerDate,
			lastImplementationAt: last.committerDate,
			linkage: {
				method,
				confidence: authoritative.length > 0 ? "high" : "low",
				reasons:
					authoritative.length > 0
						? [
								method === "exact_ticket_key_in_commit_summary"
									? "ticket key appears in an authoritative commit or pull-request summary"
									: "authoritative Bitbucket PR metadata maps the ticket to this merge commit",
							]
						: ["only branch-sync merges mention the ticket key"],
			},
		});
	}
	return outcomes;
}

function createChangeSets(
	repository: string,
	ticketKey: string,
	commits: RepositoryOutcome["commits"],
): GitChangeSet[] {
	const groups: RepositoryOutcome["commits"][] = [];
	for (const commit of commits) {
		if (commit.pullRequestId || commit.kind === "revert") {
			groups.push([commit]);
			continue;
		}
		const previous = groups.at(-1);
		const previousCommit = previous?.at(-1);
		const gapMs = previousCommit
			? Date.parse(commit.committerDate) - Date.parse(previousCommit.committerDate)
			: Number.POSITIVE_INFINITY;
		if (!previous || previousCommit?.pullRequestId || previousCommit?.kind === "revert" || gapMs > 14 * 86_400_000) {
			groups.push([commit]);
		} else {
			previous.push(commit);
		}
	}
	return groups.flatMap((group) => {
		const first = group[0];
		const last = group[group.length - 1];
		if (!first.parents[0]) return [];
		const changedPaths = [...new Set(group.flatMap((commit) => commit.changedPaths))].sort();
		const identity = first.pullRequestId
			? `pr-${first.pullRequestId}`
			: first.kind === "revert"
				? `revert-${first.hash}`
				: `commits-${first.hash}`;
		return [
			{
				changeSetId: `${repository}:${ticketKey}:${identity}`,
				kind: first.kind,
				pullRequestId: first.pullRequestId,
				preChangeRevision: first.parents[0],
				postChangeRevision: last.hash,
				commits: group,
				changedPaths,
				testPaths: changedPaths.filter((path) => TEST_PATH.test(path)),
				firstImplementationAt: first.committerDate,
				lastImplementationAt: last.committerDate,
			},
		];
	});
}

function assessLinkage(ticket: TicketSnapshot, outcome: RepositoryOutcome): RepositoryOutcome {
	const reasons = [...outcome.linkage.reasons];
	let confidence = outcome.linkage.confidence;
	if (outcome.changeSets.some((changeSet) => changeSet.changedPaths.length > 500)) {
		if (confidence === "high") confidence = "medium";
		reasons.push("at least one change set touches more than 500 paths");
	}
	const createdAt = ticket.createdAtLocal ? Date.parse(ticket.createdAtLocal) : Number.NaN;
	const implementationAt = Date.parse(outcome.firstImplementationAt);
	if (Number.isFinite(createdAt) && Number.isFinite(implementationAt) && implementationAt < createdAt - 86_400_000) {
		confidence = "low";
		reasons.push("the earliest matching commit predates the ticket snapshot creation time");
	}
	return { ...outcome, linkage: { ...outcome.linkage, confidence, reasons } };
}

function assignSplits(tickets: TicketSnapshot[]): Map<string, ExpertCaseSplit> {
	const ordered = [...tickets].sort(
		(left, right) =>
			(left.createdAtLocal ?? "9999").localeCompare(right.createdAtLocal ?? "9999") ||
			left.key.localeCompare(right.key),
	);
	const splits = new Map<string, ExpertCaseSplit>();
	for (const [index, ticket] of ordered.entries()) {
		const ratio = (index + 1) / ordered.length;
		splits.set(ticket.key, ratio <= 0.8 ? "train" : ratio <= 0.9 ? "calibration" : "held_out");
	}
	return splits;
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
	return results;
}

export async function compileExpertCases(options: CompileExpertCasesOptions): Promise<ExpertCaseCompilation> {
	const ticketFiles = readdirSync(options.ticketDirectory)
		.filter((name) => /^\d{4}_[A-Z][A-Z0-9]+-\d+\.md$/.test(name))
		.sort();
	const tickets = ticketFiles.map((name) => parseTicketSnapshot(join(options.ticketDirectory, name)));
	const ticketsByKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
	const reposByRoot = new Map<string, RepositoryDescriptor>();
	for (const repo of options.repositories) {
		const root = resolve(repo.root);
		if (!reposByRoot.has(root)) reposByRoot.set(root, { ...repo, root });
	}
	const uniqueRepos = [...reposByRoot.values()]
		.filter((repo) => existsSync(join(repo.root, ".git")))
		.sort((left, right) => left.repository.localeCompare(right.repository));
	const pullRequestTicketKeys = options.pullRequestTicketKeys ?? new Map<string, readonly string[]>();
	const scans = uniqueRepos.map((repo) => ({
		repo,
		outcomes: scanRepository(repo, pullRequestTicketKeys),
		head: repositoryHead(repo.root),
	}));
	const outcomesByTicket = new Map<string, RepositoryOutcome[]>();
	for (const { outcomes } of scans) {
		for (const [ticketKey, outcome] of outcomes) {
			if (!ticketsByKey.has(ticketKey)) continue;
			const list = outcomesByTicket.get(ticketKey) ?? [];
			list.push(assessLinkage(ticketsByKey.get(ticketKey)!, outcome));
			outcomesByTicket.set(ticketKey, list);
		}
	}
	let linkedTickets = tickets.filter((ticket) => outcomesByTicket.has(ticket.key));
	if (options.maxCases !== undefined) linkedTickets = linkedTickets.slice(0, Math.max(0, options.maxCases));
	const facts = options.getFacts
		? await mapConcurrent(linkedTickets, 4, async (ticket) => options.getFacts?.(ticket.key) ?? [])
		: linkedTickets.map(() => []);
	const splitByTicket = assignSplits(linkedTickets);
	const publicCases: ExpertCasePublic[] = [];
	const sealedCases: ExpertCaseSealed[] = [];
	for (const [index, ticket] of linkedTickets.entries()) {
		const outcomes = (outcomesByTicket.get(ticket.key) ?? []).sort((left, right) =>
			left.repository.localeCompare(right.repository),
		);
		const split = splitByTicket.get(ticket.key) ?? ("train" as const);
		const caseId = `case-${expertHash({ compilerVersion: EXPERT_CASE_COMPILER_VERSION, ticket: ticket.snapshotHash, facts: facts[index], outcomes, split }).slice(0, 24)}`;
		const publicCore = {
			schemaVersion: 1 as const,
			caseId,
			ticket,
			split,
			repositories: outcomes.map((outcome) => ({
				repository: outcome.repository,
				preChangeRevision: outcome.preChangeRevision,
			})),
			temporalCutoff: ticket.createdAtLocal,
			eligibility: {
				learning: outcomes.every((outcome) => outcome.linkage.confidence !== "low"),
				leakageFreeEvaluation: false,
				reasons: [
					"current Jira export has no field-level changelog or historical as-of snapshot",
					"ticket prose may contain implementation notes added after work began",
					...(ticket.createdAtLocal ? [] : ["ticket creation time is unavailable"]),
					...(outcomes.some((outcome) => outcome.linkage.confidence === "low")
						? ["at least one repository linkage is low confidence"]
						: []),
				],
			},
		};
		const publicCase: ExpertCasePublic = { ...publicCore, contentHash: expertHash(publicCore) };
		const sealedCore = {
			schemaVersion: 1 as const,
			caseId,
			publicCaseHash: publicCase.contentHash,
			kpFacts: facts[index],
			outcomes,
		};
		publicCases.push(publicCase);
		sealedCases.push({ ...sealedCore, contentHash: expertHash(sealedCore) });
	}
	const cases = publicCases.map((publicCase, index) => ({
		caseId: publicCase.caseId,
		ticketKey: publicCase.ticket.key,
		split: publicCase.split,
		publicHash: publicCase.contentHash,
		sealedHash: sealedCases[index].contentHash,
	}));
	const ticketCorpusHash = expertHash(tickets.map((ticket) => ({ key: ticket.key, hash: ticket.snapshotHash })));
	const sourceRepositories = scans.map(({ repo, head }) => ({ repository: repo.repository, root: repo.root, head }));
	const sourceFingerprint = expertHash({ ticketCorpusHash, repositories: sourceRepositories, cases });
	const bySplit: Record<ExpertCaseSplit, number> = { train: 0, calibration: 0, held_out: 0 };
	for (const item of cases) bySplit[item.split] += 1;
	const linkageConfidence = { high: 0, medium: 0, low: 0 };
	for (const sealedCase of sealedCases) {
		const confidence = sealedCase.outcomes.some((outcome) => outcome.linkage.confidence === "low")
			? "low"
			: sealedCase.outcomes.some((outcome) => outcome.linkage.confidence === "medium")
				? "medium"
				: "high";
		linkageConfidence[confidence] += 1;
	}
	const manifestCore = {
		schemaVersion: 1 as const,
		manifestId: `expert-${sourceFingerprint.slice(0, 24)}`,
		groupId: options.groupId,
		sourceFingerprint,
		sources: {
			ticketDirectory: resolve(options.ticketDirectory),
			ticketCorpusHash,
			repositories: sourceRepositories,
		},
		cases,
		stats: {
			ticketsSeen: tickets.length,
			linkedTickets: linkedTickets.length,
			unlinkedTickets: tickets.length - linkedTickets.length,
			cases: cases.length,
			repositories: uniqueRepos.length,
			multiRepositoryCases: sealedCases.filter((item) => item.outcomes.length > 1).length,
			learningReadyCases: publicCases.filter((item) => item.eligibility.learning).length,
			evaluationReadyCases: publicCases.filter((item) => item.eligibility.leakageFreeEvaluation).length,
			kpFactCoverage: sealedCases.length
				? sealedCases.filter((item) =>
						item.kpFacts.some((fact) => fact.state === "confirmed" || fact.state === "supported"),
					).length / sealedCases.length
				: 0,
			linkageConfidence,
			bySplit,
		},
	};
	return {
		manifest: { ...manifestCore, contentHash: expertHash(manifestCore) },
		publicCases,
		sealedCases,
	};
}

export function parseRepoList(value: unknown): RepositoryDescriptor[] {
	const obj = value as { repos?: unknown };
	if (!Array.isArray(obj?.repos)) return [];
	return obj.repos.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const row = entry as Record<string, unknown>;
		if (typeof row.repository !== "string" || typeof row.root !== "string") return [];
		return [
			{
				repository: row.repository,
				root: row.root,
				branch: typeof row.branch === "string" ? row.branch : undefined,
			},
		];
	});
}

export function parseFacts(value: unknown): KpFact[] {
	const obj = value as { facts?: unknown };
	if (!Array.isArray(obj?.facts)) return [];
	return obj.facts.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const row = entry as Record<string, unknown>;
		if ([row.src, row.rel, row.dst, row.fact, row.state].some((item) => typeof item !== "string")) return [];
		return [
			{
				src: row.src as string,
				rel: row.rel as string,
				dst: row.dst as string,
				fact: row.fact as string,
				state: row.state as string,
			},
		];
	});
}

export function ticketKeyFromSnapshotName(name: string): string | undefined {
	return basename(name, ".md").match(/_([A-Z][A-Z0-9]+-\d+)$/)?.[1];
}
