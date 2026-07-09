/**
 * Preset Manager Extension — full CRUD for chains, teams, and agent
 * definitions from inside the TUI. No file juggling:
 *
 *   /presets                menu: chains / teams / agents
 *   /presets chains|teams|agents   jump straight to that list
 *
 * Per item: edit (multi-line editor, validated before save), duplicate,
 * delete (confirmed), and apply (teams). New presets start from curated
 * templates with the name filled in. Validation runs the REAL parsers
 * (parseChain / parseTeam / parseAgentDefinitionContent) — bad YAML or
 * frontmatter never lands on disk; you re-enter the editor with your text
 * preserved.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getActiveTeam,
	getAgentDir,
	parseAgentDefinitionContent,
	parseChain,
	parseTeam,
	setActiveTeam,
} from "@earendil-works/pi-coding-agent";

type PresetKind = "chain" | "team" | "agent";

interface PresetFile {
	name: string;
	scope: "project" | "user";
	filePath: string;
}

interface KindSpec {
	kind: PresetKind;
	plural: string;
	fileExt: string;
	dirs: (cwd: string, agentDir: string) => Array<{ scope: "project" | "user"; dir: string }>;
	/** Returns an error message, or undefined when the content is valid. */
	validate: (content: string, filePath: string) => string | undefined;
	templates: Record<string, (name: string) => string>;
}

const CHAIN_TEMPLATE = (name: string): string => `name: ${name}
description: What this chain does (one line)
budget_usd: 1.0
inputs:
  task: { description: "the task" }
  check: { default: "true" }   # pass your repo's real gate command
stages:
  - id: scout
    agent: explore
    effort: low
    prompt: |
      Map what is relevant to: {{inputs.task}}
      Return file:line pointers and a short plan. ≤12 lines, no code dumps.
  - id: work
    agent: worker
    needs: [scout]
    verify: "{{inputs.check}}"
    max_iters: 2
    prompt: |
      Do: {{inputs.task}}

      Scout notes:
      {{scout.result}}
`;

const TEAM_ROSTER_TEMPLATE = (name: string): string => `name: ${name}
description: Roster team — specialists working together under a lead

lead:
  model: pi/main
  effort: medium
  briefing: |
    Delegate to specialists; verify before reporting done.

members:
  scout:
    agent: explore
    model: pi/smol
    effort: low
    persona: "Find the relevant files and conventions; return pointers, not dumps."
  builder:
    agent: worker
    persona: "Implement the change; match surrounding style; run the narrowest test."
  qa:
    agent: reviewer
    persona: "Verify the team's work against acceptance criteria. Verdict first."
`;

const TEAM_ROUTING_TEMPLATE = (name: string): string => `name: ${name}
description: Model routing — which model each agent type uses

modelOverrides:
  explore: pi/smol
  worker: pi/main
  reviewer: pi/main
# roles:
#   smol: ["provider/model-id"]
# disabled: [plan]
`;

const AGENT_TEMPLATE = (name: string): string => `---
name: ${name}
description: When to delegate to this agent (used for routing decisions).
tools: read, grep, find, ls
spawns: none
model: pi/smol
thinkingLevel: low
maxTurns: 20
---
You are ${name}, a focused specialist.

Describe the specialty and the output contract here. Report concise,
self-contained results (≤15 lines) with concrete file:line evidence.
`;

const KINDS: Record<string, KindSpec> = {
	chain: {
		kind: "chain",
		plural: "chains",
		fileExt: ".yaml",
		dirs: (cwd, agentDir) => [
			{ scope: "project", dir: join(cwd, ".pi", "chains") },
			{ scope: "user", dir: join(agentDir, "chains") },
		],
		validate: (content, filePath) => {
			try {
				parseChain(content, filePath, "project");
				return undefined;
			} catch (err) {
				return (err as Error).message;
			}
		},
		templates: { "chain (scout → gated work)": CHAIN_TEMPLATE },
	},
	team: {
		kind: "team",
		plural: "teams",
		fileExt: ".yaml",
		dirs: (cwd, agentDir) => [
			{ scope: "project", dir: join(cwd, ".pi", "teams") },
			{ scope: "user", dir: join(agentDir, "teams") },
		],
		validate: (content, filePath) => {
			try {
				parseTeam(content, filePath, "project");
				return undefined;
			} catch (err) {
				return (err as Error).message;
			}
		},
		templates: {
			"roster team (lead + members)": TEAM_ROSTER_TEMPLATE,
			"routing team (models only)": TEAM_ROUTING_TEMPLATE,
		},
	},
	agent: {
		kind: "agent",
		plural: "agents",
		fileExt: ".md",
		dirs: (cwd, agentDir) => [
			{ scope: "project", dir: join(cwd, ".pi", "agents") },
			{ scope: "user", dir: join(agentDir, "agents") },
		],
		validate: (content, filePath) => {
			const result = parseAgentDefinitionContent(content, "user", filePath);
			const errors = result.diagnostics.filter((diag) => diag.type === "error");
			if (errors.length > 0) return errors.map((diag) => diag.message).join("; ");
			if (!result.definition) return "content did not produce a valid agent definition";
			return undefined;
		},
		templates: { "specialist agent (read-only)": AGENT_TEMPLATE },
	},
};

function listPresets(spec: KindSpec, cwd: string, agentDir: string): PresetFile[] {
	const out: PresetFile[] = [];
	for (const { scope, dir } of spec.dirs(cwd, agentDir)) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of names.sort()) {
			if (spec.fileExt === ".yaml" ? !file.endsWith(".yaml") && !file.endsWith(".yml") : !file.endsWith(".md")) {
				continue;
			}
			out.push({ name: basename(file).replace(/\.(yaml|yml|md)$/, ""), scope, filePath: join(dir, file) });
		}
	}
	return out;
}

/** Refresh the module-singleton active team after edits to its file. */
function reapplyActiveTeamIfNamed(content: string, filePath: string): void {
	const active = getActiveTeam();
	if (!active) return;
	try {
		const parsed = parseTeam(content, filePath, active.source);
		if (parsed.name === active.name) setActiveTeam(parsed);
	} catch {
		// Content was validated before saving; if this still throws, keep the old team.
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("presets", {
		description: "Create, edit, apply, and delete chain/team/agent presets: /presets [chains|teams|agents]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/presets needs the interactive UI.", "error");
				return;
			}
			const cwd = process.cwd();
			const agentDir = getAgentDir();

			// ---- pick a kind (or take it from args) --------------------------
			const requested = (args ?? "").trim().toLowerCase().replace(/s$/, "");
			let spec = KINDS[requested];
			if (!spec) {
				const choice = await ctx.ui.select("Manage which presets?", [
					"chains — multi-agent pipelines (/chain)",
					"teams — rosters and model routing (/team)",
					"agents — subagent definitions",
				]);
				if (!choice) return;
				spec = KINDS[choice.split(" ")[0].replace(/s$/, "")];
				if (!spec) return;
			}

			// ---- browse loop -------------------------------------------------
			for (;;) {
				const presets = listPresets(spec, cwd, agentDir);
				const activeTeam = spec.kind === "team" ? getActiveTeam()?.name : undefined;
				const rows = presets.map(
					(preset) =>
						`${preset.name === activeTeam ? "* " : ""}${preset.name} (${preset.scope === "project" ? ".pi" : "~"})`,
				);
				const picked = await ctx.ui.select(`${spec.plural} — pick one`, [...rows, "+ new", "close"]);
				if (!picked || picked === "close") return;

				if (picked === "+ new") {
					await createPreset(spec, cwd, agentDir, ctx);
					continue;
				}
				const preset = presets[rows.indexOf(picked)];
				if (!preset) continue;
				await managePreset(spec, preset, ctx);
			}
		},
	});

	/** Editor → validate → write loop shared by create/edit/duplicate. */
	async function editUntilValid(
		spec: KindSpec,
		title: string,
		initial: string,
		targetPath: string,
		ctx: ExtensionCommandContext,
	): Promise<boolean> {
		let content = initial;
		for (;;) {
			const edited = await ctx.ui.editor(title, content);
			if (edited === undefined) return false; // user cancelled
			content = edited;
			const error = spec.validate(content, targetPath);
			if (!error) {
				mkdirSync(dirname(targetPath), { recursive: true });
				writeFileSync(targetPath, content.endsWith("\n") ? content : `${content}\n`);
				if (spec.kind === "team") reapplyActiveTeamIfNamed(content, targetPath);
				ctx.ui.notify(`Saved ${targetPath}`, "info");
				return true;
			}
			const retry = await ctx.ui.confirm("Validation failed", `${error}\n\nRe-edit? (No discards your changes)`);
			if (!retry) return false;
		}
	}

	async function createPreset(
		spec: KindSpec,
		cwd: string,
		agentDir: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const name = (await ctx.ui.input(`New ${spec.kind} name`, "kebab-case-name"))?.trim().toLowerCase();
		if (!name) return;
		if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
			ctx.ui.notify("Name must be kebab-case (letters, digits, dashes).", "error");
			return;
		}
		const templateNames = Object.keys(spec.templates);
		const templateName =
			templateNames.length === 1 ? templateNames[0] : await ctx.ui.select("Start from template", templateNames);
		if (!templateName) return;
		const scope = await ctx.ui.select("Save where?", [
			"project (.pi/ — this repo)",
			"user (~/.pi/agent — everywhere)",
		]);
		if (!scope) return;
		const dirs = spec.dirs(cwd, agentDir);
		const target = scope.startsWith("project") ? dirs[0] : dirs[1];
		const targetPath = join(target.dir, `${name}${spec.fileExt}`);
		if (existsSync(targetPath)) {
			ctx.ui.notify(`${targetPath} already exists — pick it from the list to edit.`, "error");
			return;
		}
		await editUntilValid(spec, `new ${spec.kind}: ${name}`, spec.templates[templateName](name), targetPath, ctx);
	}

	async function managePreset(spec: KindSpec, preset: PresetFile, ctx: ExtensionCommandContext): Promise<void> {
		const actions = ["edit", "duplicate", "delete"];
		if (spec.kind === "team") actions.unshift("apply");
		const action = await ctx.ui.select(`${spec.kind} "${preset.name}" (${preset.filePath})`, [...actions, "back"]);
		if (!action || action === "back") return;

		if (action === "apply") {
			try {
				const team = parseTeam(readFileSync(preset.filePath, "utf8"), preset.filePath, preset.scope);
				setActiveTeam(team);
				const members = Object.keys(team.members);
				ctx.ui.notify(
					`Team "${team.name}" active.${members.length > 0 ? ` Roster: lead + ${members.join(", ")}.` : ""}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Cannot apply: ${(err as Error).message}`, "error");
			}
			return;
		}

		if (action === "edit") {
			const current = readFileSync(preset.filePath, "utf8");
			await editUntilValid(spec, `edit ${spec.kind}: ${preset.name}`, current, preset.filePath, ctx);
			return;
		}

		if (action === "duplicate") {
			const copyName = (await ctx.ui.input(`Duplicate "${preset.name}" as`, `${preset.name}-copy`))
				?.trim()
				.toLowerCase();
			if (!copyName) return;
			const copyPath = join(dirname(preset.filePath), `${copyName}${spec.fileExt}`);
			if (existsSync(copyPath)) {
				ctx.ui.notify(`${copyPath} already exists.`, "error");
				return;
			}
			// Rewrite the name field so the copy is valid immediately.
			const content = readFileSync(preset.filePath, "utf8").replace(/^name:\s*.*$/m, `name: ${copyName}`);
			await editUntilValid(spec, `new ${spec.kind}: ${copyName}`, content, copyPath, ctx);
			return;
		}

		if (action === "delete") {
			const sure = await ctx.ui.confirm("Delete preset", `Delete ${preset.filePath}?`);
			if (!sure) return;
			rmSync(preset.filePath);
			if (spec.kind === "team" && getActiveTeam()?.name === preset.name) {
				setActiveTeam(undefined);
				ctx.ui.notify(`Deleted ${preset.name} (was active — team cleared).`, "info");
			} else {
				ctx.ui.notify(`Deleted ${preset.filePath}`, "info");
			}
		}
	}
}
