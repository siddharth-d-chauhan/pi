/**
 * ChatSearchComponent — in-chat search over the CURRENT session's
 * conversation: user prompts, assistant replies, tool calls/results, and
 * bash executions. The twin of HistorySearchComponent (which searches only
 * prior user prompts to re-fill the editor); this one searches everything
 * and jumps to the selected message.
 *
 * Behaviour:
 *  - User types a query; the match list narrows on each keystroke
 *    (case-insensitive substring first, fuzzy match as fallback).
 *  - Matches are listed newest → oldest with the hit highlighted.
 *  - Up/Down (and PageUp/PageDown) move through matches.
 *  - Enter selects the highlighted match: `onSelect(messageIndex)` fires
 *    with the entry's index in the owner's message-navigation space.
 *  - Esc / Ctrl-C closes via `onClose`.
 *
 * The component is a self-contained input handler; the owner (interactive
 * mode) wires `onSelect` and `onClose` to its own overlay lifecycle and
 * message navigation (currentMessageIndex / jumpTo* methods).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	fuzzyMatch,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/** One searchable conversation message. */
export interface ChatSearchEntry {
	/**
	 * Index in the owner's message-navigation space (interactive mode's
	 * currentMessageIndex). Passed through verbatim to `onSelect`.
	 * `buildChatSearchEntries` assigns the entry's ordinal position.
	 */
	index: number;
	/** Short role label shown next to the snippet (e.g. "user", "tool"). */
	role: string;
	/** Flattened plain text used for matching and snippets. */
	text: string;
}

export interface ChatSearchOptions {
	/** Searchable conversation entries, oldest → newest. */
	entries: ChatSearchEntry[];
	/** Initial query, pre-filled (optional). */
	initialQuery?: string;
	/** Called with the chosen entry's message index. */
	onSelect: (messageIndex: number) => void;
	/** Called when the user dismisses without choosing. */
	onClose: () => void;
}

interface ChatSearchMatch {
	entry: ChatSearchEntry;
	/** Start of the substring hit in entry.text, or -1 (fuzzy/browse). */
	matchStart: number;
	/** Length of the hit in entry.text (0 when matchStart is -1). */
	matchLength: number;
}

const MAX_VISIBLE = 8;
const SNIPPET_CONTEXT_BEFORE = 24;
const PROMPT_PREFIX = "(chat-search)`";
const PROMPT_SUFFIX = "': ";

export class ChatSearchComponent extends Container {
	private query: string;
	private selectedIndex = 0;
	private matchList: ChatSearchMatch[];
	private readonly entries: ChatSearchEntry[];
	private readonly onSelect: (messageIndex: number) => void;
	private readonly onClose: () => void;

	constructor(opts: ChatSearchOptions) {
		super();
		// Normalize to single-line text so snippets and highlight offsets are
		// stable regardless of how the provider flattened the messages.
		this.entries = opts.entries.map((e) => ({ ...e, text: normalizeWhitespace(e.text) }));
		this.query = opts.initialQuery ?? "";
		this.onSelect = opts.onSelect;
		this.onClose = opts.onClose;
		this.matchList = this.computeMatches();
		this.addChild(new DynamicBorder());
		this.addChild(new ChatSearchBody((width) => this.renderBody(width)));
		this.addChild(new DynamicBorder());
	}

	/** Matches for the current query, newest → oldest. Empty query lists all. */
	private computeMatches(): ChatSearchMatch[] {
		const out: ChatSearchMatch[] = [];
		const q = this.query.trim();
		// Case-insensitive literal match on the ORIGINAL text: indexing into a
		// lowercased copy would shift offsets when lowercasing changes string
		// length (e.g. 'İ'), and allocating that copy per keystroke is wasted
		// work on large entries anyway.
		const pattern = q ? new RegExp(escapeRegex(q), "i") : undefined;
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (!pattern) {
				out.push({ entry, matchStart: -1, matchLength: 0 });
				continue;
			}
			const hit = pattern.exec(entry.text);
			if (hit) {
				out.push({ entry, matchStart: hit.index, matchLength: hit[0].length });
			} else if (fuzzyMatch(q, entry.text).matches) {
				out.push({ entry, matchStart: -1, matchLength: 0 });
			}
		}
		return out;
	}

	private refresh(): void {
		this.matchList = this.computeMatches();
		this.selectedIndex = 0;
	}

	private renderBody(width: number): string[] {
		const innerWidth = Math.max(20, width);
		const lines: string[] = [];
		lines.push(this.renderPromptRow(innerWidth));
		lines.push("");
		if (this.matchList.length === 0) {
			const empty = this.query.trim() ? "(no matches)" : "(empty conversation)";
			lines.push(truncateToWidth(theme.fg("muted", `  ${empty}`), innerWidth, "…", true));
		} else {
			if (this.selectedIndex >= this.matchList.length) this.selectedIndex = this.matchList.length - 1;
			const start = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.matchList.length - MAX_VISIBLE),
			);
			const end = Math.min(start + MAX_VISIBLE, this.matchList.length);
			for (let i = start; i < end; i++) {
				lines.push(this.renderMatchRow(this.matchList[i], i === this.selectedIndex, innerWidth));
			}
			if (start > 0 || end < this.matchList.length) {
				const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.matchList.length})`);
				lines.push(truncateToWidth(scrollInfo, innerWidth, "…", true));
			}
		}
		lines.push("");
		lines.push(
			truncateToWidth(
				theme.fg("dim", "Enter to jump · Up/Down to move · Esc to close"),
				innerWidth,
				theme.fg("dim", "…"),
				true,
			),
		);
		return lines;
	}

	private renderPromptRow(width: number): string {
		const count =
			this.query.trim().length > 0
				? `${this.matchList.length}/${this.entries.length} messages`
				: `${this.entries.length} messages`;
		const prompt =
			theme.fg("accent", PROMPT_PREFIX) +
			theme.fg("text", this.query) +
			theme.fg("accent", "█") + // block cursor
			theme.fg("muted", PROMPT_SUFFIX) +
			theme.fg("dim", count);
		return truncateToWidth(prompt, width, theme.fg("dim", "…"), true);
	}

	private renderMatchRow(match: ChatSearchMatch, isSelected: boolean, width: number): string {
		const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
		const roleTag = `[${match.entry.role}] `;
		const roleLabel = theme.fg(isSelected ? "accent" : "muted", isSelected ? theme.bold(roleTag) : roleTag);
		const budget = Math.max(4, width - 2 - visibleWidth(roleTag));
		return truncateToWidth(cursor + roleLabel + this.renderSnippet(match, budget), width, theme.fg("dim", "…"), true);
	}

	/** Snippet around the hit, highlighted, at most `budget` columns. */
	private renderSnippet(match: ChatSearchMatch, budget: number): string {
		const text = match.entry.text;
		if (match.matchStart < 0 || match.matchLength === 0) {
			return truncateToWidth(theme.fg("text", text), budget, theme.fg("dim", "…"));
		}
		const start = match.matchStart;
		const end = start + match.matchLength;
		let before = text.slice(0, start);
		if (before.length > SNIPPET_CONTEXT_BEFORE) {
			before = `…${before.slice(before.length - SNIPPET_CONTEXT_BEFORE)}`;
		}
		const colored =
			theme.fg("dim", before) +
			theme.fg("accent", theme.bold(text.slice(start, end))) +
			theme.fg("text", text.slice(end));
		return truncateToWidth(colored, budget, theme.fg("dim", "…"));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const match = this.matchList[this.selectedIndex];
			if (match) this.onSelect(match.entry.index);
			else this.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.matchList.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.matchList.length - 1 : this.selectedIndex - 1;
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.matchList.length > 0) {
				this.selectedIndex = this.selectedIndex === this.matchList.length - 1 ? 0 : this.selectedIndex + 1;
			}
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			if (this.matchList.length > 0) this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			if (this.matchList.length > 0) {
				this.selectedIndex = Math.min(this.matchList.length - 1, this.selectedIndex + MAX_VISIBLE);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.refresh();
			}
			return;
		}
		// Printable input (single keystroke or paste) — append. Escape
		// sequences not matched above are ignored.
		if (!data.startsWith("\x1b")) {
			let appended = "";
			for (const ch of data) {
				if (ch >= " " && ch !== "\x7f") appended += ch;
			}
			if (appended.length > 0) {
				this.query += appended;
				this.refresh();
			}
		}
	}
}

/** Inner body component: delegates rendering so it stays width-aware. */
class ChatSearchBody implements Component {
	private readonly renderFn: (width: number) => string[];

	constructor(renderFn: (width: number) => string[]) {
		this.renderFn = renderFn;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		return this.renderFn(width);
	}
}

const MAX_ARGUMENT_CHARS = 40;
const MAX_ARGUMENTS_CHARS = 120;
/**
 * Cap per-entry searchable text. Entries only feed matching and a one-line
 * snippet; carrying megabyte tool outputs would make every keystroke rescan
 * the full corpus on the render thread.
 */
const MAX_ENTRY_CHARS = 2000;

/**
 * Flatten the session's messages (AgentSession.messages) into searchable
 * entries, oldest → newest. Each entry's `index` is its ordinal position
 * among the emitted entries, matching the "one row per user-visible
 * message" model of interactive mode's message navigation.
 */
export function buildChatSearchEntries(messages: AgentMessage[]): ChatSearchEntry[] {
	const out: ChatSearchEntry[] = [];
	const push = (role: string, text: string): void => {
		const normalized = normalizeWhitespace(text);
		if (normalized) out.push({ index: out.length, role, text: clipText(normalized, MAX_ENTRY_CHARS) });
	};
	for (const message of messages) {
		switch (message.role) {
			case "user":
				push("user", flattenBlocks(message.content));
				break;
			case "assistant": {
				const parts: string[] = [];
				for (const block of message.content) {
					if (block.type === "text") parts.push(block.text);
					else if (block.type === "toolCall") parts.push(formatToolCall(block));
					// Thinking blocks are intentionally excluded from search.
				}
				push("assistant", parts.join(" "));
				break;
			}
			case "toolResult":
				push("tool", `${message.toolName}: ${flattenBlocks(message.content)}`);
				break;
			case "bashExecution":
				push("bash", `${message.command} ${message.output}`);
				break;
			case "branchSummary":
				push("summary", message.summary);
				break;
			case "compactionSummary":
				push("summary", message.summary);
				break;
			case "custom":
				if (message.display) push("custom", flattenBlocks(message.content));
				break;
			default:
				break;
		}
	}
	return out;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flattenBlocks(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join(" ");
}

/** Compact `name(key: value, …)` form of a tool call, JSON stripped down. */
function formatToolCall(call: ToolCall): string {
	const entries: [string, unknown][] = Object.entries(call.arguments);
	const parts: string[] = [];
	for (const [key, value] of entries) {
		const rendered = typeof value === "string" ? value : stringifyArgument(value);
		parts.push(`${key}: ${clipText(rendered, MAX_ARGUMENT_CHARS)}`);
	}
	return `${call.name}(${clipText(parts.join(", "), MAX_ARGUMENTS_CHARS)})`;
}

function stringifyArgument(value: unknown): string {
	try {
		const json: string | undefined = JSON.stringify(value);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}

function clipText(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
