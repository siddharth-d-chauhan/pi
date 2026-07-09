/**
 * Agent index — the persistence that makes "converse forever" survive a
 * restart. Every adopted (idle/parked) agent with a session file gets an
 * entry in `<agentDir>/agent-index.json`; on session start, the cold scan
 * re-registers entries whose parent matches the current session as PARKED
 * agents, revivable through the normal lifecycle.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AgentIndexEntry {
	registryId: string;
	agentType: string;
	label: string;
	sessionFile: string;
	parentSessionFile?: string;
	subagentDepth: number;
	tools?: string[];
	excludeTools?: string[];
	customPrompt?: string;
	omitProjectContext?: boolean;
	spawns?: string[] | "*" | "none";
	thinkingLevel?: string;
	modelProvider: string;
	modelId: string;
	savedAt: number;
}

const MAX_INDEX_ENTRIES = 200;

export function agentIndexPath(agentDir: string): string {
	return join(agentDir, "agent-index.json");
}

export function loadAgentIndex(agentDir: string): AgentIndexEntry[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(agentIndexPath(agentDir), "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is AgentIndexEntry =>
				entry !== null &&
				typeof entry === "object" &&
				typeof (entry as AgentIndexEntry).registryId === "string" &&
				typeof (entry as AgentIndexEntry).sessionFile === "string",
		);
	} catch {
		return [];
	}
}

function save(agentDir: string, entries: AgentIndexEntry[]): void {
	const file = agentIndexPath(agentDir);
	const tmp = `${file}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(entries.slice(-MAX_INDEX_ENTRIES), null, "\t")}\n`);
		renameSync(tmp, file);
	} catch {
		// Index persistence is best-effort; never break a spawn over it.
	}
}

export function saveAgentIndexEntry(agentDir: string, entry: AgentIndexEntry): void {
	const entries = loadAgentIndex(agentDir).filter((existing) => existing.registryId !== entry.registryId);
	entries.push(entry);
	save(agentDir, entries);
}

export function removeAgentIndexEntry(agentDir: string, registryId: string): void {
	const entries = loadAgentIndex(agentDir);
	const filtered = entries.filter((entry) => entry.registryId !== registryId);
	if (filtered.length !== entries.length) save(agentDir, filtered);
}

/**
 * Entries revivable for a given parent session: same parent file, session
 * file still on disk. Stale entries (missing files) are pruned as a side
 * effect.
 */
export function coldAgentsForParent(agentDir: string, parentSessionFile: string | undefined): AgentIndexEntry[] {
	if (!parentSessionFile) return [];
	const entries = loadAgentIndex(agentDir);
	const alive = entries.filter((entry) => existsSync(entry.sessionFile));
	if (alive.length !== entries.length) save(agentDir, alive);
	return alive.filter((entry) => entry.parentSessionFile === parentSessionFile);
}
