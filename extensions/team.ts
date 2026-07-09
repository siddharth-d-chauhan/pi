/**
 * Team Extension — apply team presets (.pi/teams/*.yaml).
 *
 *   /team              list teams (active one starred)
 *   /team apply fast   activate: model overrides + disabled agents win
 *   /team clear        back to plain settings routing
 *
 * A team preset binds agent types to models/roles and can hide agent
 * types — "different model for different type of subagents" as one file.
 *
 * Teams with a `members:` roster materialize specialists + a coordinating
 * "lead" agent while active: delegate a team-sized task to "lead" and it
 * hires members (agent tool) and converses with them (agent_message).
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	getActiveTeam,
	getAgentDir,
	loadTeams,
	setActiveTeam,
	type TeamDefinition,
} from "@earendil-works/pi-coding-agent";

/** Byte-stable model-facing briefing for the active team (cache-friendly:
 *  identical text every call until the team changes). */
function teamBriefing(team: TeamDefinition): string {
	const members = Object.keys(team.members);
	const lines = ["<active-team>", `Team "${team.name}" is active.`];
	if (members.length > 0) {
		lines.push(
			`Roster agents are spawnable NOW with the agent tool (they may not appear in the baked tool description):`,
			`- lead — coordinates ${members.join(", ")}. Delegate team-sized tasks: agent tasks=[{agent:"lead", prompt:"..."}]. Prefer the lead over doing multi-specialist work yourself.`,
			`- ${members.join(", ")} — spawn directly by name for single-specialist work.`,
		);
	}
	if (Object.keys(team.modelOverrides).length > 0) {
		lines.push(`Model routing overrides are active for: ${Object.keys(team.modelOverrides).join(", ")}.`);
	}
	if (team.disabled.length > 0) {
		lines.push(`Disabled agent types: ${team.disabled.join(", ")}.`);
	}
	lines.push("Use agent_list for full definitions.", "</active-team>");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	const stateFile = () => join(getAgentDir(), "active-team.json");

	// Restore the last applied team across restarts — otherwise every new
	// session silently forgets the roster.
	pi.on("session_start", async () => {
		if (getActiveTeam()) return;
		let saved: { name?: string } | undefined;
		try {
			saved = JSON.parse(readFileSync(stateFile(), "utf8"));
		} catch {
			return;
		}
		if (!saved?.name) return;
		const { teams } = loadTeams({ cwd: process.cwd(), agentDir: getAgentDir() });
		const team = teams.get(saved.name);
		if (team) setActiveTeam(team);
	});

	// Make the ACTIVE team visible to the model, not just the UI: append a
	// stable trailing context block so "use the team" works without the user
	// explaining the roster every session.
	pi.on("context", async (event) => {
		const team = getActiveTeam();
		if (!team) return;
		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		return {
			messages: [
				...messages,
				{ role: "user", content: [{ type: "text", text: teamBriefing(team) }], timestamp: Date.now() },
			],
		};
	});

	pi.registerCommand("team", {
		description: "List/apply/clear team presets: /team [apply <name> | clear]",
		handler: async (args, ctx) => {
			const [sub = "list", name] = (args ?? "").trim().split(/\s+/);
			const { teams, errors } = loadTeams({ cwd: process.cwd(), agentDir: getAgentDir() });

			if (sub === "clear") {
				setActiveTeam(undefined);
				try {
					rmSync(stateFile(), { force: true });
				} catch {
					// state file is best-effort
				}
				ctx.ui.notify("Team cleared — settings routing restored.", "info");
				return;
			}
			if (sub === "apply" && name) {
				const team = teams.get(name.toLowerCase());
				if (!team) {
					ctx.ui.notify(`Unknown team "${name}". Known: ${[...teams.keys()].join(", ") || "none"}`, "error");
					return;
				}
				setActiveTeam(team);
				try {
					writeFileSync(stateFile(), `${JSON.stringify({ name: team.name })}\n`);
				} catch {
					// state file is best-effort
				}
				const memberNames = Object.keys(team.members);
				const rosterNote =
					memberNames.length > 0
						? `\nRoster: lead + ${memberNames.join(", ")} — ask the agent to delegate to "lead" (or spawn members directly).`
						: "";
				ctx.ui.notify(
					`Team "${team.name}" active: ${Object.keys(team.modelOverrides).length} model override(s), ` +
						`${team.disabled.length} disabled agent type(s).${rosterNote}`,
					"info",
				);
				return;
			}

			if (sub === "apply" && !name) {
				ctx.ui.notify("Usage: /team apply <name>", "error");
				return;
			}
			const active = getActiveTeam()?.name;
			const lines = [...teams.values()].map((team) => {
				const members = Object.keys(team.members);
				const roster = members.length > 0 ? ` [lead + ${members.join(", ")}]` : "";
				return `${team.name === active ? "* " : "  "}${team.name} — ${team.description ?? team.filePath}${roster}`;
			});
			const body = [...lines, ...errors.map((error) => `! ${error}`)].join("\n");
			ctx.ui.notify(body || "No teams defined (.pi/teams/*.yaml)", "info");
		},
	});
}
