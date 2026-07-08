import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const planSchema = Type.Object({
	tasks: Type.Array(
		Type.Object({
			id: Type.String({
				description: "Stable task identifier (e.g. '1' or a short slug). Reuse ids across updates.",
			}),
			subject: Type.String({ description: "Short imperative description of the task" }),
			status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
				description: "Current task status",
			}),
		}),
		{ description: "The full task list. Replaces the previous plan entirely." },
	),
});

export type PlanToolInput = Static<typeof planSchema>;

export type PlanTaskStatus = "pending" | "in_progress" | "completed";

export interface PlanTask {
	id: string;
	subject: string;
	status: PlanTaskStatus;
}

export interface PlanToolDetails {
	tasks: PlanTask[];
	completedCount: number;
	totalCount: number;
}

// ============================================================================
// Session-scoped plan store
//
// Tools receive no session handle, and other per-session UI state in this
// package (e.g. background-process-registry.ts) is likewise process-global:
// interactive mode runs a single active session per process. The store is
// module-level with a subscribe API so the UI can observe updates without
// coupling to the agent event system.
// ============================================================================

let planTasks: PlanTask[] | undefined;
const planListeners = new Set<(tasks: PlanTask[] | undefined) => void>();

/** Current plan, or undefined if there is no active plan. */
export function getPlanState(): PlanTask[] | undefined {
	return planTasks?.map((task) => ({ ...task }));
}

/** Subscribe to plan updates (undefined = plan cleared). Returns an unsubscribe function. */
export function onPlanChange(listener: (tasks: PlanTask[] | undefined) => void): () => void {
	planListeners.add(listener);
	return () => planListeners.delete(listener);
}

function setPlanState(tasks: PlanTask[] | undefined): void {
	planTasks = tasks;
	for (const listener of planListeners) {
		listener(tasks?.map((task) => ({ ...task })));
	}
}

/** Clear the plan (no-op when there is none). */
export function resetPlanState(): void {
	if (planTasks === undefined) return;
	setPlanState(undefined);
}

/**
 * Derive plan state from a session's messages: the last successful
 * update_plan result on the branch wins; none clears the plan. The store is
 * process-global while sessions come and go, so interactive mode calls this
 * whenever the active session or branch changes — the checklist follows the
 * conversation (and survives resume) instead of leaking across sessions.
 */
export function restorePlanFromMessages(messages: AgentMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "toolResult" && message.toolName === "update_plan" && !message.isError) {
			const details = message.details as PlanToolDetails | undefined;
			if (details?.tasks) {
				setPlanState(details.tasks.map((task) => ({ ...task })));
				return;
			}
		}
	}
	resetPlanState();
}

function validatePlan(tasks: PlanTask[]): void {
	const seenIds = new Set<string>();
	let inProgressCount = 0;
	for (const task of tasks) {
		if (task.subject.trim().length === 0) {
			throw new Error(`Task '${task.id}' has an empty subject`);
		}
		if (seenIds.has(task.id)) {
			throw new Error(`Duplicate task id '${task.id}'. Task ids must be unique.`);
		}
		seenIds.add(task.id);
		if (task.status === "in_progress") {
			inProgressCount++;
		}
	}
	if (inProgressCount > 1) {
		throw new Error(`${inProgressCount} tasks are in_progress. Mark at most one task in_progress at a time.`);
	}
}

const STATUS_MARKER: Record<PlanTaskStatus, string> = {
	pending: "☐",
	in_progress: "▶",
	completed: "☑",
};

/** Shared checklist-line renderer, also used by the interactive PlanWidget. */
export function formatTaskLine(task: PlanTask, theme: Theme): string {
	const marker = STATUS_MARKER[task.status];
	switch (task.status) {
		case "completed":
			return theme.fg("dim", `${marker} ${theme.strikethrough(task.subject)}`);
		case "in_progress":
			return theme.fg("accent", `${marker} ${theme.bold(task.subject)}`);
		default:
			return theme.fg("dim", `${marker} `) + theme.fg("toolOutput", task.subject);
	}
}

function formatPlanCall(args: PlanToolInput | undefined, theme: Theme): string {
	let text = theme.fg("toolTitle", theme.bold("plan"));
	const tasks = args?.tasks;
	if (tasks !== undefined) {
		const completed = tasks.filter((task) => task.status === "completed").length;
		text += theme.fg("toolOutput", ` (${completed}/${tasks.length} completed)`);
	}
	return text;
}

function formatPlanResult(
	result: AgentToolResult<PlanToolDetails | undefined>,
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const tasks = result.details?.tasks;
	if (!tasks || tasks.length === 0) {
		return "";
	}
	const maxLines = options.expanded ? tasks.length : 10;
	const lines = tasks.slice(0, maxLines).map((task) => formatTaskLine(task, theme));
	const remaining = tasks.length - maxLines;
	let text = `\n${lines.join("\n")}`;
	if (remaining > 0) {
		text += `\n${theme.fg("muted", `... (${remaining} more tasks)`)}`;
	}
	return text;
}

export function createPlanToolDefinition(_cwd: string): ToolDefinition<typeof planSchema, PlanToolDetails> {
	return {
		name: "update_plan",
		label: "plan",
		description: [
			"Create or update your task plan for the current work. The plan is shown to the user as a live checklist.",
			"Use this for any multi-step work (3+ distinct steps, multiple files, or non-trivial refactors): create the plan up front, then keep statuses current as you work.",
			"Each call replaces the entire plan, so always send the full task list. Reuse task ids across calls; ids must be unique and subjects non-empty.",
			"Mark exactly one task in_progress while you work on it, and mark tasks completed promptly when done — do not batch completions until the end.",
			"Skip this tool for trivial single-step tasks.",
		].join(" "),
		promptSnippet: "Track a task plan for multi-step work",
		parameters: planSchema,
		async execute(_toolCallId, { tasks }: PlanToolInput, signal?: AbortSignal) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			validatePlan(tasks);
			const nextTasks = tasks.map((task) => ({ id: task.id, subject: task.subject, status: task.status }));
			setPlanState(nextTasks);
			const completedCount = nextTasks.filter((task) => task.status === "completed").length;
			const totalCount = nextTasks.length;
			const inProgress = nextTasks.find((task) => task.status === "in_progress");
			let text = totalCount === 0 ? "Plan cleared" : `Plan updated: ${completedCount}/${totalCount} completed`;
			if (inProgress) {
				text += `; in progress: ${inProgress.subject}`;
			}
			return {
				content: [{ type: "text", text }],
				details: { tasks: nextTasks, completedCount, totalCount },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatPlanCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatPlanResult(result, options, theme));
			return text;
		},
	};
}

export function createPlanTool(cwd: string): AgentTool<typeof planSchema> {
	return wrapToolDefinition(createPlanToolDefinition(cwd));
}
