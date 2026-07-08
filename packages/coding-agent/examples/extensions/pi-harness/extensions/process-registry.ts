/**
 * process-registry.ts — one shared registry of everything running in the background, so a single
 * /logs command can list bg jobs AND subagents and open the live output of any of them.
 *
 * background.ts (bg jobs) and delegate/ui-agent-cards (subagents) each register their runnables
 * here with an id, a kind, a live state, and a way to fetch current output. The /logs command
 * (in ui-logs.ts) enumerates this registry, shows a picker, and streams the selected one's output.
 *
 * Import-shared singleton — no I/O, no context. Pure coordination.
 */

export type RunEntry = {
	id: string;
	kind: "bg" | "agent";
	label: string; // what it's running (command / task intent)
	state: () => "running" | "done" | "failed" | "killed";
	output: () => string; // current full captured output
	kill?: () => void; // stop it (if supported)
};

// CRITICAL: pi loads each extension with its OWN jiti instance and moduleCache:false, so a plain
// module-level `const entries = new Map()` would give background.ts and ui-logs.ts SEPARATE copies
// (background registers into its copy, ui-logs reads an empty one → "nothing running"). Back the
// state on globalThis so ALL extensions share the ONE registry across their separate module graphs.
const G = globalThis as any;
G.__kpProcRegistry ??= { entries: new Map<string, RunEntry>(), listeners: new Set<() => void>() };
const store = G.__kpProcRegistry;
const entries: Map<string, RunEntry> = store.entries;
const listeners: Set<() => void> = store.listeners;

/** Subscribe to registry changes (job registered/removed/state-poll) so the UI can refresh its
 * hint the instant a job starts — not only on the next turn hook. Returns an unsubscribe. */
export function onChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
function fire(): void {
	for (const fn of listeners) {
		try {
			fn();
		} catch {}
	}
}

export function register(e: RunEntry): void {
	entries.set(`${e.kind}:${e.id}`, e);
	fire();
}
export function unregister(kind: string, id: string): void {
	entries.delete(`${kind}:${id}`);
	fire();
}
/** Call after a state change (job finished) so subscribers refresh. */
export function touched(): void {
	fire();
}
export function all(): RunEntry[] {
	return [...entries.values()];
}
export function running(): RunEntry[] {
	return all().filter((e) => e.state() === "running");
}
export function get(key: string): RunEntry | undefined {
	return entries.get(key) || all().find((e) => e.id === key);
}
