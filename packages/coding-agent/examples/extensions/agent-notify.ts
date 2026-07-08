/**
 * Agent Notify Extension — desktop + in-TUI notification when a subagent
 * finishes.
 *
 * Background agents complete between turns; if you've tabbed away, nothing
 * tells you. This extension watches the core BackgroundProcessRegistry and,
 * when a subagent flips to completed/failed/cancelled, fires:
 *   - an in-TUI notice (ctx.ui.notify), and
 *   - a desktop notification (OSC 99 / OSC 777 / notify-send, via pi-tui).
 *
 * Pure observation — no core changes, no tools registered.
 */

import { type ExtensionAPI, formatTaskAge, getBackgroundProcessRegistry } from "@earendil-works/pi-coding-agent";
import { notify as desktopNotify } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	let unsubscribe: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		unsubscribe?.();
		const registry = getBackgroundProcessRegistry();
		unsubscribe = registry.subscribe((event) => {
			if (event.type !== "statusChange") return;
			if (event.status !== "completed" && event.status !== "failed" && event.status !== "cancelled") return;
			const entry = registry.get(event.id);
			if (!entry || entry.kind !== "subagent") return;

			const name = entry.agentType ?? "agent";
			const verb = event.status === "completed" ? "finished" : event.status;
			const body = `${name} ${verb} after ${formatTaskAge(entry)} — ${entry.label}`;
			ctx.ui.notify(body, event.status === "failed" ? "error" : "info");
			desktopNotify(`pi · ${name} ${verb}`, entry.label);
		});
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
}
