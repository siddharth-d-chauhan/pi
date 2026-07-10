/**
 * Agent Progress Extension — a cheap, LLM-free rolling progress summary for
 * running subagents.
 *
 * The core spawn machinery seeds each subagent's `summary` with its prompt
 * and streams activity into the registry's log ring buffer (assistant text
 * lines and `↳ toolName` markers). This extension subscribes to the registry
 * and, for every RUNNING subagent/delegation, derives a concise one-line
 * summary from data already present — the latest meaningful log line plus a
 * tool-invocation count — and writes it back via `registry.update(id,
 * { summary })`. That summary then rides along on the snapshot shown by the
 * agent-hub roster and the agent-status footer.
 *
 * No LLM, no network. Updates are debounced (coalesced on a short timer) and
 * only written when the derived text actually changes, which also prevents a
 * feedback loop (registry.update emits an "update" event we listen to). We
 * only ever WRITE `summary` for running agents and never clear it, so we don't
 * fight agent-hub.ts / agent-status.ts, nor the core completion summary.
 */

import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	getBackgroundProcessRegistry,
	sanitizeLogLine,
} from "@earendil-works/pi-coding-agent";

const DEBOUNCE_MS = 400;
const MAX_SUMMARY_LEN = 72;
const TOOL_MARKER = "↳ ";

function isAgent(kind: BackgroundProcessSnapshot["kind"]): boolean {
	return kind === "subagent" || kind === "delegation";
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Derive a concise progress line from an entry's log, or undefined if there
 * is nothing meaningful yet (so we leave the core prompt-seeded summary
 * untouched). Cheap: a single reverse scan plus a marker count.
 */
function deriveSummary(log: readonly string[]): string | undefined {
	let latest: string | undefined;
	let toolCount = 0;
	for (const raw of log) {
		if (raw.startsWith(TOOL_MARKER)) toolCount++;
	}
	for (let i = log.length - 1; i >= 0; i--) {
		const line = sanitizeLogLine(log[i] ?? "");
		if (line.length === 0) continue;
		latest = line.startsWith(TOOL_MARKER) ? `${line.slice(TOOL_MARKER.length)}` : line;
		break;
	}
	if (latest === undefined) return undefined;
	const prefix = toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"} · ` : "";
	return truncate(`${prefix}${latest}`, MAX_SUMMARY_LEN);
}

export default function (pi: ExtensionAPI) {
	const registry = getBackgroundProcessRegistry();
	let unsubscribe: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const recompute = (): void => {
		timer = undefined;
		for (const snap of registry.list()) {
			if (!isAgent(snap.kind) || snap.status !== "running") continue;
			const entry = registry.get(snap.id);
			if (!entry) continue;
			const next = deriveSummary(entry.log);
			// Only write on a real change — this is the loop guard: our own
			// update() emits an event, but once summary == next it's a no-op.
			if (next !== undefined && next !== entry.summary) {
				registry.update(snap.id, { summary: next });
			}
		}
	};

	const schedule = (): void => {
		if (timer) return;
		timer = setTimeout(recompute, DEBOUNCE_MS);
	};

	const start = (): void => {
		if (unsubscribe) return;
		unsubscribe = registry.subscribe((event) => {
			// Cheaply filter to events that concern a subagent/delegation.
			if (event.type === "register") {
				if (isAgent(event.entry.kind)) schedule();
				return;
			}
			const entry = registry.get(event.id);
			if (entry && isAgent(entry.kind)) schedule();
		});
		schedule();
	};

	const stop = (): void => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		unsubscribe?.();
		unsubscribe = undefined;
	};

	pi.on("session_start", async () => {
		start();
	});
	pi.on("session_shutdown", async () => {
		stop();
	});
}
