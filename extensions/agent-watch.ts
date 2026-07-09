/**
 * Agent Watch Extension — live re-announce when agent/chain/team
 * definitions change on disk.
 *
 * Definitions are re-read on every spawn, but the MODEL only knows the
 * roster from its tool descriptions (static per session). This extension
 * watches the definition directories and, on change, tells both sides:
 * a TUI notice for you, and a next-turn custom message for the model
 * (cache-stable: an appended message, never a tool-schema mutation).
 */

import { existsSync, type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const DEBOUNCE_MS = 750;

export default function (pi: ExtensionAPI) {
	const watchers: FSWatcher[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let changed = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		for (const watcher of watchers.splice(0)) watcher.close();
		const agentDir = getAgentDir();
		const dirs = [
			join(process.cwd(), ".pi", "agents"),
			join(process.cwd(), ".pi", "chains"),
			join(process.cwd(), ".pi", "teams"),
			join(agentDir, "agents"),
			join(agentDir, "chains"),
			join(agentDir, "teams"),
		];
		for (const dir of dirs) {
			if (!existsSync(dir)) continue;
			try {
				const watcher = watch(dir, (_eventType, filename) => {
					changed.add(join(dir, filename ?? ""));
					if (timer) clearTimeout(timer);
					timer = setTimeout(() => {
						timer = undefined;
						const files = [...changed];
						changed = new Set();
						const list = files.slice(0, 5).join(", ") + (files.length > 5 ? ` (+${files.length - 5} more)` : "");
						ctx.ui.notify(`Agent definitions changed: ${list}`, "info");
						pi.sendMessage(
							{
								customType: "roster-update",
								content:
									`Agent/chain/team definitions changed on disk: ${list}. ` +
									"They are re-read on the next spawn — available names may differ from your tool descriptions; " +
									"use agent_list (or the chain tool's error text) to see the current roster.",
								display: false,
							},
							{ deliverAs: "nextTurn" },
						);
					}, DEBOUNCE_MS);
				});
				watchers.push(watcher);
			} catch {
				// Watching is best-effort (some filesystems don't support it).
			}
		}
	});

	pi.on("session_shutdown", async () => {
		for (const watcher of watchers.splice(0)) watcher.close();
		if (timer) clearTimeout(timer);
	});
}
