/**
 * Roster Shortcuts Extension — Shift+Arrow quick-keys for the two rosters.
 *
 *   Shift+↑   open the Agent Hub   (same overlay as /agents, Ctrl+Alt+A)
 *   Shift+↓   open Background Tasks (same overlay as /bashes, Ctrl+Alt+B)
 *
 * This is a thin opener: it reuses the exact overlay components from
 * agent-hub.ts and background-tasks.ts (their `openHub`/`openOverlay`
 * functions are imported directly), so there is no duplicated overlay
 * logic and the two panels stay in lock-step with their canonical
 * commands. No core changes.
 *
 * Feasibility: shift+up / shift+down are expressible via Key.shift("up") /
 * Key.shift("down") and matchesKey() recognizes both the legacy CSI
 * sequences (\x1b[a / \x1b[b) and the Kitty CSI-u forms. Neither key is
 * bound by any built-in keybinding (see TUI_KEYBINDINGS / KEYBINDINGS) nor
 * reserved for extension conflicts, and extension shortcuts are checked
 * before the editor consumes input — so these bind cleanly from an
 * extension with no core edits.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { openHub } from "./agent-hub.ts";
import { openOverlay as openBackgroundTasks } from "./background-tasks.ts";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut(Key.shift("up"), {
		description: "Open the agent hub (roster, kill, steer)",
		handler: async (ctx: ExtensionContext) => {
			await openHub(ctx);
		},
	});
	pi.registerShortcut(Key.shift("down"), {
		description: "Open background tasks (shell commands)",
		handler: async (ctx: ExtensionContext) => {
			await openBackgroundTasks(ctx);
		},
	});
}
