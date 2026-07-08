/**
 * Tool Cards Extension — omp-style colorful rounded-border cards for the
 * built-in tools, replacing the default background-block shell.
 *
 *   ╭─ ⠹ bash npm test ───────────────╮   running: spinner + pulsing border
 *   │ …streaming output…              │
 *   ╰─────────────────────────────────╯
 *
 *   ● read src/foo.ts · 0.3s              previous turns collapse to a row
 *
 * Features:
 * - Per-tool border/title colors (theme palette).
 * - Live spinner + soft border pulse while a tool runs.
 * - Edit cards always show a mini-diff (first lines of the change,
 *   +/- colored) even when collapsed; ctrl+o expands.
 * - Once a turn finishes, its tool cards collapse to one-line rows
 *   (ctrl+o restores the full card); the current turn stays boxed.
 * - A dim turn-summary line (`3+ tools`) is appended after busy turns.
 *
 * Implementation: re-registers the built-in tools (the sanctioned override
 * pattern from examples/built-in-tool-renderer.ts) with `renderShell:
 * "self"`, delegating execute AND the original renderers, then boxing the
 * rendered lines. File-mutation queueing lives inside edit/write execute,
 * so delegation preserves it.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type ExtensionAPI,
	type ThemeColor,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { cardLines, pulseOn, rtrimAnsi, spinnerGlyph } from "./lib/card.ts";

/** Per-tool border/title colors — colorful, but from the theme palette. */
const TOOL_COLORS: Record<string, ThemeColor> = {
	read: "mdLink",
	grep: "mdCode",
	find: "mdQuote",
	ls: "mdHeading",
	bash: "warning",
	edit: "success",
	write: "accent",
};

/** Diff lines shown in a collapsed edit card before the expand hint. */
const MINI_DIFF_LINES = 10;

type ThemeLike = { fg(name: string, text: string): string; bold(text: string): string };

// Current turn index — cards created in earlier turns render collapsed.
let currentTurn = 0;

/** Exported for headless render probes. */
export function setCurrentTurnForTests(turn: number): void {
	currentTurn = turn;
}

/** Exported for headless render probes. */
export class ToolCardComponent implements Component {
	private theme: ThemeLike;
	private color: string;
	private callChild: Component | undefined;
	private resultChild: Component | undefined;
	private extraBody: string[] | undefined;
	private isError = false;
	private isPartial = true;
	private expanded = false;
	private turn: number;
	private startedAt = Date.now();
	private settledMs: number | undefined;

	constructor(theme: ThemeLike, color: string) {
		this.theme = theme;
		this.color = color;
		this.turn = currentTurn;
	}

	setCall(child: Component | undefined): void {
		this.callChild = child;
	}

	setResult(
		child: Component | undefined,
		opts: { isError: boolean; isPartial: boolean; expanded: boolean; extraBody?: string[] },
	): void {
		this.resultChild = child;
		this.isError = opts.isError;
		this.isPartial = opts.isPartial;
		this.expanded = opts.expanded;
		this.extraBody = opts.extraBody;
		if (!opts.isPartial && this.settledMs === undefined) {
			this.settledMs = Date.now() - this.startedAt;
		}
	}

	invalidate(): void {
		this.callChild?.invalidate?.();
		this.resultChild?.invalidate?.();
	}

	render(width: number): string[] {
		try {
			return this.renderCard(width);
		} catch {
			// renderShell "self" runs outside the renderer try/catch; a throw
			// here would crash the TUI. Degrade to an empty row instead.
			return [];
		}
	}

	private renderCard(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(10, width - 4);
		const callLines = this.callChild?.render(inner) ?? [];
		const title: string | undefined = callLines[0];

		// Finished cards from PREVIOUS turns collapse to one row (6).
		if (!this.isPartial && this.turn !== currentTurn && !this.expanded) {
			const dot = theme.fg(this.isError ? "error" : "success", "●");
			const elapsed =
				this.settledMs !== undefined ? theme.fg("dim", ` · ${(this.settledMs / 1000).toFixed(1)}s`) : "";
			return [truncateToWidth(`${dot} ${rtrimAnsi(title ?? "")}${elapsed}`, width, "…")];
		}

		const restCall = callLines.slice(1);
		const resultLines = this.resultChild?.render(inner) ?? [];
		const body = [...restCall, ...resultLines, ...(this.extraBody ?? [])];

		// Running: spinner in the title + soft border pulse (3).
		let renderTitle = title;
		let colorName = this.isError ? "error" : this.isPartial ? this.color : "dim";
		if (this.isPartial) {
			renderTitle = `${theme.fg("accent", spinnerGlyph())} ${title ?? ""}`;
			if (!pulseOn()) colorName = "dim";
		}

		return cardLines({
			width,
			title: renderTitle,
			body,
			edge: (text) => theme.fg(colorName, text),
		});
	}
}

/** Mini-diff body for edit cards (4): +/- colored, capped, expand hint. */
/** Exported for headless render probes. */
export function miniDiffBody(
	details: EditToolDetails | undefined,
	expanded: boolean,
	theme: ThemeLike,
): string[] | undefined {
	const diff = details?.diff;
	if (!diff) return undefined;
	let lines = diff.replace(/\n+$/, "").split("\n");
	let hint: string | undefined;
	if (!expanded && lines.length > MINI_DIFF_LINES) {
		const hidden = lines.length - MINI_DIFF_LINES;
		lines = lines.slice(0, MINI_DIFF_LINES);
		hint = theme.fg("dim", `… ${hidden} more diff line${hidden === 1 ? "" : "s"} (ctrl+o)`);
	}
	const out = lines.map((line) => {
		if (line.startsWith("+")) return theme.fg("success", line);
		if (line.startsWith("-")) return theme.fg("error", line);
		return theme.fg("dim", line);
	});
	if (hint) out.push(hint);
	return out;
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };

interface TurnSummaryData {
	turnIndex: number;
	counts: Record<string, number>;
	totalMs: number;
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const definitions: ToolDefinition<any, any>[] = [
		createReadToolDefinition(cwd),
		createBashToolDefinition(cwd),
		createEditToolDefinition(cwd),
		createWriteToolDefinition(cwd),
		createGrepToolDefinition(cwd),
		createFindToolDefinition(cwd),
		createLsToolDefinition(cwd),
	];

	for (const definition of definitions) {
		const color = TOOL_COLORS[definition.name] ?? "accent";
		const isEdit = definition.name === "edit";
		pi.registerTool({
			...definition,
			renderShell: "self",
			renderCall(args, theme, context) {
				const state = context.state as { card?: ToolCardComponent; callChild?: Component };
				state.card ??= new ToolCardComponent(theme, color);
				const child = definition.renderCall?.(args, theme, { ...context, lastComponent: state.callChild });
				state.callChild = child;
				state.card.setCall(child);
				return state.card;
			},
			renderResult(result, options, theme, context) {
				const state = context.state as { card?: ToolCardComponent; resultChild?: Component };
				if (!state.card) return EMPTY_COMPONENT;
				const extraBody = isEdit
					? miniDiffBody(result.details as EditToolDetails | undefined, options.expanded, theme)
					: undefined;
				// Edit cards render OUR mini-diff; skip the delegated result body
				// so the diff doesn't appear twice (the default edit renderer
				// paints its preview into the call component).
				const child =
					!isEdit && definition.renderResult
						? definition.renderResult(result, options, theme, { ...context, lastComponent: state.resultChild })
						: undefined;
				state.resultChild = child;
				state.card.setResult(child, {
					isError: context.isError,
					isPartial: options.isPartial,
					expanded: options.expanded,
					extraBody,
				});
				return EMPTY_COMPONENT;
			},
		});
	}

	// ---- Turn tracking (6): collapse older cards + summary line ----------
	const runningTools = new Map<string, { name: string; start: number }>();
	let turnCounts: Record<string, number> = {};
	let turnTotalMs = 0;
	let turnToolCount = 0;

	pi.on("turn_start", async (event) => {
		currentTurn = event.turnIndex;
		turnCounts = {};
		turnTotalMs = 0;
		turnToolCount = 0;
	});

	pi.on("tool_execution_start", async (event) => {
		const start = event as unknown as { toolCallId?: string; toolName?: string };
		if (start.toolCallId && start.toolName) {
			runningTools.set(start.toolCallId, { name: start.toolName, start: Date.now() });
		}
	});

	pi.on("tool_execution_end", async (event) => {
		const end = event as unknown as { toolCallId?: string };
		const entry = end.toolCallId ? runningTools.get(end.toolCallId) : undefined;
		if (!entry) return;
		runningTools.delete((end as { toolCallId: string }).toolCallId);
		turnCounts[entry.name] = (turnCounts[entry.name] ?? 0) + 1;
		turnTotalMs += Date.now() - entry.start;
		turnToolCount += 1;
	});

	pi.on("turn_end", async (event) => {
		if (turnToolCount >= 3) {
			pi.appendEntry<TurnSummaryData>("turn-summary", {
				turnIndex: event.turnIndex,
				counts: { ...turnCounts },
				totalMs: turnTotalMs,
			});
		}
	});

	pi.registerEntryRenderer<TurnSummaryData>("turn-summary", (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
		const perTool = Object.entries(data.counts)
			.sort(([, a], [, b]) => b - a)
			.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
			.join(" · ");
		const text = theme.fg("dim", `╶─ ${total} tools · ${perTool} · ${(data.totalMs / 1000).toFixed(1)}s ─╴`);
		return {
			render: (width: number) => [truncateToWidth(text, width, "…")],
			invalidate() {},
		};
	});
}
