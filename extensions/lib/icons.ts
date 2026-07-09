/**
 * Tiered icon set for the production extensions.
 *
 *   unicode (default) — safe everywhere, no font requirements
 *   nerd              — Nerd Font glyphs (needs a patched terminal font)
 *   emoji             — universally supported, loud
 *
 * Mode persists in <agentDir>/icons.json; the /icons command (icons.ts
 * extension) toggles it live. Pure module state — extensions share the
 * core module graph, so one setIconMode() call updates every card.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type IconMode = "unicode" | "nerd" | "emoji";

export type IconName =
	| "branch"
	| "commit"
	| "team"
	| "chain"
	| "agent"
	| "model"
	| "memory"
	| "speed"
	| "running"
	| "idle"
	| "ok"
	| "fail"
	| "cancelled"
	| "skipped"
	| "money"
	| "tools";

const SETS: Record<IconMode, Record<IconName, string>> = {
	unicode: {
		branch: "⎇",
		commit: "●",
		team: "⛭",
		chain: "⛓",
		agent: "●",
		model: "◆",
		memory: "▤",
		speed: "⚡",
		running: "▶",
		idle: "◌",
		ok: "✓",
		fail: "✗",
		cancelled: "⊘",
		skipped: "–",
		money: "$",
		tools: "⚒",
	},
	nerd: {
		branch: "", //  powerline branch
		commit: "", //  git commit
		team: "", //  users
		chain: "", //  link
		agent: "", //  robot
		model: "", //  cogs
		memory: "", //  database
		speed: "", //  bolt
		running: "", //  play
		idle: "", //  circle-o
		ok: "", //  check
		fail: "", //  times
		cancelled: "", //  ban
		skipped: "", //  minus
		money: "", //  dollar
		tools: "", //  wrench
	},
	emoji: {
		branch: "🌿",
		commit: "🔸",
		team: "👥",
		chain: "⛓️",
		agent: "🤖",
		model: "🧠",
		memory: "💾",
		speed: "⚡",
		running: "▶️",
		idle: "💤",
		ok: "✅",
		fail: "❌",
		cancelled: "🚫",
		skipped: "➖",
		money: "💰",
		tools: "🔧",
	},
};

// lib/ modules load once PER EXTENSION (separate module graphs), so plain
// module state would fracture: the /icons toggle would only update its own
// copy. globalThis is the shared channel across all extension graphs.
interface IconState {
	mode?: IconMode;
	listeners: Set<() => void>;
}
const GLOBAL_KEY = "__pi_icon_state__";
const globalStore = globalThis as Record<string, unknown>;
if (!globalStore[GLOBAL_KEY]) {
	globalStore[GLOBAL_KEY] = { mode: undefined, listeners: new Set() } satisfies IconState;
}
const state = globalStore[GLOBAL_KEY] as IconState;

function stateFile(): string {
	return join(getAgentDir(), "icons.json");
}

export function getIconMode(): IconMode {
	if (state.mode) return state.mode;
	try {
		const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { mode?: string };
		state.mode = saved.mode === "nerd" || saved.mode === "emoji" ? saved.mode : "unicode";
	} catch {
		state.mode = "unicode";
	}
	return state.mode;
}

export function setIconMode(next: IconMode): void {
	state.mode = next;
	try {
		writeFileSync(stateFile(), `${JSON.stringify({ mode: next })}\n`);
	} catch {
		// persistence is best-effort
	}
	for (const listener of state.listeners) listener();
}

/** Subscribe to icon-mode changes (widgets re-render on toggle). */
export function onIconModeChange(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

export function icon(name: IconName): string {
	return SETS[getIconMode()][name];
}
