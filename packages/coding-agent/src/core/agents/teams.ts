/**
 * Teams — named roster presets that override agent model routing and
 * availability at runtime.
 *
 * A team is a YAML file:
 *
 *   name: fast
 *   description: Cheap models everywhere
 *   modelOverrides:            # agentType -> model or role alias
 *     worker: pi/smol
 *     reviewer: pi/smol
 *   roles:                     # role alias -> priority chain (merged over settings)
 *     smol: ["minimax/MiniMax-M3"]
 *   disabled: [plan]           # agent types hidden while this team is active
 *   coordinatorNote: |         # optional prompt snippet the integrator may inject
 *     Prefer many small parallel workers over one large one.
 *
 * Discovery: project `.pi/teams/*.yaml|yml` then user `<agentDir>/teams/`
 * (first name wins). One team may be active at a time (module singleton);
 * `applyTeamToRouting` merges the active team over the settings-derived
 * routing wherever agent settings are consulted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface TeamDefinition {
	name: string;
	description?: string;
	/** agentType -> model spec or `pi/<role>` alias. */
	modelOverrides: Record<string, string>;
	/** role alias -> priority chain, merged over `agents.roles` settings. */
	roles: Record<string, string[]>;
	/** Agent types hidden while this team is active. */
	disabled: string[];
	/** Optional prompt snippet the integrator may inject for coordinators. */
	coordinatorNote?: string;
	source: "project" | "user";
	filePath: string;
}

export class TeamValidationError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseStringRecord(value: unknown, filePath: string, key: string): Record<string, string> {
	if (value === undefined) return {};
	const record = asRecord(value);
	if (!record) {
		throw new TeamValidationError(`${filePath}: "${key}" must be a mapping of agent type → model spec`);
	}
	const result: Record<string, string> = {};
	for (const [entryKey, entryValue] of Object.entries(record)) {
		if (typeof entryValue !== "string" || !entryValue.trim()) {
			throw new TeamValidationError(`${filePath}: "${key}.${entryKey}" must be a non-empty string`);
		}
		result[entryKey] = entryValue;
	}
	return result;
}

function parseRoles(value: unknown, filePath: string): Record<string, string[]> {
	if (value === undefined) return {};
	const record = asRecord(value);
	if (!record) {
		throw new TeamValidationError(`${filePath}: "roles" must be a mapping of role alias → list of model specs`);
	}
	const result: Record<string, string[]> = {};
	for (const [role, chainRaw] of Object.entries(record)) {
		if (!Array.isArray(chainRaw) || !chainRaw.every((entry) => typeof entry === "string")) {
			throw new TeamValidationError(`${filePath}: "roles.${role}" must be a list of model spec strings`);
		}
		result[role] = chainRaw as string[];
	}
	return result;
}

function parseDisabled(value: unknown, filePath: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new TeamValidationError(`${filePath}: "disabled" must be a list of agent type strings`);
	}
	return value as string[];
}

/** Parse + validate one team file. Throws TeamValidationError with a helpful message. */
export function parseTeam(rawContent: string, filePath: string, source: TeamDefinition["source"]): TeamDefinition {
	let parsed: unknown;
	try {
		parsed = parseYaml(rawContent);
	} catch (err) {
		throw new TeamValidationError(`${filePath}: invalid YAML — ${(err as Error).message}`);
	}
	const root = asRecord(parsed);
	if (!root) throw new TeamValidationError(`${filePath}: team file must be a YAML mapping`);
	const name = typeof root.name === "string" ? root.name.trim().toLowerCase() : "";
	if (!name) throw new TeamValidationError(`${filePath}: missing required "name"`);

	return {
		name,
		description: typeof root.description === "string" ? root.description : undefined,
		modelOverrides: parseStringRecord(root.modelOverrides, filePath, "modelOverrides"),
		roles: parseRoles(root.roles, filePath),
		disabled: parseDisabled(root.disabled, filePath),
		coordinatorNote:
			typeof root.coordinatorNote === "string" && root.coordinatorNote.trim() ? root.coordinatorNote : undefined,
		source,
		filePath,
	};
}

export interface LoadTeamsOptions {
	cwd: string;
	agentDir: string;
}

export interface LoadTeamsResult {
	teams: Map<string, TeamDefinition>;
	/** Per-file parse errors (bad user files never break loading). */
	errors: string[];
}

function teamFilesIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
			.map((name) => join(dir, name))
			.sort();
	} catch {
		return [];
	}
}

export function loadTeams(opts: LoadTeamsOptions): LoadTeamsResult {
	const teams = new Map<string, TeamDefinition>();
	const errors: string[] = [];
	const sources: Array<{ dir: string; source: TeamDefinition["source"] }> = [
		{ dir: join(opts.cwd, ".pi", "teams"), source: "project" },
		{ dir: join(opts.agentDir, "teams"), source: "user" },
	];
	for (const { dir, source } of sources) {
		for (const filePath of teamFilesIn(dir)) {
			try {
				const team = parseTeam(readFileSync(filePath, "utf8"), filePath, source);
				if (!teams.has(team.name)) teams.set(team.name, team);
			} catch (err) {
				errors.push((err as Error).message);
			}
		}
	}
	return { teams, errors };
}

// ---------------------------------------------------------------------------
// Active-team runtime state (module singleton — core-only access)
// ---------------------------------------------------------------------------

let activeTeam: TeamDefinition | undefined;
const teamListeners = new Set<(team: TeamDefinition | undefined) => void>();

export function setActiveTeam(team: TeamDefinition | undefined): void {
	activeTeam = team;
	for (const listener of teamListeners) listener(team);
}

export function getActiveTeam(): TeamDefinition | undefined {
	return activeTeam;
}

/** Subscribe to active-team changes. Returns an unsubscribe function. */
export function onTeamChange(listener: (team: TeamDefinition | undefined) => void): () => void {
	teamListeners.add(listener);
	return () => teamListeners.delete(listener);
}

export function resetTeamsForTests(): void {
	activeTeam = undefined;
	teamListeners.clear();
}

// ---------------------------------------------------------------------------
// Routing merge
// ---------------------------------------------------------------------------

export interface EffectiveAgentRouting {
	modelOverrides: Record<string, string>;
	roles: Record<string, string[]>;
	disabled: string[];
}

/**
 * Merge the active team over settings-derived routing. Team values win
 * per-key; `disabled` is the union. With no active team, `base` is
 * returned unchanged.
 */
export function applyTeamToRouting(base: EffectiveAgentRouting): EffectiveAgentRouting {
	if (!activeTeam) return base;
	return {
		modelOverrides: { ...base.modelOverrides, ...activeTeam.modelOverrides },
		roles: { ...base.roles, ...activeTeam.roles },
		disabled: [...new Set([...base.disabled, ...activeTeam.disabled])],
	};
}
