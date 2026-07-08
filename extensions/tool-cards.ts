/**
 * Tool Cards Extension — omp-style colorful rounded-border cards for the
 * built-in tools, replacing the default background-block shell.
 *
 *   ╭─ read src/foo.ts ───────────────╮   (each tool gets its own color)
 *   │ 42 lines                        │
 *   ╰─────────────────────────────────╯
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
	type ExtensionAPI,
	type ThemeColor,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { cardLines } from "./lib/card.ts";

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

type ThemeLike = { fg(name: string, text: string): string };

class ToolCardComponent implements Component {
	private theme: ThemeLike;
	private color: string;
	private callChild: Component | undefined;
	private resultChild: Component | undefined;
	private isError = false;
	private isPartial = true;

	constructor(theme: ThemeLike, color: string) {
		this.theme = theme;
		this.color = color;
	}

	setCall(child: Component | undefined): void {
		this.callChild = child;
	}

	setResult(child: Component | undefined, isError: boolean, isPartial: boolean): void {
		this.resultChild = child;
		this.isError = isError;
		this.isPartial = isPartial;
	}

	invalidate(): void {
		this.callChild?.invalidate?.();
		this.resultChild?.invalidate?.();
	}

	render(width: number): string[] {
		const inner = Math.max(10, width - 4);
		const callLines = this.callChild?.render(inner) ?? [];
		const resultLines = this.resultChild?.render(inner) ?? [];
		const title: string | undefined = callLines[0];
		const restCall = callLines.slice(1);
		const colorName = this.isError ? "error" : this.isPartial ? this.color : "dim";
		return cardLines({
			width,
			title,
			body: [...restCall, ...resultLines],
			edge: (text) => this.theme.fg(colorName, text),
		});
	}
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };

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
				const child = definition.renderResult
					? definition.renderResult(result, options, theme, { ...context, lastComponent: state.resultChild })
					: undefined;
				state.resultChild = child;
				state.card.setResult(child, context.isError, options.isPartial);
				return EMPTY_COMPONENT;
			},
		});
	}
}
