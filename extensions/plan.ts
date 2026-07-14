/**
 * Plan Extension — the `update_plan` tool plus a live checklist widget.
 *
 * The model calls `update_plan` to maintain a task list for multi-step work;
 * the current plan renders as a persistent widget above the editor:
 *
 *   ☑ read the failing test
 *   ● fix the timeout handling
 *   ☐ run the suite
 *
 * Plan state derives from the session: on session start and branch
 * navigation the last successful update_plan result on the branch is
 * restored (so plans survive resume and clear on /new instead of leaking
 * across sessions).
 *
 * Everything lives at the extension layer: registerTool + ctx.ui.setWidget.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Schema & store
// ---------------------------------------------------------------------------

const planSchema = Type.Object({
	tasks: Type.Array(
		Type.Object({
			id: Type.String({ description: "Stable id; reuse across updates" }),
			subject: Type.String({ description: "Short imperative task" }),
			status: Type.Unsafe<"pending" | "in_progress" | "completed">({
				type: "string",
				enum: ["pending", "in_progress", "completed"],
			}),
		}),
		{ description: "Full task list; replaces the previous plan" },
	),
});

type PlanToolInput = Static<typeof planSchema>;
type PlanTaskStatus = "pending" | "in_progress" | "completed";

interface PlanTask {
	id: string;
	subject: string;
	status: PlanTaskStatus;
}

interface PlanToolDetails {
	tasks: PlanTask[];
	completedCount: number;
	totalCount: number;
}

let planTasks: PlanTask[] | undefined;
const listeners = new Set<(tasks: PlanTask[] | undefined) => void>();

function setPlanState(tasks: PlanTask[] | undefined): void {
	planTasks = tasks;
	for (const listener of listeners) listener(tasks?.map((task) => ({ ...task })));
}

function onPlanChange(listener: (tasks: PlanTask[] | undefined) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function validatePlan(tasks: PlanTask[]): void {
	const seenIds = new Set<string>();
	let inProgress = 0;
	for (const task of tasks) {
		if (task.subject.trim().length === 0) throw new Error(`Task '${task.id}' has an empty subject`);
		if (seenIds.has(task.id)) throw new Error(`Duplicate task id '${task.id}'. Task ids must be unique.`);
		seenIds.add(task.id);
		if (task.status === "in_progress") inProgress++;
	}
	if (inProgress > 1) {
		throw new Error(`${inProgress} tasks are in_progress. Mark at most one task in_progress at a time.`);
	}
}

// ---------------------------------------------------------------------------
// Rendering (shared by the tool result and the widget)
// ---------------------------------------------------------------------------

type ThemeLike = {
	fg(name: string, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
};

const STATUS_MARKER: Record<PlanTaskStatus, string> = {
	pending: "☐",
	in_progress: "●",
	completed: "☑",
};

function formatTaskLine(task: PlanTask, theme: ThemeLike): string {
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

/** Show every task while the plan is at most this long; collapse completed beyond it. */
const COLLAPSE_THRESHOLD = 6;
const RECONCILE_AFTER_MUTATIONS = 8;
const MAX_RECONCILE_NUDGES = 2;
const MUTATION_TOOLS = new Set(["apply_patch", "edit", "write"]);

function planLines(tasks: PlanTask[], theme: ThemeLike): string[] {
	const lines: string[] = [];
	if (tasks.length > COLLAPSE_THRESHOLD) {
		const completed = tasks.filter((task) => task.status === "completed").length;
		if (completed > 0) lines.push(theme.fg("dim", `☑ ${completed} completed`));
		for (const task of tasks) {
			if (task.status !== "completed") lines.push(formatTaskLine(task, theme));
		}
	} else {
		for (const task of tasks) lines.push(formatTaskLine(task, theme));
	}
	return lines;
}

class PlanWidget implements Component {
	private tasks: PlanTask[] | undefined;
	private readonly unsubscribe: () => void;
	private readonly theme: ThemeLike;

	constructor(tui: TUI, theme: ThemeLike) {
		this.theme = theme;
		this.tasks = planTasks?.map((task) => ({ ...task }));
		this.unsubscribe = onPlanChange((tasks) => {
			this.tasks = tasks;
			tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.tasks || this.tasks.length === 0 || width <= 0) return [];
		return planLines(this.tasks, this.theme).map((line) => truncateToWidth(line, width));
	}
}

// ---------------------------------------------------------------------------
// Session restore — the last successful update_plan result on the branch wins.
// ---------------------------------------------------------------------------

function restoreFromBranch(entries: Array<{ type: string; message?: unknown }>): void {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as
			| { role?: string; toolName?: string; isError?: boolean; details?: PlanToolDetails }
			| undefined;
		if (message?.role === "toolResult" && message.toolName === "update_plan" && !message.isError) {
			if (message.details?.tasks) {
				setPlanState(message.details.tasks.map((task) => ({ ...task })));
				return;
			}
		}
	}
	setPlanState(undefined);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let mutationsSincePlanUpdate = 0;
	let reconcileNudges = 0;
	const resetReconciliation = (): void => {
		mutationsSincePlanUpdate = 0;
		reconcileNudges = 0;
	};

	pi.registerTool({
		name: "update_plan",
		label: "plan",
		description:
			"Create/update your task plan (shown to the user as a live checklist). Use for multi-step work; " +
			"each call replaces the whole plan (reuse ids). Keep exactly one task in_progress and complete " +
			"tasks promptly. Skip for trivial single-step tasks.",
		parameters: planSchema,
		async execute(_toolCallId, { tasks }: PlanToolInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			validatePlan(tasks);
			const next = tasks.map((task) => ({ id: task.id, subject: task.subject, status: task.status }));
			setPlanState(next);
			resetReconciliation();
			const completedCount = next.filter((task) => task.status === "completed").length;
			const inProgress = next.find((task) => task.status === "in_progress");
			let text = next.length === 0 ? "Plan cleared" : `Plan updated: ${completedCount}/${next.length} completed`;
			if (inProgress) text += `; in progress: ${inProgress.subject}`;
			return {
				content: [{ type: "text", text }],
				details: { tasks: next, completedCount, totalCount: next.length },
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan"));
			const tasks = (args as PlanToolInput | undefined)?.tasks;
			if (tasks !== undefined) {
				const completed = tasks.filter((task) => task.status === "completed").length;
				text += theme.fg("toolOutput", ` (${completed}/${tasks.length} completed)`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, options, theme) {
			const details = result.details as PlanToolDetails | undefined;
			const tasks = details?.tasks;
			if (!tasks || tasks.length === 0) return new Text("", 0, 0);
			const maxLines = options.expanded ? tasks.length : 10;
			const lines = tasks.slice(0, maxLines).map((task) => formatTaskLine(task, theme));
			const remaining = tasks.length - maxLines;
			let text = `\n${lines.join("\n")}`;
			if (remaining > 0) text += `\n${theme.fg("muted", `... (${remaining} more tasks)`)}`;
			return new Text(text, 0, 0);
		},
	});

	const restore = (ctx: ExtensionContext): void => {
		restoreFromBranch(ctx.sessionManager.getBranch());
	};

	pi.on("session_start", async (_event, ctx) => {
		resetReconciliation();
		restore(ctx);
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("plan", (tui, theme) => new PlanWidget(tui, theme));
	});
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("agent_start", async () => resetReconciliation());
	pi.on("tool_result", async (event) => {
		if (event.toolName === "update_plan") {
			resetReconciliation();
			return;
		}
		if (!event.isError && MUTATION_TOOLS.has(event.toolName)) mutationsSincePlanUpdate += 1;
	});
	pi.on("context", async (event) => {
		if (
			mutationsSincePlanUpdate < RECONCILE_AFTER_MUTATIONS ||
			reconcileNudges >= MAX_RECONCILE_NUDGES ||
			!planTasks?.some((task) => task.status !== "completed")
		) {
			return;
		}
		mutationsSincePlanUpdate = 0;
		reconcileNudges += 1;
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: "Plan checkpoint: implementation has advanced since the checklist was last touched. Reconcile update_plan with verified reality before doing more broad work; do not mark untested work completed.",
						},
					],
					timestamp: Date.now(),
				},
			],
		};
	});
}
