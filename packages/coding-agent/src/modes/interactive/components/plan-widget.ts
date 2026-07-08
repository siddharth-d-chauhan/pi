/**
 * PlanWidget — a compact, persistent checklist of the model's task plan
 * (the `update_plan` tool). Intended to sit above the editor in interactive
 * mode; it renders zero lines while no plan exists, so it is safe to keep
 * mounted permanently.
 *
 * The widget subscribes to the plan store itself (see plan.ts) and reports
 * changes through the `onChange` callback so the owner can requestRender();
 * it never reaches into the TUI. `dispose()` unsubscribes.
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { formatTaskLine, getPlanState, onPlanChange, type PlanTask } from "../../../core/tools/plan.ts";
import { theme } from "../theme/theme.ts";

/** Show every task while the plan is at most this long; collapse completed tasks beyond it. */
const COLLAPSE_THRESHOLD = 6;

export interface PlanWidgetOptions {
	/** Called after the plan changes; the owner should call tui.requestRender(). */
	onChange?: () => void;
}

export class PlanWidget implements Component {
	private tasks: PlanTask[] | undefined;
	private unsubscribe: () => void;
	private opts: PlanWidgetOptions;

	constructor(opts: PlanWidgetOptions = {}) {
		this.opts = opts;
		this.tasks = getPlanState();
		this.unsubscribe = onPlanChange((tasks) => {
			this.tasks = tasks;
			this.opts.onChange?.();
		});
	}

	invalidate(): void {
		// No cached render state; theme is read live in render().
	}

	dispose(): void {
		this.unsubscribe();
	}

	render(width: number): string[] {
		const tasks = this.tasks;
		if (!tasks || tasks.length === 0 || width <= 0) {
			return [];
		}

		const lines: string[] = [];
		if (tasks.length > COLLAPSE_THRESHOLD) {
			const completedCount = tasks.filter((task) => task.status === "completed").length;
			if (completedCount > 0) {
				lines.push(theme.fg("dim", `☑ ${completedCount} completed`));
			}
			for (const task of tasks) {
				if (task.status !== "completed") {
					lines.push(formatTaskLine(task, theme));
				}
			}
		} else {
			for (const task of tasks) {
				lines.push(formatTaskLine(task, theme));
			}
		}
		return lines.map((line) => truncateToWidth(line, width));
	}
}
