/**
 * Dashboard Extension — replaces the plain startup header with an
 * information-dense card: repo state, recent commits, active team,
 * chains, model, and memory presence at a glance.
 *
 *   ╭─ ~/pi ⎇ main ±3 ──────────────────────────────────────╮
 *   │ ● 048cdcf feat(extensions): make active team visible…  │
 *   │ ● 7ed4fb5 feat(coding-agent): chain digest + team A2A  │
 *   │ ⛭ team squad — lead + scout, builder, qa               │
 *   │ ⛓ chains feature bugfix review refactor tests audit …  │
 *   │ ◆ minimax/MiniMax-M3 · memory: team ✓ · agents 2       │
 *   ╰─ ctrl+o help · / commands · /presets manage ───────────╯
 *
 *   /dashboard   toggle back to the built-in header
 */

import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getActiveTeam,
	getAgentDir,
	loadChains,
	onTeamChange,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { cardLines } from "./lib/card.ts";
import { icon, onIconModeChange } from "./lib/icons.ts";

const execFileAsync = promisify(execFile);

type ThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

interface RepoInfo {
	branch?: string;
	dirty: number;
	ahead: number;
	behind: number;
	commits: Array<{ hash: string; subject: string }>;
}

interface DashboardData {
	cwd: string;
	repo?: RepoInfo;
	chains: string[];
	modelId?: string;
	teamMemory: boolean;
	agentMemoryTypes: number;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 4000 });
		return stdout.trim();
	} catch {
		return undefined;
	}
}

async function collectRepoInfo(cwd: string): Promise<RepoInfo | undefined> {
	const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch === undefined) return undefined;
	const [status, counts, log] = await Promise.all([
		git(cwd, ["status", "--porcelain"]),
		git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
		git(cwd, ["log", "--oneline", "-3", "--no-decorate"]),
	]);
	const [behind = 0, ahead = 0] = (counts ?? "").split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
	return {
		branch,
		dirty: status ? status.split("\n").filter(Boolean).length : 0,
		ahead,
		behind,
		commits: (log ?? "")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const space = line.indexOf(" ");
				return { hash: line.slice(0, space), subject: line.slice(space + 1) };
			}),
	};
}

function collectMemoryInfo(cwd: string): { teamMemory: boolean; agentMemoryTypes: number } {
	const dir = join(cwd, ".pi", "agent-memory");
	try {
		const entries = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
		const team = entries.some((entry) => entry.name.startsWith("team-"));
		return { teamMemory: team, agentMemoryTypes: entries.filter((entry) => !entry.name.startsWith("team-")).length };
	} catch {
		return { teamMemory: false, agentMemoryTypes: 0 };
	}
}

function shortPath(cwd: string): string {
	const home = homedir();
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

class DashboardHeader implements Component {
	private readonly theme: ThemeLike;
	private readonly data: DashboardData;
	private readonly unsubscribe: () => void;

	constructor(tui: TUI, theme: ThemeLike, data: DashboardData) {
		this.theme = theme;
		this.data = data;
		const unsubTeam = onTeamChange(() => tui.requestRender());
		const unsubIcons = onIconModeChange(() => tui.requestRender());
		this.unsubscribe = () => {
			unsubTeam();
			unsubIcons();
		};
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	render(width: number): string[] {
		try {
			return this.renderCard(width);
		} catch {
			return [];
		}
	}

	private renderCard(width: number): string[] {
		const theme = this.theme;
		const { repo, chains, modelId, teamMemory, agentMemoryTypes } = this.data;

		let title = theme.fg("accent", theme.bold(basename(this.data.cwd) || shortPath(this.data.cwd)));
		if (repo?.branch) {
			title += ` ${theme.fg("muted", icon("branch"))} ${theme.fg("text", repo.branch)}`;
			if (repo.dirty > 0) title += theme.fg("warning", ` ±${repo.dirty}`);
			if (repo.ahead > 0) title += theme.fg("success", ` ↑${repo.ahead}`);
			if (repo.behind > 0) title += theme.fg("error", ` ↓${repo.behind}`);
		}

		const body: string[] = [];
		for (const commit of repo?.commits ?? []) {
			body.push(
				`${theme.fg("dim", icon("commit"))} ${theme.fg("muted", commit.hash)} ${theme.fg("text", commit.subject)}`,
			);
		}

		const team = getActiveTeam();
		if (team) {
			const members = Object.keys(team.members);
			const roster = members.length > 0 ? ` — lead + ${members.join(", ")}` : " (routing only)";
			body.push(
				`${theme.fg("accent", icon("team"))} ${theme.fg("text", `team ${theme.bold(team.name)}`)}${theme.fg("dim", roster)}`,
			);
		} else {
			body.push(`${theme.fg("dim", `${icon("team")} no team active · /team apply <name>`)}`);
		}

		if (chains.length > 0) {
			body.push(
				`${theme.fg("accent", icon("chain"))} ${theme.fg("muted", "chains")} ${theme.fg("dim", chains.join(" "))}`,
			);
		}

		const memoryBits = [
			teamMemory ? "team ✓" : undefined,
			agentMemoryTypes > 0 ? `${agentMemoryTypes} agent type${agentMemoryTypes === 1 ? "" : "s"}` : undefined,
		].filter(Boolean);
		const memory = memoryBits.length > 0 ? memoryBits.join(" · ") : "none yet";
		body.push(
			`${theme.fg("accent", icon("model"))} ${theme.fg("text", modelId ?? "no model")} ${theme.fg("dim", `· memory: ${memory}`)}`,
		);

		const lines = cardLines({
			width: Math.min(width, 100),
			title,
			body,
			edge: (text) => theme.fg("dim", text),
		});
		// Hint line woven into the bottom border, like the built-in header's hints.
		const hint = ` ${theme.fg("dim", "ctrl+o help · / commands · /presets manage · /agents")}`;
		return ["", ...lines, hint, ""];
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let data: DashboardData | undefined;

	const apply = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (!enabled || !data) {
			ctx.ui.setHeader(undefined);
			return;
		}
		const snapshot = data;
		ctx.ui.setHeader((tui, theme) => new DashboardHeader(tui, theme as unknown as ThemeLike, snapshot));
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const cwd = ctx.cwd;
		const { chains } = loadChains({ cwd, agentDir: getAgentDir() });
		const memory = collectMemoryInfo(cwd);
		data = {
			cwd,
			chains: [...chains.keys()],
			modelId: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			...memory,
		};
		apply(ctx);
		// Git is async — render the card immediately, enrich when it lands.
		collectRepoInfo(cwd).then((repo) => {
			if (!repo || !data) return;
			data = { ...data, repo };
			apply(ctx);
		});
	});

	pi.on("model_select", async (event, ctx) => {
		if (!data) return;
		const model = (event as { model?: { provider?: string; id?: string } }).model;
		if (model?.id) data = { ...data, modelId: `${model.provider}/${model.id}` };
		apply(ctx);
	});

	pi.registerCommand("dashboard", {
		description: "Toggle the startup dashboard header",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			apply(ctx);
			ctx.ui.notify(enabled ? "Dashboard header on" : "Built-in header restored", "info");
		},
	});
}
