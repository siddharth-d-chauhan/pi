/**
 * Tool category registry — assigns each known tool to a UI category so the
 * /tools selector can group them. The set is intentionally small: a single
 * string per tool, no behavior, easy to extend.
 *
 * Tools not listed here fall into the "other" category. Extensions can
 * register additional tools without touching this file — the selector will
 * still show them, just under "other" until someone adds an entry.
 *
 * To add a new tool: add a single line to TOOL_CATEGORY. No other changes
 * are required.
 */

export type ToolCategory = "files" | "runtime" | "code-intel" | "coord" | "outside" | "memory" | "other";

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
	"files",
	"runtime",
	"code-intel",
	"coord",
	"outside",
	"memory",
	"other",
] as const;

const TOOL_CATEGORY: Record<string, ToolCategory> = {
	// Files & search
	read: "files",
	write: "files",
	edit: "files",
	ls: "files",
	find: "files",
	grep: "files",
	// Runtime
	bash: "runtime",
	// Code intelligence
	lsp: "code-intel",
	debug: "code-intel",
	// Coordination
	agent: "coord",
	agent_message: "coord",
	chain: "coord",
	agent_list: "coord",
	agent_pull: "coord",
	task: "coord",
	irc: "coord",
	todo: "coord",
	job: "coord",
	ask: "coord",
	// Outside (network / browser / image)
	browser: "outside",
	web_search: "outside",
	web_fetch: "outside",
	github: "outside",
	generate_image: "outside",
	inspect_image: "outside",
	tts: "outside",
	// Memory (Hindsight / brain)
	retain: "memory",
	recall: "memory",
	reflect: "memory",
	checkpoint: "memory",
	rewind: "memory",
	search_tool_bm25: "memory",
};

/** Get the category for a tool name; defaults to "other". */
export function getToolCategory(toolName: string): ToolCategory {
	return TOOL_CATEGORY[toolName] ?? "other";
}

const CATEGORY_LABEL: Record<ToolCategory, string> = {
	files: "Files & search",
	runtime: "Runtime",
	"code-intel": "Code intelligence",
	coord: "Coordination",
	outside: "Outside the box",
	memory: "Memory & state",
	other: "Other",
};

export function getCategoryLabel(category: ToolCategory): string {
	return CATEGORY_LABEL[category];
}
