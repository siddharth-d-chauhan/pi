/**
 * BackgroundProcessRegistry — in-process registry of backgrounded work.
 *
 * A single shared instance lives for the lifetime of the agent session. The
 * editor's down-arrow handler consults `list()` and, when non-empty, opens
 * a log panel. Subagent and parallel-tool implementations register
 * themselves here so the user has one place to peek at in-flight work.
 *
 * Design constraints:
 *  - Each entry holds a bounded ring buffer of recent log lines (default
 *    500). The buffer is the source of truth for the log panel; the
 *    underlying proc may keep its own log, but the panel renders from here.
 *  - Subscribers are notified on every mutation (register, unregister,
 *    appendLog, statusChange). The TUI re-renders on notification.
 *  - The registry is intentionally minimal — it stores state, it does not
 *    render. The panel component (in `modes/interactive/components/`) is
 *    the renderer.
 *
 * Subagents and future parallel-tool/MCP work plug in by calling
 * `register()`.
 */

export type BackgroundProcessKind = "subagent" | "delegation" | "mcp" | "shell" | "shell-suspend" | "other";
export type BackgroundProcessStatus = "running" | "idle" | "parked" | "completed" | "failed" | "cancelled";

export interface BackgroundProcessMetrics {
	tokens?: number;
	/** Non-cache traffic: input + output + cache writes. */
	freshTokens?: number;
	cacheReadTokens?: number;
	costUsd?: number;
	requests?: number;
	contextPct?: number;
}

export interface BackgroundProcess {
	id: string;
	kind: BackgroundProcessKind;
	label: string;
	/** Free-form details; the panel renders this above the log. */
	summary?: string;
	status: BackgroundProcessStatus;
	startedAt: number;
	endedAt?: number;
	metrics?: BackgroundProcessMetrics;
	agentType?: string;
	sessionFile?: string;
	resultHandle?: string;
	parentId?: string;
	/** Explicit question waiting for a user/parent reply. */
	inputRequest?: string;
	/** Grouping key for the UI (e.g. a chain name groups its stage agents). */
	group?: string;
	onKill?: () => void;
	onSteer?: (text: string) => void;
}

export interface BackgroundProcessEntry extends BackgroundProcess {
	/** Bounded ring buffer of log lines. Most recent line is the last. */
	log: string[];
}

export interface BackgroundProcessSnapshot {
	id: string;
	kind: BackgroundProcessKind;
	label: string;
	summary?: string;
	status: BackgroundProcessStatus;
	startedAt: number;
	endedAt?: number;
	metrics?: BackgroundProcessMetrics;
	agentType?: string;
	sessionFile?: string;
	resultHandle?: string;
	parentId?: string;
	inputRequest?: string;
	group?: string;
	canKill: boolean;
	canSteer: boolean;
	/** Current size of the log buffer. */
	logSize: number;
	/** Tail of the log (most recent N lines), for preview. */
	logTail: string[];
}

export type BackgroundProcessEvent =
	| { type: "register"; entry: BackgroundProcessEntry }
	| { type: "unregister"; id: string }
	| { type: "appendLog"; id: string; lines: string[] }
	| { type: "update"; id: string }
	| { type: "statusChange"; id: string; status: BackgroundProcessStatus };

export type BackgroundProcessListener = (event: BackgroundProcessEvent) => void;

/** Default cap on log lines retained per process. */
export const DEFAULT_LOG_CAP = 500;

/**
 * Make a raw log line safe to embed in a rendered TUI row: drop CSI/OSC
 * escape sequences and map remaining control characters (\r, \t, \b, …)
 * to spaces so they can't move the cursor or skew width math.
 */
export function sanitizeLogLine(line: string): string {
	return line
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b./g, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim();
}

class BackgroundProcessRegistry {
	#entries = new Map<string, BackgroundProcessEntry>();
	#listeners = new Set<BackgroundProcessListener>();
	#idCounter = 0;
	#logCap: number;

	constructor(logCap: number = DEFAULT_LOG_CAP) {
		this.#logCap = logCap;
	}

	/** Total registered processes. */
	get size(): number {
		return this.#entries.size;
	}

	/**
	 * Allocate a fresh id. Exposed for callers that want a stable id before
	 * `register` (rare — usually just call `register` with no id).
	 */
	nextId(): string {
		this.#idCounter++;
		return `bg-${Date.now().toString(36)}-${this.#idCounter}`;
	}

	/**
	 * Register a new process. Returns the assigned id. If `init.id` is
	 * provided and unique, it is used; otherwise a fresh id is allocated.
	 * Throws if `init.id` collides.
	 */
	register(
		init: Omit<BackgroundProcess, "id" | "startedAt" | "status"> & { id?: string; status?: BackgroundProcessStatus },
	): string {
		const id = init.id ?? this.nextId();
		if (this.#entries.has(id)) throw new Error(`BackgroundProcessRegistry: duplicate id "${id}"`);
		const entry: BackgroundProcessEntry = {
			id,
			kind: init.kind,
			label: init.label,
			summary: init.summary,
			status: init.status ?? "running",
			startedAt: Date.now(),
			metrics: init.metrics,
			agentType: init.agentType,
			sessionFile: init.sessionFile,
			resultHandle: init.resultHandle,
			parentId: init.parentId,
			inputRequest: init.inputRequest,
			group: init.group,
			onKill: init.onKill,
			onSteer: init.onSteer,
			log: [],
		};
		this.#entries.set(id, entry);
		this.#emit({ type: "register", entry });
		return id;
	}

	update(
		id: string,
		patch: Partial<Pick<BackgroundProcess, "metrics" | "sessionFile" | "resultHandle" | "summary" | "inputRequest">>,
	): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		if ("metrics" in patch) entry.metrics = patch.metrics;
		if ("sessionFile" in patch) entry.sessionFile = patch.sessionFile;
		if ("resultHandle" in patch) entry.resultHandle = patch.resultHandle;
		if ("summary" in patch) entry.summary = patch.summary;
		if ("inputRequest" in patch) entry.inputRequest = patch.inputRequest;
		this.#emit({ type: "update", id });
	}

	kill(id: string): boolean {
		const entry = this.#entries.get(id);
		if (!entry?.onKill) return false;
		entry.onKill();
		return true;
	}

	steer(id: string, text: string): boolean {
		const entry = this.#entries.get(id);
		if (!entry?.onSteer) return false;
		entry.onSteer(text);
		return true;
	}

	/** Remove a process. Idempotent — returns true if it was present. */
	unregister(id: string): boolean {
		const had = this.#entries.delete(id);
		if (had) this.#emit({ type: "unregister", id });
		return had;
	}

	/**
	 * Append one or more log lines to a process. Lines longer than the cap
	 * are kept whole (no truncation); only the OLDEST lines are evicted
	 * when the buffer would exceed the cap. No-op if `id` is unknown.
	 */
	appendLog(id: string, lines: string | string[]): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		const arr = Array.isArray(lines) ? lines : [lines];
		if (arr.length === 0) return;
		// Evict from the front until we have room.
		const overflow = entry.log.length + arr.length - this.#logCap;
		if (overflow > 0) entry.log.splice(0, overflow);
		entry.log.push(...arr);
		this.#emit({ type: "appendLog", id, lines: arr });
	}

	/** Update the process status. */
	setStatus(id: string, status: BackgroundProcessStatus): void {
		const entry = this.#entries.get(id);
		if (!entry || entry.status === status) return;
		entry.status = status;
		if (status !== "running" && status !== "idle") entry.endedAt = Date.now();
		this.#emit({ type: "statusChange", id, status });
	}

	/** Read a snapshot of one entry. Returns undefined if not found. */
	get(id: string): BackgroundProcessEntry | undefined {
		return this.#entries.get(id);
	}

	/**
	 * List snapshots for all registered processes, most-recent first.
	 * Cheap to call; does not copy log buffers.
	 */
	list(): BackgroundProcessSnapshot[] {
		const out: BackgroundProcessSnapshot[] = [];
		for (const e of this.#entries.values()) {
			out.push({
				id: e.id,
				kind: e.kind,
				label: e.label,
				summary: e.summary,
				status: e.status,
				startedAt: e.startedAt,
				endedAt: e.endedAt,
				metrics: e.metrics,
				agentType: e.agentType,
				sessionFile: e.sessionFile,
				resultHandle: e.resultHandle,
				parentId: e.parentId,
				inputRequest: e.inputRequest,
				group: e.group,
				canKill: e.onKill !== undefined,
				canSteer: e.onSteer !== undefined,
				logSize: e.log.length,
				logTail: e.log.slice(-5),
			});
		}
		out.sort((a, b) => b.startedAt - a.startedAt);
		return out;
	}

	/**
	 * Register a task and return a self-contained handle for it — the shape
	 * handed to extensions via `ExtensionAPI.registerBackgroundTask`. The
	 * handle closes over this instance, so it works regardless of the
	 * caller's module graph.
	 */
	createTaskHandle(init: { kind?: BackgroundProcessKind; label: string; summary?: string }): BackgroundTaskHandle {
		const id = this.register({ kind: init.kind ?? "other", label: init.label, summary: init.summary });
		return {
			id,
			log: (lines) => this.appendLog(id, lines),
			setStatus: (status) => this.setStatus(id, status),
			unregister: () => this.unregister(id),
		};
	}

	/** Subscribe to all registry events. Returns an unsubscribe fn. */
	subscribe(listener: BackgroundProcessListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(event: BackgroundProcessEvent): void {
		for (const l of this.#listeners) {
			try {
				l(event);
			} catch {
				// A failing listener must not poison the registry or other listeners.
			}
		}
	}
}

/** Human-compact age of a task: "312ms", "42s", "5m", "2h13m". */
export function formatTaskAge(snapshot: Pick<BackgroundProcessSnapshot, "startedAt" | "endedAt">): string {
	const end = snapshot.endedAt ?? Date.now();
	const ms = Math.max(0, end - snapshot.startedAt);
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Handle returned by `ExtensionAPI.registerBackgroundTask` (created via
 * `BackgroundProcessRegistry.createTaskHandle`). Extensions must use the API
 * rather than importing this module: each extension loads in its own jiti
 * module graph, so an import would create a second, empty registry. Callers
 * own their task's lifecycle — mark it completed/failed (or unregister it)
 * when the work ends, or it stays listed as running.
 */
export interface BackgroundTaskHandle {
	readonly id: string;
	/** Append log lines shown in the status widget preview and log panel. */
	log(lines: string | string[]): void;
	setStatus(status: BackgroundProcessStatus): void;
	/** Remove the task from the UI entirely. */
	unregister(): void;
}

/**
 * Module-level singleton. Lazily created on first access so importing this
 * file alone does no work. Tests can call `resetForTests()` to discard.
 */
let singleton: BackgroundProcessRegistry | undefined;

export function getBackgroundProcessRegistry(): BackgroundProcessRegistry {
	if (!singleton) singleton = new BackgroundProcessRegistry();
	return singleton;
}

export function resetForTests(): void {
	singleton = undefined;
}
