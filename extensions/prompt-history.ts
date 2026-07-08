/**
 * Prompt History Extension — shell-style persistent prompt history.
 *
 * pi's editor already supports Up/Down prompt recall within a session
 * (100-entry in-memory buffer). This extension makes it persistent and
 * global: every prompt you submit is appended to
 * `~/.pi/agent/prompt-history.json`, and each new session seeds the
 * editor's history from that file — so Up on a fresh prompt walks back
 * through your last 100 prompts across ALL sessions and projects.
 *
 * Slash commands and bash (`!`) lines are stored too, exactly like shell
 * history. Consecutive duplicates are collapsed.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const MAX_ENTRIES = 100;

function historyFile(): string {
	return join(getAgentDir(), "prompt-history.json");
}

/** Oldest → newest, capped. */
function loadHistory(): string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(historyFile(), "utf8"));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === "string").slice(-MAX_ENTRIES);
	} catch {
		return [];
	}
}

function saveHistory(entries: string[]): void {
	const file = historyFile();
	const tmp = `${file}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(entries.slice(-MAX_ENTRIES), null, "\t")}\n`);
		renameSync(tmp, file);
	} catch {
		// History is best-effort; never break input handling over it.
	}
}

export default function (pi: ExtensionAPI) {
	let history = loadHistory();

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		// Seed BEFORE any prompts this session: oldest → newest so the most
		// recent prompt is the first Up-arrow recall. The editor dedupes
		// consecutive entries itself.
		history = loadHistory();
		ctx.ui.addEditorHistory(history);
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive") return;
		const text = event.text.trim();
		if (!text) return;
		if (history.at(-1) === text) return;
		history.push(text);
		if (history.length > MAX_ENTRIES) history = history.slice(-MAX_ENTRIES);
		saveHistory(history);
	});
}
