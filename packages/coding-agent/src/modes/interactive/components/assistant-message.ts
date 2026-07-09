import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, StreamingMarkdownView, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message.
 *
 * Text content blocks stream through `StreamingMarkdownView` so that:
 *  - short answers stay in atomic mode (whole buffer re-rendered fresh each
 *    frame, no mid-line commits visible to the user), and
 *  - long answers cross the threshold and switch to incremental line-commits
 *    (a line only ships to the screen once its trailing newline lands, so
 *    already-displayed lines never re-flow).
 *
 * Thinking blocks, error/abort trailers, and tool-call shape are handled as
 * before — they don't suffer from the streaming re-flow problem (they're
 * either complete at render time or have stable wrap characteristics).
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	/**
	 * Per text-block streaming views, keyed by content index. Reused across
	 * `updateContent` calls so the line-commit buffer survives the per-frame
	 * rebuild of `contentContainer` and we avoid re-flow jitter on
	 * already-displayed lines.
	 *
	 * Map (not Record) because content indices are dynamic — they're the
	 * position of a text block inside `message.content`, which can grow,
	 * shift, or shrink across stream ticks.
	 */
	private textViews: Map<number, StreamingMarkdownView> = new Map();
	/** Last seen text per content block, for delta computation. */
	private textSeen: Map<number, string> = new Map();
	/**
	 * Set by `invalidate()` and `setOutputPad()` to signal that every
	 * streaming view's cache must be dropped and its buffer re-seeded from
	 * the latest snapshot on the next `updateContent`.
	 */
	private textViewsDirty = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		// Drop each streaming view's committed-prefix cache so the next
		// `updateContent` re-lays everything out (the theme / layout may
		// have changed). We re-seed from the latest known text rather than
		// calling `view.invalidate()`, which would also drop the buffer
		// text — the buffer is the source of truth for streamed content.
		this.textViewsDirty = true;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.textViewsDirty = true;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;

		// Track which text-block indices we still expect to see this frame,
		// so we can drop views whose content disappeared (rare, but possible
		// after a rewrite).
		const seenIndices = new Set<number>();

		// Clear content container — children are rebuilt every frame so the
		// ordering of thinking/text/spacers stays consistent with message
		// shape. The streaming views themselves are NOT cleared here; they
		// live in `textViews` and are appended back into the container below.
		this.contentContainer.clear();

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				const trimmed = content.text.trim();
				let view = this.textViews.get(i);
				if (!view) {
					view = new StreamingMarkdownView(this.outputPad, 0, this.markdownTheme);
					// Seed with everything present at first sight — text that
					// arrived before this block's first render (or a fully
					// formed static message) would otherwise be dropped: the
					// `textSeen` bookkeeping below marks it delivered.
					view.seed(trimmed);
					this.textViews.set(i, view);
				} else if (this.textViewsDirty) {
					// Theme or padding changed: propagate the new layout
					// args and reseed from the latest snapshot.
					view.updateLayout(this.outputPad, 0, this.markdownTheme);
					view.seed(trimmed);
				} else {
					const previous = this.textSeen.get(i) ?? "";
					if (trimmed.startsWith(previous)) {
						// Common case: monotonic append. Just append the delta.
						view.append(trimmed.slice(previous.length));
					} else {
						// Resync (rare): the producer rewound or replaced
						// the text out from under us. Reseed the buffer.
						view.seed(trimmed);
					}
				}
				this.textSeen.set(i, trimmed);
				seenIndices.add(i);
				this.contentContainer.addChild(view);
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static thinking label when hidden
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				} else {
					// Thinking traces in thinkingText color, italic
					this.contentContainer.addChild(
						new Markdown(content.thinking.trim(), this.outputPad, 0, this.markdownTheme, {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					if (hasVisibleContentAfter) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		// Drop views for indices that no longer appear (their content block
		// was removed from `message.content`). Their buffers would otherwise
		// linger indefinitely.
		for (const idx of [...this.textViews.keys()]) {
			if (!seenIndices.has(idx)) {
				this.textViews.delete(idx);
				this.textSeen.delete(idx);
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					this.outputPad,
					0,
				),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}

		// Once the producer signals the message is done (any of the three
		// final stop reasons), flush each streaming buffer so any remaining
		// uncommitted tail is rendered as part of the committed prefix on
		// the next frame.
		if (message.stopReason !== undefined && message.stopReason !== "toolUse") {
			for (const view of this.textViews.values()) {
				view.markComplete();
			}
		}

		// Dirty flags are one-shot: each `updateContent` consumes them.
		this.textViewsDirty = false;
	}
}
