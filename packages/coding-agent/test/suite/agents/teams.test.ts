import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition, AgentDefinitionRegistry } from "../../../src/core/agents/definitions.ts";
import {
	applyTeamToDefinitions,
	applyTeamToRouting,
	type EffectiveAgentRouting,
	getActiveTeam,
	loadTeams,
	onTeamChange,
	parseTeam,
	resetTeamsForTests,
	setActiveTeam,
	type TeamDefinition,
	TeamValidationError,
} from "../../../src/core/agents/teams.ts";

const VALID_TEAM = `
name: Fast
description: Cheap models everywhere
modelOverrides:
  worker: pi/smol
  reviewer: pi/smol
roles:
  smol: ["minimax/MiniMax-M3"]
disabled: [plan]
coordinatorNote: |
  Prefer many small parallel workers over one large one.
`;

describe("parseTeam", () => {
	it("parses a valid team and lowercases the name", () => {
		const team = parseTeam(VALID_TEAM, "fast.yaml", "project");
		expect(team.name).toBe("fast");
		expect(team.description).toBe("Cheap models everywhere");
		expect(team.modelOverrides).toEqual({ worker: "pi/smol", reviewer: "pi/smol" });
		expect(team.roles).toEqual({ smol: ["minimax/MiniMax-M3"] });
		expect(team.disabled).toEqual(["plan"]);
		expect(team.coordinatorNote).toContain("parallel workers");
		expect(team.source).toBe("project");
		expect(team.filePath).toBe("fast.yaml");
	});

	it("defaults omitted sections to empty", () => {
		const team = parseTeam("name: bare", "bare.yaml", "user");
		expect(team.modelOverrides).toEqual({});
		expect(team.roles).toEqual({});
		expect(team.disabled).toEqual([]);
		expect(team.description).toBeUndefined();
		expect(team.coordinatorNote).toBeUndefined();
	});

	it("rejects a missing name with the file path in the message", () => {
		expect(() => parseTeam("description: nameless", "no-name.yaml", "project")).toThrow(TeamValidationError);
		expect(() => parseTeam("description: nameless", "no-name.yaml", "project")).toThrow(
			/no-name\.yaml: missing required "name"/,
		);
	});

	it("rejects non-mapping files and invalid YAML", () => {
		expect(() => parseTeam("- just\n- a list", "list.yaml", "project")).toThrow(/must be a YAML mapping/);
		expect(() => parseTeam("name: [unclosed", "broken.yaml", "project")).toThrow(/invalid YAML/);
	});

	it("rejects bad modelOverrides shapes", () => {
		expect(() => parseTeam("name: t\nmodelOverrides: [a, b]", "t.yaml", "project")).toThrow(
			/t\.yaml: "modelOverrides" must be a mapping/,
		);
		expect(() => parseTeam("name: t\nmodelOverrides:\n  worker: 3", "t.yaml", "project")).toThrow(
			/"modelOverrides\.worker" must be a non-empty string/,
		);
	});

	it("rejects bad roles and disabled shapes", () => {
		expect(() => parseTeam("name: t\nroles:\n  smol: not-a-list", "t.yaml", "project")).toThrow(
			/"roles\.smol" must be a list/,
		);
		expect(() => parseTeam("name: t\ndisabled: nope", "t.yaml", "project")).toThrow(/"disabled" must be a list/);
	});

	it("ignores unknown keys", () => {
		const team = parseTeam("name: t\nbudget: 12\nextra: {a: 1}", "t.yaml", "project");
		expect(team.name).toBe("t");
	});
});

describe("loadTeams", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	it("loads project and user teams; project wins on name collision", () => {
		const cwd = makeTempDir("pi-teams-cwd-");
		const agentDir = makeTempDir("pi-teams-agent-");
		mkdirSync(join(cwd, ".pi", "teams"), { recursive: true });
		mkdirSync(join(agentDir, "teams"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "teams", "fast.yaml"), "name: fast\ndisabled: [plan]\n");
		writeFileSync(join(agentDir, "teams", "fast.yaml"), "name: fast\ndisabled: [reviewer]\n");
		writeFileSync(join(agentDir, "teams", "thorough.yml"), "name: thorough\n");

		const { teams, errors } = loadTeams({ cwd, agentDir });
		expect(errors).toEqual([]);
		expect([...teams.keys()].sort()).toEqual(["fast", "thorough"]);
		expect(teams.get("fast")?.source).toBe("project");
		expect(teams.get("fast")?.disabled).toEqual(["plan"]);
		expect(teams.get("thorough")?.source).toBe("user");
	});

	it("collects per-file errors without breaking loading", () => {
		const cwd = makeTempDir("pi-teams-cwd-");
		const agentDir = makeTempDir("pi-teams-agent-");
		mkdirSync(join(cwd, ".pi", "teams"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "teams", "bad.yaml"), "description: nameless\n");
		writeFileSync(join(cwd, ".pi", "teams", "good.yaml"), "name: good\n");

		const { teams, errors } = loadTeams({ cwd, agentDir });
		expect(teams.has("good")).toBe(true);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("bad.yaml");
		expect(errors[0]).toContain('missing required "name"');
	});

	it("returns empty results when neither directory exists", () => {
		const cwd = makeTempDir("pi-teams-cwd-");
		const agentDir = makeTempDir("pi-teams-agent-");
		const { teams, errors } = loadTeams({ cwd, agentDir });
		expect(teams.size).toBe(0);
		expect(errors).toEqual([]);
	});
});

describe("active team state", () => {
	afterEach(() => {
		resetTeamsForTests();
	});

	it("setActiveTeam/getActiveTeam round-trips and notifies listeners", () => {
		const team = parseTeam(VALID_TEAM, "fast.yaml", "project");
		const seen: Array<TeamDefinition | undefined> = [];
		const unsubscribe = onTeamChange((next) => seen.push(next));

		setActiveTeam(team);
		expect(getActiveTeam()).toBe(team);
		setActiveTeam(undefined);
		expect(getActiveTeam()).toBeUndefined();
		expect(seen).toEqual([team, undefined]);

		unsubscribe();
		setActiveTeam(team);
		expect(seen).toEqual([team, undefined]); // no notification after unsubscribe
	});

	it("resetTeamsForTests clears the active team and listeners", () => {
		const team = parseTeam(VALID_TEAM, "fast.yaml", "project");
		const seen: Array<TeamDefinition | undefined> = [];
		onTeamChange((next) => seen.push(next));
		setActiveTeam(team);

		resetTeamsForTests();
		expect(getActiveTeam()).toBeUndefined();
		setActiveTeam(team);
		expect(seen).toEqual([team]); // listener was cleared by the reset
	});
});

describe("applyTeamToRouting", () => {
	afterEach(() => {
		resetTeamsForTests();
	});

	const base: EffectiveAgentRouting = {
		modelOverrides: { worker: "openai/gpt-5", scout: "pi/smol" },
		roles: { smol: ["openai/gpt-5-mini"], slow: ["anthropic/claude-opus-4"] },
		disabled: ["scout"],
	};

	it("returns base unchanged when no team is active", () => {
		expect(applyTeamToRouting(base)).toBe(base);
	});

	it("team values win per-key, roles merge, disabled unions", () => {
		setActiveTeam(parseTeam(VALID_TEAM, "fast.yaml", "project"));
		const merged = applyTeamToRouting(base);

		// Override wins for shared keys; base-only keys survive.
		expect(merged.modelOverrides).toEqual({ worker: "pi/smol", reviewer: "pi/smol", scout: "pi/smol" });
		// Roles merged per-key with the team winning; base-only roles survive.
		expect(merged.roles).toEqual({ smol: ["minimax/MiniMax-M3"], slow: ["anthropic/claude-opus-4"] });
		// Disabled is the deduplicated union.
		expect(merged.disabled.sort()).toEqual(["plan", "scout"]);
		// Base is not mutated.
		expect(base.roles.smol).toEqual(["openai/gpt-5-mini"]);
		expect(base.disabled).toEqual(["scout"]);
	});

	it("deduplicates disabled entries present in both", () => {
		setActiveTeam(parseTeam("name: t\ndisabled: [scout, plan]", "t.yaml", "user"));
		const merged = applyTeamToRouting(base);
		expect(merged.disabled.sort()).toEqual(["plan", "scout"]);
	});
});

const ROSTER_TEAM = `
name: Squad
lead:
  agent: plan
  model: pi/main
  effort: high
  briefing: Ship small; verify before reporting done.
members:
  Frontend:
    agent: worker
    model: pi/smol
    effort: low
    persona: |
      UI specialist: components, styling.
      Keep bundles small.
  qa:
    agent: reviewer
    persona: Verify the team's work.
`;

describe("parseTeam roster", () => {
	it("parses members and lead, lowercasing names and base types", () => {
		const team = parseTeam(ROSTER_TEAM, "squad.yaml", "project");
		expect(Object.keys(team.members).sort()).toEqual(["frontend", "qa"]);
		expect(team.members.frontend).toMatchObject({ agent: "worker", model: "pi/smol", effort: "low" });
		expect(team.members.frontend.persona).toContain("UI specialist");
		expect(team.members.qa).toMatchObject({ agent: "reviewer", persona: "Verify the team's work." });
		expect(team.lead).toEqual({
			agent: "plan",
			model: "pi/main",
			effort: "high",
			briefing: "Ship small; verify before reporting done.",
		});
	});

	it("rejects invalid effort levels", () => {
		expect(() => parseTeam("name: t\nmembers:\n  fe: {agent: worker, effort: turbo}", "t.yaml", "project")).toThrow(
			/"members\.fe\.effort" must be one of/,
		);
		expect(() => parseTeam("name: t\nlead: {effort: 11}", "t.yaml", "project")).toThrow(
			/"lead\.effort" must be one of/,
		);
	});

	it("defaults to no roster when members/lead are omitted", () => {
		const team = parseTeam("name: bare", "bare.yaml", "user");
		expect(team.members).toEqual({});
		expect(team.lead).toBeUndefined();
	});

	it("rejects bad roster shapes with the offending path in the message", () => {
		expect(() => parseTeam("name: t\nmembers: [a]", "t.yaml", "project")).toThrow(/"members" must be a mapping/);
		expect(() => parseTeam("name: t\nmembers:\n  fe: worker", "t.yaml", "project")).toThrow(
			/"members\.fe" must be a mapping/,
		);
		expect(() => parseTeam("name: t\nmembers:\n  fe: {persona: x}", "t.yaml", "project")).toThrow(
			/"members\.fe\.agent" is required/,
		);
		expect(() => parseTeam("name: t\nmembers:\n  fe: {agent: worker, model: 3}", "t.yaml", "project")).toThrow(
			/"members\.fe\.model" must be a non-empty string/,
		);
		expect(() => parseTeam("name: t\nlead: nope", "t.yaml", "project")).toThrow(/"lead" must be a mapping/);
		expect(() => parseTeam("name: t\nmembers:\n  lead: {agent: worker}", "t.yaml", "project")).toThrow(
			/member name "lead" is reserved/,
		);
	});
});

describe("applyTeamToDefinitions", () => {
	afterEach(() => {
		resetTeamsForTests();
	});

	function makeDefinition(name: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
		return {
			name,
			description: `${name} agent`,
			systemPrompt: `You are ${name}.`,
			tools: ["read", "grep"],
			spawns: "none",
			model: "pi/base",
			source: "bundled",
			...overrides,
		} as AgentDefinition;
	}

	function makeRegistry(definitions: AgentDefinition[]): AgentDefinitionRegistry {
		const map = new Map(definitions.map((definition) => [definition.name, definition]));
		return {
			get: (name) => map.get(name.toLowerCase()),
			list: () => [...map.values()],
			diagnostics: [],
		};
	}

	const baseRegistry = () =>
		makeRegistry([makeDefinition("worker"), makeDefinition("reviewer"), makeDefinition("plan")]);

	it("returns the registry unchanged without an active team or roster", () => {
		const registry = baseRegistry();
		expect(applyTeamToDefinitions(registry)).toBe(registry);
		setActiveTeam(parseTeam(VALID_TEAM, "fast.yaml", "project"));
		expect(applyTeamToDefinitions(registry)).toBe(registry);
	});

	it("materializes members with persona, model override, and no sub-spawns", () => {
		setActiveTeam(parseTeam(ROSTER_TEAM, "squad.yaml", "project"));
		const merged = applyTeamToDefinitions(baseRegistry());

		const frontend = merged.get("frontend");
		expect(frontend).toBeDefined();
		expect(frontend?.model).toBe("pi/smol");
		expect(frontend?.thinkingLevel).toBe("low");
		expect(frontend?.spawns).toBe("none");
		expect(frontend?.systemPrompt).toContain("You are worker.");
		expect(frontend?.systemPrompt).toContain("UI specialist");
		expect(frontend?.description).toBe("UI specialist: components, styling.");
		expect(frontend?.source).toBe("project");

		const qa = merged.get("qa");
		expect(qa?.model).toBe("pi/base"); // no override -> base model
		expect(qa?.systemPrompt).toContain("You are reviewer.");
	});

	it("synthesizes a lead whose spawns are exactly the member names", () => {
		setActiveTeam(parseTeam(ROSTER_TEAM, "squad.yaml", "project"));
		const merged = applyTeamToDefinitions(baseRegistry());

		const lead = merged.get("lead");
		expect(lead).toBeDefined();
		expect([...(lead?.spawns as string[])].sort()).toEqual(["frontend", "qa"]);
		expect(lead?.model).toBe("pi/main");
		expect(lead?.thinkingLevel).toBe("high");
		// Delegation tools are forced in even when the base is read-only.
		expect(lead?.tools).toContain("agent");
		expect(lead?.tools).toContain("agent_message");
		// Roster + protocol + briefing all present.
		expect(lead?.systemPrompt).toContain("You are plan.");
		expect(lead?.systemPrompt).toContain("- frontend (base: worker, model: pi/smol, effort: low)");
		expect(lead?.systemPrompt).toContain("Ship small; verify before reporting done.");
		// Members shadow, everything else survives, list() has no duplicates.
		const names = merged.list().map((definition) => definition.name);
		expect(names.sort()).toEqual(["frontend", "lead", "plan", "qa", "reviewer", "worker"]);
	});

	it("skips members with unknown base types and surfaces a diagnostic", () => {
		setActiveTeam(
			parseTeam("name: t\nmembers:\n  ghost: {agent: nosuch}\n  qa: {agent: reviewer}", "t.yaml", "user"),
		);
		const merged = applyTeamToDefinitions(baseRegistry());
		expect(merged.get("ghost")).toBeUndefined();
		expect(merged.get("qa")).toBeDefined();
		expect(merged.get("lead")?.spawns as string[]).toEqual(["qa"]);
		expect(merged.diagnostics.some((diag) => diag.message.includes('member "ghost"'))).toBe(true);
	});

	it("falls back to the built-in coordinator when the lead base is unknown", () => {
		setActiveTeam(parseTeam("name: t\nlead: {agent: nosuch}\nmembers:\n  qa: {agent: reviewer}", "t.yaml", "user"));
		const merged = applyTeamToDefinitions(baseRegistry());
		const lead = merged.get("lead");
		expect(lead).toBeDefined();
		expect(lead?.systemPrompt).toContain("You are the LEAD");
		expect(merged.diagnostics.some((diag) => diag.message.includes("built-in coordinator"))).toBe(true);
	});
});
