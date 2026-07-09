import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
