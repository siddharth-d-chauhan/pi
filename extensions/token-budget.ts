import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";

type ToolResultPatch = {
	content?: ToolResultEvent["content"];
	details?: unknown;
	isError?: boolean;
};

const DEFAULT_MAX_CHARS = 12_000;
const TIGHT_MAX_CHARS = 4_000;
const DEFAULT_DISCOVERY_CHECKPOINT = 12;
const DEFAULT_TOOL_CHECKPOINT = 24;
const DEFAULT_SUBAGENT_TOOL_LIMIT = 14;
const DEFAULT_PRIMARY_TOOL_LIMIT = 32;
const DUPLICATE_MIN_CHARS = 512;
const MUTATION_TOOLS = new Set(["apply_patch", "edit", "write"]);
const BUDGETED_TOOLS = new Set([
	"expert_cases_search",
	"find",
	"grep",
	"knowledge_code_search",
	"knowledge_search",
	"knowledge_call",
	"ls",
	"pi_context_code",
	"pi_semantic_expand",
	"read",
]);
const DEDUPLICATED_TOOLS = new Set(BUDGETED_TOOLS);

function configuredDiscoveryCheckpoint(): number {
	const value = Number(process.env.PI_DISCOVERY_CHECKPOINT_CALLS ?? DEFAULT_DISCOVERY_CHECKPOINT);
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_DISCOVERY_CHECKPOINT;
}

function configuredToolCheckpoint(): number {
	const value = Number(process.env.PI_TOOL_CHECKPOINT_CALLS ?? DEFAULT_TOOL_CHECKPOINT);
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_TOOL_CHECKPOINT;
}

function configuredSubagentToolLimit(): number {
	const value = Number(process.env.PI_SUBAGENT_MAX_TOOL_CALLS ?? DEFAULT_SUBAGENT_TOOL_LIMIT);
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_SUBAGENT_TOOL_LIMIT;
}

/** Subagent discovery checkpoint scales with the tool limit (6/14 of the
 *  default ratio) so a raised budget doesn't tighten results prematurely;
 *  identical to the fixed 6 when the limit is unchanged. */
function subagentDiscoveryCheckpoint(): number {
	return Math.max(6, Math.floor((configuredSubagentToolLimit() * 6) / DEFAULT_SUBAGENT_TOOL_LIMIT));
}

function configuredPrimaryToolLimit(): number {
	const value = Number(process.env.PI_PRIMARY_MAX_TOOL_CALLS ?? DEFAULT_PRIMARY_TOOL_LIMIT);
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_PRIMARY_TOOL_LIMIT;
}

function configuredMaxChars(): number {
	const value = Number(process.env.PI_TOOL_RESULT_MAX_CHARS ?? DEFAULT_MAX_CHARS);
	return Number.isFinite(value) && value >= 1_000 ? Math.floor(value) : DEFAULT_MAX_CHARS;
}

function truncateAtBoundary(text: string, maxChars: number, notice: string): string {
	const contentBudget = Math.max(0, maxChars - notice.length);
	const lineBoundary = text.lastIndexOf("\n", contentBudget);
	const cutAt = lineBoundary >= Math.floor(contentBudget / 2) ? lineBoundary : contentBudget;
	return `${text.slice(0, cutAt).trimEnd()}${notice}`;
}

function truncateMiddleAtBoundary(text: string, maxChars: number, notice: string): string {
	const separator = "\n\n";
	const contentBudget = Math.max(0, maxChars - notice.length - separator.length);
	const headBudget = Math.floor(contentBudget * 0.6);
	const tailBudget = contentBudget - headBudget;
	const headBoundary = text.lastIndexOf("\n", headBudget);
	const headEnd = headBoundary >= Math.floor(headBudget / 2) ? headBoundary : headBudget;
	const tailStartCandidate = Math.max(headEnd, text.length - tailBudget);
	const tailBoundary = text.indexOf("\n", tailStartCandidate);
	const tailStart =
		tailBoundary >= 0 && tailBoundary - tailStartCandidate <= Math.floor(tailBudget / 2)
			? tailBoundary + 1
			: tailStartCandidate;
	return `${text.slice(0, headEnd).trimEnd()}${notice}${separator}${text.slice(tailStart).trimStart()}`;
}

function textContent(event: ToolResultEvent): string {
	return event.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, stableValue(entry)]),
	);
}

function resultFingerprint(event: ToolResultEvent): string {
	return `${event.toolName}:${JSON.stringify(stableValue(event.input))}`;
}

function saveFullOutput(
	event: ToolResultEvent,
	text: string,
	ctx: { sessionManager: { getSessionFile(): string | undefined; getSessionId(): string } },
): string | undefined {
	try {
		const sessionFile = ctx.sessionManager.getSessionFile();
		const directory = sessionFile
			? `${sessionFile}.tool-output`
			: join(tmpdir(), "pi-tool-output", ctx.sessionManager.getSessionId());
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const digest = createHash("sha256").update(text).digest("hex").slice(0, 12);
		const safeToolCallId = event.toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
		const path = join(directory, `${event.toolName}-${safeToolCallId}-${digest}.txt`);
		writeFileSync(path, text, { mode: 0o600 });
		return path;
	} catch {
		return undefined;
	}
}

const DISCOVERY_GUIDANCE =
	"Discovery checkpoint: synthesize what is already known and make a concrete edit, test, or final decision before more broad reading. Do not reread files or ranges already returned.";
const TOOL_LOOP_GUIDANCE =
	"Tool-loop checkpoint: this run has used many tool calls. Summarize the evidence and finish the smallest verified result; batch any remaining independent checks in one turn instead of serial one-call turns.";

function appendNotice(content: ToolResultEvent["content"], notice: string): ToolResultEvent["content"] {
	const firstText = content.findIndex((block) => block.type === "text");
	if (firstText < 0) return [...content, { type: "text", text: notice }];
	return content.map((block, index) =>
		index === firstText && block.type === "text" ? { ...block, text: `${block.text}\n\n[${notice}]` } : block,
	);
}

export default function tokenBudget(pi: ExtensionAPI): void {
	const seenFingerprints = new Map<string, { hash: string; toolCallId: string }>();
	let discoveryCalls = 0;
	let checkpointDelivered = false;
	let toolCalls = 0;
	let startedToolCalls = 0;
	let toolCheckpointDelivered = false;
	let subagentSession = false;
	let blockedBudgetTurns = 0;
	let blockedThisTurn = false;
	const resetDuplicateMemory = () => {
		seenFingerprints.clear();
	};

	const resetSessionMemory = () => {
		resetDuplicateMemory();
		discoveryCalls = 0;
		checkpointDelivered = false;
		toolCalls = 0;
		startedToolCalls = 0;
		toolCheckpointDelivered = false;
		blockedBudgetTurns = 0;
		blockedThisTurn = false;
	};
	pi.on("session_start", async (_event, ctx) => {
		subagentSession = Boolean(ctx.sessionManager.getHeader()?.parentSession);
		resetSessionMemory();
	});
	// Earlier full results may no longer be present after compaction, so duplicate
	// suppression must not point at pre-compaction tool calls.
	pi.on("session_compact", async () => resetDuplicateMemory());
	pi.on("agent_start", async () => {
		discoveryCalls = 0;
		checkpointDelivered = false;
		toolCalls = 0;
		startedToolCalls = 0;
		toolCheckpointDelivered = false;
		blockedBudgetTurns = 0;
		blockedThisTurn = false;
	});
	pi.on("turn_start", async () => {
		blockedThisTurn = false;
	});
	pi.on("tool_call", async (_event: ToolCallEvent, ctx) => {
		const toolLimit = subagentSession ? configuredSubagentToolLimit() : configuredPrimaryToolLimit();
		if (startedToolCalls < toolLimit) {
			startedToolCalls += 1;
			return;
		}
		if (!blockedThisTurn) {
			blockedThisTurn = true;
			blockedBudgetTurns += 1;
		}
		if (blockedBudgetTurns > 1) ctx.abort();
		return {
			block: true,
			reason:
				"Tool budget reached for this run. Do not call another tool; return the best evidence-backed result now. Start a new user-directed run only if more work is genuinely required.",
		};
	});
	pi.on("before_agent_start", async (event) => ({
		systemPrompt:
			`${event.systemPrompt}\n\n## Tool-call discipline\n` +
			`Reuse earlier tool results. Never reread the same file/range or repeat an equivalent search. ` +
			`Batch independent reads and checks in one turn. After broad discovery, synthesize and act; use narrower reads only for missing evidence. ` +
			`For existing files, prefer one apply_patch call with minimal hunks over write or inline shell/Python rewrites; use write for new files. ` +
			`Never resend unchanged whole-file content.` +
			(subagentSession
				? ` As a subagent, target at most ${subagentDiscoveryCheckpoint()} discovery calls and ${configuredSubagentToolLimit()} total tool calls; return the best evidence-backed result instead of widening scope after that budget.`
				: ""),
	}));

	const onToolResult = pi.on as unknown as (
		event: "tool_result",
		handler: (
			event: ToolResultEvent,
			ctx: { sessionManager: { getSessionFile(): string | undefined; getSessionId(): string } },
		) => Promise<ToolResultPatch | undefined>,
	) => void;
	onToolResult("tool_result", async (event, ctx) => {
		toolCalls += 1;
		const toolCheckpoint = subagentSession
			? Math.min(configuredToolCheckpoint(), configuredSubagentToolLimit())
			: configuredToolCheckpoint();
		const toolCheckpointReached = toolCalls >= toolCheckpoint && !toolCheckpointDelivered;
		const withToolCheckpoint = (content: ToolResultEvent["content"]): ToolResultEvent["content"] => {
			if (!toolCheckpointReached) return content;
			toolCheckpointDelivered = true;
			return appendNotice(content, TOOL_LOOP_GUIDANCE);
		};
		if (MUTATION_TOOLS.has(event.toolName) && !event.isError) {
			discoveryCalls = 0;
			checkpointDelivered = false;
			return toolCheckpointReached ? { content: withToolCheckpoint(event.content) } : undefined;
		}

		const fullText = textContent(event);
		if (!event.isError && DEDUPLICATED_TOOLS.has(event.toolName) && fullText.length >= DUPLICATE_MIN_CHARS) {
			const hash = createHash("sha256").update(fullText).digest("hex");
			const fingerprint = resultFingerprint(event);
			const priorByFingerprint = seenFingerprints.get(fingerprint);
			const prior = priorByFingerprint?.hash === hash ? priorByFingerprint : undefined;
			if (prior) {
				return {
					content: withToolCheckpoint([
						{
							type: "text",
							text: `[Duplicate ${event.toolName} result suppressed: identical content was already returned by tool call ${prior.toolCallId}. Reuse that earlier result; request only a missing range or narrower query.]`,
						},
					]),
				};
			}
			seenFingerprints.set(fingerprint, { hash, toolCallId: event.toolCallId });
		}

		const discoveryTool = !event.isError && BUDGETED_TOOLS.has(event.toolName);
		if (discoveryTool) discoveryCalls += 1;
		const checkpointAt = subagentSession
			? Math.min(configuredDiscoveryCheckpoint(), subagentDiscoveryCheckpoint())
			: configuredDiscoveryCheckpoint();
		const checkpointReached = discoveryTool && discoveryCalls >= checkpointAt;
		const maxChars = checkpointReached ? Math.min(configuredMaxChars(), TIGHT_MAX_CHARS) : configuredMaxChars();
		const textChars = event.content.reduce(
			(total, block) => total + (block.type === "text" ? block.text.length : 0),
			0,
		);
		if (textChars <= maxChars && (!checkpointReached || checkpointDelivered) && !toolCheckpointReached) return;

		const fullOutputPath = textChars > maxChars ? saveFullOutput(event, fullText, ctx) : undefined;
		const notices = [
			textChars > maxChars
				? `${discoveryTool ? "Discovery" : "Tool"} output truncated to reduce session tokens.${fullOutputPath ? ` Full output: ${fullOutputPath}` : ""} ${discoveryTool ? "Refine the query, path, or limit for omitted results." : "Inspect the saved output with a narrow search or range if omitted details are required."}`
				: undefined,
			checkpointReached ? DISCOVERY_GUIDANCE : undefined,
			toolCheckpointReached ? TOOL_LOOP_GUIDANCE : undefined,
		].filter((notice): notice is string => Boolean(notice));
		const notice = `\n\n[${notices.join(" ")}]`;
		if (checkpointReached) checkpointDelivered = true;
		if (toolCheckpointReached) toolCheckpointDelivered = true;
		if (textChars <= maxChars) {
			return {
				content: event.content.map((block, index) =>
					block.type === "text" && index === event.content.findIndex((candidate) => candidate.type === "text")
						? { ...block, text: `${block.text}${notice}` }
						: block,
				),
			};
		}

		let remaining = Math.max(0, maxChars - notice.length);
		let truncated = false;
		const content: ToolResultEvent["content"] = [];
		for (const block of event.content) {
			if (block.type !== "text") {
				content.push(block);
				continue;
			}
			if (remaining <= 0) continue;
			if (block.text.length <= remaining) {
				remaining -= block.text.length;
				content.push(block);
				continue;
			}
			if (truncated) continue;
			truncated = true;
			const text =
				event.isError || event.toolName === "bash"
					? truncateMiddleAtBoundary(block.text, remaining + notice.length, notice)
					: truncateAtBoundary(block.text, remaining + notice.length, notice);
			remaining = 0;
			content.push({ ...block, text });
		}
		return { content };
	});
}
