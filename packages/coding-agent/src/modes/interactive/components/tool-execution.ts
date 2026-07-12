import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";

// When `expanded` is false, a result with more than this many lines is
// collapsed to the first COLLAPSE_HEAD_LINES lines + a hint. The user
// presses `app.tools.expand` to toggle. The threshold is intentionally
// generous — most one-line tool results stay uncollapsed.
const COLLAPSE_LINE_THRESHOLD = 30;
const COLLAPSE_HEAD_LINES = 28;

/**
 * omp-style shell painter: instead of a full-width background band, prefix
 * each padded line with a colored left rule. The Box/Text shells pad lines
 * by one column, so swapping that space for the rule glyph keeps width.
 */
function ruleShell(color: Parameters<typeof theme.fg>[0]): (text: string) => string {
	return (text: string) => theme.fg(color, "▎") + text.slice(1);
}

const SGR = /^\x1b\[[0-9;]*m/;

/**
 * Place a status `dot` on a card's header line so it reads as part of the
 * existing chrome, without growing the line past `width` (the TUI asserts on
 * overflow). Three chrome shapes are handled:
 *   • `▎` left rule  → `▎ ○ $ echo …`  (dot after the rail)
 *   • `╭─ …` box top → `╭─ ○ $ echo … ─╮`  (dot as the first title token;
 *     dashes are removed from the border run so the `╮` corner survives)
 *   • neither        → `○ …`  (plain prefix, clamped)
 */
function injectStatusDot(line: string, dot: string, width: number): string {
	const rail = line.indexOf("▎");
	if (rail >= 0) {
		let end = rail + "▎".length;
		const reset = line.slice(end).match(SGR);
		if (reset) end += reset[0].length;
		return truncateToWidth(`${line.slice(0, end)} ${dot}${line.slice(end)}`, width);
	}
	const corner = line.search(/[╭├╰]/);
	if (corner >= 0) {
		// advance past the corner and its "─ " lead-in (tolerating SGR codes)
		let end = corner + 1;
		while (end < line.length) {
			const sgr = line.slice(end).match(SGR);
			if (sgr) {
				end += sgr[0].length;
				continue;
			}
			if (line[end] === "─" || line[end] === " ") {
				end++;
				continue;
			}
			break;
		}
		let out = `${line.slice(0, end)}${dot}${line.slice(end)}`;
		// reclaim the added cells from the border run so width — and the closing
		// corner — are preserved.
		while (visibleWidth(out) > width) {
			const i = out.lastIndexOf("─");
			if (i < 0) break;
			out = out.slice(0, i) + out.slice(i + 1);
		}
		return out;
	}
	return truncateToWidth(dot + line, width);
}

const SGR_G = /\x1b\[[0-9;]*m/g;
const CHROME = /[\s▎│╭╮╰╯├┤┬┴┼─]/g;

/** True when a line carries real text — not just rail/box glyphs and spaces.
 *  Used to skip a box's blank padding/border rows when placing the status dot. */
function hasHeaderText(line: string): boolean {
	return line.replace(SGR_G, "").replace(CHROME, "").length > 0;
}

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, ruleShell("muted"));
		this.contentText = new Text("", 1, 1, ruleShell("muted"));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		// Collapse long outputs by default; the user toggles with
		// `app.tools.expand`. The hint shows how many lines are hidden
		// so the user knows there's content.
		if (!this.expanded) {
			const lines = output.split("\n");
			if (lines.length > COLLAPSE_LINE_THRESHOLD) {
				const head = lines.slice(0, COLLAPSE_HEAD_LINES).join("\n");
				const hidden = lines.length - COLLAPSE_HEAD_LINES;
				const hint = `\n${theme.fg(
					"muted",
					`… ${hidden} more line${hidden === 1 ? "" : "s"} (press ${theme.fg("accent", "ctrl+o")} to expand)`,
				)}`;
				return new Text(theme.fg("toolOutput", head + hint), 0, 0);
			}
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}
	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...this.withStatusDot(contentLines, width));
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return this.withStatusDot(super.render(width), width);
	}

	/**
	 * Chips-language status marker: a rim-coloured ○ after the rail on the first
	 * content line — amber while running, green on success, red on error, dim
	 * before start. Unifies tool cards with the loop panel / agents hub / widget.
	 */
	private statusDotColor(): Parameters<typeof theme.fg>[0] {
		if (this.result) return this.result.isError ? "error" : "success";
		return this.executionStarted ? "warning" : "dim";
	}

	private withStatusDot(lines: string[], width: number): string[] {
		// The header is the first line with real text — NOT a pure-chrome line
		// (a box border/padding row of only rail, frame glyphs and spaces), which
		// `.trim()` would wrongly accept because `▎`/`╭` are non-space.
		const header = lines.findIndex((line) => hasHeaderText(line));
		if (header < 0) return lines;
		const dot = `${theme.fg(this.statusDotColor(), "○")} `;
		const copy = lines.slice();
		copy[header] = injectStatusDot(copy[header], dot, width);
		return copy;
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? ruleShell("accent")
			: this.result?.isError
				? ruleShell("error")
				: ruleShell("muted");

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
