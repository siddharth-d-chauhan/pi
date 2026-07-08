/**
 * chain — run a declarative multi-agent chain (see core/agents/chains.ts).
 *
 * The card renders the stage flow live:
 *
 *   ╭─ chain feature-flow ────────────────────────────╮
 *   │ [plan ✓] → [build ▶ 12s] → [review ○]           │
 *   │ ✓ plan · 6.2k tok · 8s                          │
 *   │ ▶ build · verifying (attempt 2)                 │
 *   ╰─────────────────────────────────────────────────╯
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { AgentSession } from "../agent-session.ts";
import { type ChainStageResult, loadChains, runChain } from "../agents/chains.ts";
import { loadAgentDefinitions } from "../agents/index.ts";
import type { SpawnDeps } from "../agents/spawn.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const chainToolSchema = Type.Object({
	chain: Type.String({ description: "Name of the chain to run (from .pi/chains/ or ~/.pi/agent/chains/)." }),
	input: Type.Optional(Type.String({ description: "Input text interpolated as {{input}} in stage prompts." })),
});

export type ChainToolInput = Static<typeof chainToolSchema>;

export interface ChainToolDetails {
	chain: string;
	status?: "completed" | "failed";
	stages: ChainStageResult[];
	live?: boolean;
}

export interface CreateChainToolOptions {
	cwd: string;
	agentDir?: string;
	packageAgentDirs?: string[];
	parentSession: AgentSession;
	/** Spawn dependency bag shared with the agent tool. */
	spawnDeps: SpawnDeps;
}

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

const STAGE_GLYPH: Record<ChainStageResult["status"], string> = {
	pending: "○",
	running: "▶",
	verifying: "◈",
	completed: "✓",
	failed: "✗",
	skipped: "⊘",
};

function stageColor(status: ChainStageResult["status"]): ThemeColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "running":
		case "verifying":
			return "accent";
		default:
			return "dim";
	}
}

function formatFlow(stages: ChainStageResult[], theme: Theme): string {
	return stages
		.map((stage) => {
			const glyph = theme.fg(stageColor(stage.status), STAGE_GLYPH[stage.status]);
			const name = theme.fg(stage.status === "pending" || stage.status === "skipped" ? "dim" : "text", stage.id);
			return `[${name} ${glyph}]`;
		})
		.join(theme.fg("dim", " → "));
}

function formatStageRow(stage: ChainStageResult, theme: Theme): string {
	const glyph = theme.fg(stageColor(stage.status), STAGE_GLYPH[stage.status]);
	const name = theme.fg("accent", theme.bold(stage.id));
	const agent = theme.fg("muted", `(${stage.agent})`);
	const parts: string[] = [];
	if (stage.status === "verifying") parts.push(`verifying (attempt ${stage.verifyAttempts})`);
	if (stage.durationMs > 0) parts.push(`${(stage.durationMs / 1000).toFixed(1)}s`);
	if (stage.error) parts.push(stage.error.split("\n")[0]);
	const meta = parts.length > 0 ? theme.fg(stage.error ? "error" : "dim", ` · ${parts.join(" · ")}`) : "";
	return `${glyph} ${name} ${agent}${meta}`;
}

/** Exported for tests and headless render probes. */
export class ChainToolCard implements Component {
	private theme: Theme;
	private args: ChainToolInput | undefined;
	private details: ChainToolDetails | undefined;
	private options: ToolRenderResultOptions = { expanded: false, isPartial: true };
	private isError = false;

	constructor(theme: Theme) {
		this.theme = theme;
	}

	setArgs(args: ChainToolInput): void {
		this.args = args;
	}

	setResult(details: ChainToolDetails | undefined, options: ToolRenderResultOptions, isError: boolean): void {
		this.details = details;
		this.options = options;
		this.isError = isError;
	}

	invalidate(): void {}

	render(width: number): string[] {
		try {
			return this.renderCard(width);
		} catch {
			return [truncateToWidth(this.theme.fg("toolTitle", this.theme.bold("chain")), Math.max(1, width), "…")];
		}
	}

	private renderCard(width: number): string[] {
		const theme = this.theme;
		const name = typeof this.args?.chain === "string" ? this.args.chain : "";
		const title = `${theme.fg("toolTitle", theme.bold("chain"))} ${theme.fg("accent", name)}`;
		const body: string[] = [];
		const stages = this.details?.stages ?? [];
		if (stages.length > 0) {
			body.push(formatFlow(stages, theme));
			for (const stage of stages) body.push(formatStageRow(stage, theme));
			const last = stages.at(-1);
			if (!this.options.isPartial && last?.status === "completed" && last.inline) {
				const lines = last.inline
					.replace(/\n*_agentId: [^\n]*_\s*$/, "")
					.split("\n")
					.slice(0, this.options.expanded ? undefined : 8);
				body.push("");
				body.push(...lines.map((line) => theme.fg("toolOutput", `  ${line}`)));
			}
		}
		if (width < 24) {
			return [truncateToWidth(title, width, "…"), ...body.map((line) => truncateToWidth(line, width, "…"))];
		}
		const borderColor = this.isError ? "error" : this.options.isPartial ? "accent" : "dim";
		const edge = (text: string) => theme.fg(borderColor, text);
		const inner = width - 4;
		const lines: string[] = [];
		const titleClipped = truncateToWidth(title, inner - 2, "…");
		const fill = Math.max(0, inner - visibleWidth(titleClipped) - 1);
		lines.push(`${edge("╭─")} ${titleClipped} ${edge("─".repeat(fill))}${edge("╮")}`);
		for (const raw of body) {
			const clipped = truncateToWidth(raw, inner, "…");
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
			lines.push(`${edge("│")} ${clipped}${pad} ${edge("│")}`);
		}
		lines.push(edge(`╰${"─".repeat(width - 2)}╯`));
		return lines;
	}
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createChainToolDefinition(
	opts: CreateChainToolOptions,
): ToolDefinition<typeof chainToolSchema, ChainToolDetails> {
	const agentDir = opts.agentDir ?? getAgentDir();
	const initial = loadChains({ cwd: opts.cwd, agentDir });
	const roster =
		initial.chains.size > 0
			? [...initial.chains.values()].map((chain) => `- ${chain.name}: ${chain.description ?? ""}`).join("\n")
			: "No chains defined yet (add .pi/chains/*.yaml).";

	return {
		name: "chain",
		label: "chain",
		description:
			"Run a declarative multi-agent chain (stages of subagents with dependencies, per-stage models, " +
			"and shell verify gates that feed failures back to the stage's agent). " +
			"Available chains:\n" +
			roster,
		promptSnippet: "Run a predefined multi-agent chain from .pi/chains/",
		parameters: chainToolSchema,
		async execute(_toolCallId, args: ChainToolInput, signal?: AbortSignal, onUpdate?) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const loaded = loadChains({ cwd: opts.cwd, agentDir });
			const definition = loaded.chains.get(args.chain.trim().toLowerCase());
			if (!definition) {
				const names = [...loaded.chains.keys()].join(", ") || "none";
				const errors = loaded.errors.length > 0 ? `\nLoad errors:\n${loaded.errors.join("\n")}` : "";
				throw new Error(`Unknown chain "${args.chain}". Available: ${names}.${errors}`);
			}
			const definitions = loadAgentDefinitions({
				cwd: opts.cwd,
				agentDir,
				packageAgentDirs: opts.packageAgentDirs,
			});

			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			let pendingStages: ChainStageResult[] | undefined;
			const pushUpdate = (stages: ChainStageResult[]): void => {
				if (!onUpdate) return;
				pendingStages = stages;
				if (updateTimer) return;
				updateTimer = setTimeout(() => {
					updateTimer = undefined;
					if (!pendingStages) return;
					onUpdate({
						content: [{ type: "text", text: "chain running…" }],
						details: { chain: definition.name, stages: pendingStages, live: true },
					});
					pendingStages = undefined;
				}, 150);
			};

			try {
				const result = await runChain({
					definition,
					input: args.input ?? "",
					parent: {
						session: opts.parentSession,
						depth: opts.parentSession.subagentDepth,
						sessionFile: opts.parentSession.sessionFile,
					},
					parentType: opts.parentSession.subagentType,
					definitions,
					deps: opts.spawnDeps,
					cwd: opts.cwd,
					signal,
					onUpdate: pushUpdate,
				});

				const summary = result.stages
					.map((stage) => {
						const head = `### ${stage.id} (${stage.agent}) — ${stage.status}`;
						if (stage.status === "completed") {
							return `${head}\n${stage.inline ?? ""}${stage.handle ? `\nhandle: ${stage.handle}` : ""}`;
						}
						return `${head}${stage.error ? `\n${stage.error}` : ""}`;
					})
					.join("\n\n");
				return {
					content: [{ type: "text", text: `Chain ${result.chain}: ${result.status}\n\n${summary}` }],
					details: { chain: result.chain, status: result.status, stages: result.stages },
					isError: result.status === "failed",
				};
			} finally {
				if (updateTimer) clearTimeout(updateTimer);
			}
		},
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = context.state as { card?: ChainToolCard };
			state.card ??= new ChainToolCard(theme);
			state.card.setArgs(args);
			return state.card;
		},
		renderResult(result, options, theme, context) {
			const state = context.state as { card?: ChainToolCard };
			const details = result.details as ChainToolDetails | undefined;
			if (!state.card) {
				const fallback = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				return new Text(theme.fg("toolOutput", fallback), 0, 0);
			}
			state.card.setResult(details, options, context.isError);
			return EMPTY_COMPONENT;
		},
	};
}

export function createChainTool(opts: CreateChainToolOptions): AgentTool<typeof chainToolSchema> {
	return wrapToolDefinition(createChainToolDefinition(opts));
}

export function createUnavailableChainToolDefinition(): ToolDefinition<typeof chainToolSchema, ChainToolDetails> {
	return {
		name: "chain",
		label: "chain",
		description: "Chain execution is unavailable in this tool context.",
		promptSnippet: "Chain execution is unavailable in this context",
		parameters: chainToolSchema,
		async execute() {
			throw new Error("chain tool requires an AgentSession context");
		},
	};
}
