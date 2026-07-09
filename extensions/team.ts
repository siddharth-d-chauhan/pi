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

import {
	type ExtensionAPI,
	getActiveTeam,
	getAgentDir,
	loadTeams,
	setActiveTeam,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("team", {
		description: "List/apply/clear team presets: /team [apply <name> | clear]",
		handler: async (args, ctx) => {
			const [sub = "list", name] = (args ?? "").trim().split(/\s+/);
			const { teams, errors } = loadTeams({ cwd: process.cwd(), agentDir: getAgentDir() });

			if (sub === "clear") {
				setActiveTeam(undefined);
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
