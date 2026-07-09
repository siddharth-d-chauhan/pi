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
 * A team may also declare a ROSTER — specialized members working together
 * under a coordinating lead:
 *
 *   lead:                      # optional; synthesized whenever members exist
 *     agent: plan              # base definition for the lead (optional)
 *     model: pi/main
 *     effort: high             # reasoning effort (thinking level) override
 *     briefing: |              # appended to the lead's coordination protocol
 *       Ship small; verify before reporting done.
 *   members:                   # member name -> specialist built on a base type
 *     frontend:
 *       agent: worker
 *       model: pi/smol
 *       effort: low
 *       persona: "UI specialist: components, styling, accessibility."
 *     qa:
 *       agent: reviewer
 *       persona: "Verify the team's work against acceptance criteria."
 *
 * While the team is active, `applyTeamToDefinitions` materializes members
 * (and a "lead") as real spawnable agent definitions: the lead's spawn
 * allowlist is exactly the member names, members get the persona layered
 * onto the base system prompt and cannot sub-spawn. Coordination happens
 * through the normal platform: the agent tool to hire, agent_message to
 * converse (members stay addressable after finishing).
 *
 * Discovery: project `.pi/teams/*.yaml|yml` then user `<agentDir>/teams/`
 * (first name wins). One team may be active at a time (module singleton);
 * `applyTeamToRouting` merges the active team over the settings-derived
 * routing wherever agent settings are consulted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { parse as parseYaml } from "yaml";
import type { AgentDefinition, AgentDefinitionRegistry } from "./definitions.ts";

export interface TeamMember {
	/** Base agent definition type this member is built on (e.g. "worker"). */
	agent: string;
	/** Specialty layered onto the base system prompt as the member's role. */
	persona?: string;
	/** Model spec or `pi/<role>` alias override for this member. */
	model?: string;
	/** Reasoning effort (thinking level) override for this member. */
	effort?: ThinkingLevel;
}

export interface TeamLead {
	/** Base definition for the lead (default: a built-in coordinator). */
	agent?: string;
	/** Model spec or `pi/<role>` alias override for the lead. */
	model?: string;
	/** Reasoning effort (thinking level) override for the lead. */
	effort?: ThinkingLevel;
	/** Extra briefing appended to the lead's coordination protocol. */
	briefing?: string;
}

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
	/** Roster: member name -> specialist definition overlay. */
	members: Record<string, TeamMember>;
	/** Lead configuration (only meaningful when members exist). */
	lead?: TeamLead;
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

function optionalString(
	record: Record<string, unknown>,
	key: string,
	filePath: string,
	where: string,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw new TeamValidationError(`${filePath}: "${where}.${key}" must be a non-empty string`);
	}
	return value;
}

const VALID_EFFORT_LEVELS = new Set(["off", "minimal", "low", "medium", "high"]);

function optionalEffort(record: Record<string, unknown>, filePath: string, where: string): ThinkingLevel | undefined {
	const value = record.effort ?? record.thinking;
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !VALID_EFFORT_LEVELS.has(value)) {
		throw new TeamValidationError(
			`${filePath}: "${where}.effort" must be one of ${[...VALID_EFFORT_LEVELS].join(", ")}`,
		);
	}
	return value as ThinkingLevel;
}

function parseMembers(value: unknown, filePath: string): Record<string, TeamMember> {
	if (value === undefined) return {};
	const record = asRecord(value);
	if (!record) {
		throw new TeamValidationError(`${filePath}: "members" must be a mapping of member name → member config`);
	}
	const result: Record<string, TeamMember> = {};
	for (const [rawName, rawMember] of Object.entries(record)) {
		const name = rawName.trim().toLowerCase();
		if (!name) throw new TeamValidationError(`${filePath}: member names must be non-empty`);
		if (name === "lead") {
			throw new TeamValidationError(`${filePath}: member name "lead" is reserved for the team lead`);
		}
		const member = asRecord(rawMember);
		if (!member) {
			throw new TeamValidationError(`${filePath}: "members.${name}" must be a mapping (agent, persona, model)`);
		}
		const agent = optionalString(member, "agent", filePath, `members.${name}`);
		if (!agent) {
			throw new TeamValidationError(
				`${filePath}: "members.${name}.agent" is required (base agent type, e.g. worker)`,
			);
		}
		result[name] = {
			agent: agent.trim().toLowerCase(),
			persona: optionalString(member, "persona", filePath, `members.${name}`),
			model: optionalString(member, "model", filePath, `members.${name}`),
			effort: optionalEffort(member, filePath, `members.${name}`),
		};
	}
	return result;
}

function parseLead(value: unknown, filePath: string): TeamLead | undefined {
	if (value === undefined) return undefined;
	const record = asRecord(value);
	if (!record) {
		throw new TeamValidationError(`${filePath}: "lead" must be a mapping (agent, model, briefing)`);
	}
	return {
		agent: optionalString(record, "agent", filePath, "lead")?.trim().toLowerCase(),
		model: optionalString(record, "model", filePath, "lead"),
		effort: optionalEffort(record, filePath, "lead"),
		briefing: optionalString(record, "briefing", filePath, "lead"),
	};
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
		members: parseMembers(root.members, filePath),
		lead: parseLead(root.lead, filePath),
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

// ---------------------------------------------------------------------------
// Roster materialization — members + lead as real agent definitions
// ---------------------------------------------------------------------------

const LEAD_NAME = "lead";
const LEAD_DEFAULT_TOOLS = ["read", "grep", "find", "ls", "agent", "agent_message", "agent_list", "agent_pull"];

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

function synthesizeMember(
	name: string,
	member: TeamMember,
	base: AgentDefinition,
	team: TeamDefinition,
): AgentDefinition {
	const persona = member.persona?.trim();
	const rolePrompt = [
		`## TEAM ROLE`,
		`You are "${name}", a specialist on team "${team.name}".`,
		persona ? `Specialty: ${persona}` : undefined,
		`Stay inside your specialty; report back to your lead with a tight, self-contained summary (≤15 lines).`,
		`You cannot spawn further agents — if work is out of scope, say so in your report instead of attempting it.`,
		`You share the repository working tree with your teammates. If a TEAM MEMORY section is present, read it before starting; if you can write, record durable team-relevant findings there.`,
	]
		.filter(Boolean)
		.join("\n");
	return {
		...base,
		name,
		description: persona ? firstLine(persona) : `${base.description} (team "${team.name}" member)`,
		systemPrompt: `${base.systemPrompt.trim()}\n\n${rolePrompt}`,
		model: member.model ?? base.model,
		thinkingLevel: member.effort ?? base.thinkingLevel,
		spawns: "none",
		source: team.source,
		filePath: team.filePath,
	};
}

function synthesizeLead(
	team: TeamDefinition,
	memberDefs: Map<string, AgentDefinition>,
	base?: AgentDefinition,
): AgentDefinition {
	const memberNames = [...memberDefs.keys()];
	const rosterLines = [...memberDefs.entries()].map(([name, def]) => {
		const member = team.members[name];
		const traits = [
			`base: ${member?.agent}`,
			member?.model ? `model: ${member.model}` : undefined,
			member?.effort ? `effort: ${member.effort}` : undefined,
		].filter(Boolean);
		return `- ${name} (${traits.join(", ")}): ${def.description}`;
	});
	const protocol = [
		`## YOUR TEAM ("${team.name}")`,
		`You are the LEAD of a team of specialists. Your job is coordination and synthesis, not doing the specialists' work yourself.`,
		``,
		`Members (spawn by name with the agent tool):`,
		...rosterLines,
		``,
		`Coordination protocol:`,
		`- Decompose the task and delegate to the right specialist(s); run independent work in parallel (one agent call, multiple tasks).`,
		`- Give each member a tight, self-contained brief with acceptance criteria; do not forward your whole context.`,
		`- Members stay addressable after finishing — use agent_message to follow up or relay context between members instead of re-spawning.`,
		`- Members cannot sub-spawn; you are the only coordinator.`,
		`- The team shares the workspace and a TEAM MEMORY file (shown when it exists). Put relevant shared notes in each brief, and have write-capable members log durable findings to team memory.`,
		`- Synthesize member reports into one final answer for your caller. Never paste raw member transcripts.`,
		team.coordinatorNote ? `\n${team.coordinatorNote.trim()}` : undefined,
		team.lead?.briefing ? `\n${team.lead.briefing.trim()}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");

	// The lead needs delegation tools even when its base is read-only.
	let tools = base?.tools ?? LEAD_DEFAULT_TOOLS;
	if (Array.isArray(tools)) {
		tools = [...new Set([...tools, "agent", "agent_message"])];
	}
	return {
		name: LEAD_NAME,
		description: `Lead of team "${team.name}" — coordinates ${memberNames.join(", ")}. Delegate team-sized tasks here.`,
		systemPrompt: base ? `${base.systemPrompt.trim()}\n\n${protocol}` : protocol,
		tools,
		disallowedTools: base?.disallowedTools,
		permissionMode: base?.permissionMode === "read-only" ? "bubble" : (base?.permissionMode ?? "bubble"),
		spawns: memberNames,
		model: team.lead?.model ?? base?.model,
		thinkingLevel: team.lead?.effort ?? base?.thinkingLevel ?? "medium",
		maxTurns: Math.max(base?.maxTurns ?? 0, 40),
		background: base?.background,
		isolation: "none",
		omitProjectContext: base?.omitProjectContext,
		color: base?.color,
		source: team.source,
		filePath: team.filePath,
	};
}

/**
 * Merge the active team's roster over an agent definition registry. Members
 * (and a synthesized "lead" whose spawn allowlist is exactly the member
 * names) become real spawnable definitions; names shadow same-named base
 * definitions while the team is active. Without an active team (or one with
 * no members), the registry is returned unchanged.
 */
export function applyTeamToDefinitions(registry: AgentDefinitionRegistry): AgentDefinitionRegistry {
	const team = activeTeam;
	if (!team || Object.keys(team.members).length === 0) return registry;

	const synthesized = new Map<string, AgentDefinition>();
	const diagnostics = [...registry.diagnostics];
	for (const [name, member] of Object.entries(team.members)) {
		const base = registry.get(member.agent);
		if (!base) {
			diagnostics.push({
				type: "warning",
				message: `team "${team.name}": member "${name}" references unknown agent type "${member.agent}" — member skipped`,
				path: team.filePath,
			});
			continue;
		}
		synthesized.set(name, synthesizeMember(name, member, base, team));
	}
	if (synthesized.size > 0) {
		let leadBase: AgentDefinition | undefined;
		if (team.lead?.agent) {
			leadBase = registry.get(team.lead.agent);
			if (!leadBase) {
				diagnostics.push({
					type: "warning",
					message: `team "${team.name}": lead references unknown agent type "${team.lead.agent}" — using the built-in coordinator`,
					path: team.filePath,
				});
			}
		}
		synthesized.set(LEAD_NAME, synthesizeLead(team, synthesized, leadBase));
	}

	return {
		get: (name) => synthesized.get(name.trim().toLowerCase()) ?? registry.get(name),
		list: () => [
			...synthesized.values(),
			...registry.list().filter((definition) => !synthesized.has(definition.name)),
		],
		diagnostics,
	};
}
