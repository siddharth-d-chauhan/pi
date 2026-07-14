/**
 * Agent lifecycle — "spawn once, converse forever".
 *
 * A subagent is a real AgentSession. After its spawn run finishes it does
 * NOT get thrown away:
 *
 *   running ──▶ idle ──(TTL)──▶ parked ──(message)──▶ revived (idle again)
 *
 * - idle: the child session stays alive in memory and can be messaged
 *   instantly (a delivery runs a real turn).
 * - parked: after `agents.idleTtlMs` the session is disposed but its JSONL
 *   stays on disk; a revive factory reopens it on demand. Sessions without
 *   a file (in-memory one-shots) skip parking and are disposed outright —
 *   their registry status becomes "completed" and they stop being
 *   addressable.
 * - Message delivery matrix (pi sessions ARE the mailboxes — nothing is
 *   buffered where it can be silently dropped):
 *     running → followUp() (non-interrupting; the session queues it)
 *     idle    → prompt()   (wakes a real turn; the reply is returned)
 *     parked  → revive, then prompt()
 *
 * This module is the single owner of post-run agent state. The registry
 * mirrors it for the UI (statuses idle/parked); tools and extensions go
 * through `deliverToAgent`/`reviveAgent`/`disposeAllAgents`.
 */

import type { AgentSession } from "../agent-session.ts";
import { getBackgroundProcessRegistry } from "../background-process-registry.ts";
import { enforceAgentRunBudget } from "./run-budget.ts";

export interface AgentLifecycleEntry {
	registryId: string;
	agentType: string;
	state: "running" | "idle" | "parked" | "disposed";
	session?: AgentSession;
	dispose?: () => void;
	sessionFile?: string;
	revive?: () => Promise<{ session: AgentSession; dispose: () => void }>;
	idleTtlMs: number;
	parkTimer?: ReturnType<typeof setTimeout>;
	/** True while a delivery-triggered turn is in flight. */
	busy: boolean;
	/** Messages queued while the agent was running/busy; drained on idle. */
	queue: Array<{
		wrapped: string;
		from: string;
		onReply?: (outcome: QueuedDeliveryOutcome) => Promise<void> | void;
	}>;
	/** In-flight revive, memoized so concurrent deliveries share one session. */
	reviving?: Promise<AgentSession | undefined>;
}

export type DeliveryReceipt =
	| { status: "queued" }
	| { status: "replied"; reply: string; usage?: { tokens: number; costUsd: number } }
	| { status: "failed"; reason: string };

export type QueuedDeliveryOutcome = { reply: string; usage: { tokens: number; costUsd: number } } | { failed: string };

/** Default idle TTL before an agent's session is parked to disk. */
export const DEFAULT_IDLE_TTL_MS = 420_000;

/** Turn cap for a single message delivery (prevents runaway revived agents). */
const DELIVERY_MAX_TURNS = 8;

const agents = new Map<string, AgentLifecycleEntry>();

/** Track a child from birth so running agents are deliverable too. */
export function registerRunningAgent(init: {
	registryId: string;
	agentType: string;
	session: AgentSession;
	dispose: () => void;
	sessionFile?: string;
	revive?: () => Promise<{ session: AgentSession; dispose: () => void }>;
	idleTtlMs?: number;
}): void {
	agents.set(init.registryId, {
		registryId: init.registryId,
		agentType: init.agentType,
		state: "running",
		session: init.session,
		dispose: init.dispose,
		sessionFile: init.sessionFile,
		revive: init.revive,
		idleTtlMs: init.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
		busy: false,
		queue: [],
	});
}

/** Register a cold (restart-survived) agent directly as parked. */
export function registerParkedAgent(init: {
	registryId: string;
	agentType: string;
	sessionFile: string;
	revive: () => Promise<{ session: AgentSession; dispose: () => void }>;
	idleTtlMs?: number;
}): void {
	if (agents.has(init.registryId)) return;
	agents.set(init.registryId, {
		registryId: init.registryId,
		agentType: init.agentType,
		state: "parked",
		sessionFile: init.sessionFile,
		revive: init.revive,
		idleTtlMs: init.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
		busy: false,
		queue: [],
	});
}

/**
 * The spawn run finished. Keep the session alive as `idle` and schedule
 * parking. Returns false when the agent was never registered (caller keeps
 * its own dispose responsibility).
 */
export function markAgentIdle(registryId: string): boolean {
	const entry = agents.get(registryId);
	if (!entry || !entry.session) return false;
	entry.state = "idle";
	getBackgroundProcessRegistry().setStatus(registryId, "idle");
	schedulePark(entry);
	if (entry.queue.length > 0) void drainQueue(entry);
	return true;
}

/** Deliver queued messages one at a time once the agent is idle. */
async function drainQueue(entry: AgentLifecycleEntry): Promise<void> {
	while (entry.queue.length > 0 && agents.get(entry.registryId) === entry && entry.state === "idle" && !entry.busy) {
		const next = entry.queue.shift();
		if (!next) return;
		const outcome = await runDeliveryTurn(entry, next.wrapped);
		if (next.onReply) {
			try {
				await next.onReply(outcome);
			} catch {
				// Notification failure must not block the remaining queue.
			}
		}
	}
}

/** The spawn run failed/was cancelled/killed: drop the session entirely. */
export function releaseAgent(registryId: string): void {
	const entry = agents.get(registryId);
	if (!entry) return;
	clearTimer(entry);
	entry.dispose?.();
	entry.session = undefined;
	entry.state = "disposed";
	agents.delete(registryId);
}

function clearTimer(entry: AgentLifecycleEntry): void {
	if (entry.parkTimer) {
		clearTimeout(entry.parkTimer);
		entry.parkTimer = undefined;
	}
}

function schedulePark(entry: AgentLifecycleEntry): void {
	clearTimer(entry);
	entry.parkTimer = setTimeout(() => {
		entry.parkTimer = undefined;
		if (entry.state !== "idle" || entry.busy) return;
		parkAgent(entry.registryId);
	}, entry.idleTtlMs);
	// Never keep a headless process alive just to park an agent.
	(entry.parkTimer as { unref?: () => void }).unref?.();
}

/** Dispose the live session; keep the entry revivable when a file exists. */
export function parkAgent(registryId: string): void {
	const entry = agents.get(registryId);
	if (!entry || entry.state !== "idle") return;
	if (entry.queue.length > 0) {
		// Never park over undelivered messages — drain and try again later.
		void drainQueue(entry);
		schedulePark(entry);
		return;
	}
	clearTimer(entry);
	entry.dispose?.();
	entry.session = undefined;
	entry.dispose = undefined;
	if (entry.sessionFile && entry.revive) {
		entry.state = "parked";
		getBackgroundProcessRegistry().setStatus(registryId, "parked");
	} else {
		entry.state = "disposed";
		agents.delete(registryId);
		getBackgroundProcessRegistry().setStatus(registryId, "completed");
	}
}

/** Reopen a parked agent's session. Idempotent for idle agents; concurrent
 * revives share one attempt, and a kill during revive disposes the freshly
 * opened session instead of resurrecting a zombie. */
export async function reviveAgent(registryId: string): Promise<AgentSession | undefined> {
	const entry = agents.get(registryId);
	if (!entry) return undefined;
	if (entry.state === "idle" || entry.state === "running") return entry.session;
	if (entry.state !== "parked" || !entry.revive) return undefined;
	entry.reviving ??= (async () => {
		const revived = await entry.revive!();
		if (agents.get(registryId) !== entry) {
			// Killed/disposed while reviving — tear the new session down.
			revived.dispose();
			return undefined;
		}
		entry.session = revived.session;
		entry.dispose = revived.dispose;
		entry.state = "idle";
		getBackgroundProcessRegistry().setStatus(registryId, "idle");
		schedulePark(entry);
		return revived.session;
	})().finally(() => {
		entry.reviving = undefined;
	});
	return entry.reviving;
}

export function getAgentLifecycle(registryId: string): AgentLifecycleEntry | undefined {
	return agents.get(registryId);
}

export function listLifecycleAgents(): AgentLifecycleEntry[] {
	return [...agents.values()];
}

/** Run one delivery turn against a live idle session. */
async function runDeliveryTurn(
	entry: AgentLifecycleEntry,
	wrapped: string,
): Promise<{ reply: string; usage: { tokens: number; costUsd: number } } | { failed: string }> {
	const registryId = entry.registryId;
	const session = entry.state === "parked" ? await reviveAgent(registryId) : entry.session;
	if (!session) return { failed: "Agent could not be revived." };

	clearTimer(entry);
	entry.busy = true;
	getBackgroundProcessRegistry().setStatus(registryId, "running");
	const statsBefore = session.getSessionStats();
	const disposeRunBudget = enforceAgentRunBudget(session, { maxTurns: DELIVERY_MAX_TURNS });
	try {
		await session.prompt(wrapped);
		const statsAfter = session.getSessionStats();
		return {
			reply: session.getLastAssistantText()?.trim() ?? "",
			usage: {
				tokens: Math.max(0, statsAfter.tokens.total - statsBefore.tokens.total),
				costUsd: Math.max(0, statsAfter.cost - statsBefore.cost),
			},
		};
	} catch (err) {
		return { failed: (err as Error).message };
	} finally {
		disposeRunBudget();
		entry.busy = false;
		// The entry may have been killed/disposed while the turn ran — never
		// resurrect its registry status or arm timers on a dead entry.
		if (agents.get(registryId) === entry) {
			if (entry.state === "idle" || entry.state === "parked") entry.state = "idle";
			getBackgroundProcessRegistry().setStatus(registryId, "idle");
			schedulePark(entry);
			if (entry.queue.length > 0) void drainQueue(entry);
		}
	}
}

/**
 * Deliver a message to an agent per the delivery matrix. `awaitReply`
 * (idle/parked targets only) runs the turn to completion and returns the
 * agent's reply text plus the tokens/cost the turn consumed.
 */
export async function deliverToAgent(
	registryId: string,
	message: string,
	opts: {
		from: string;
		awaitReply?: boolean;
		onQueuedReply?: (outcome: QueuedDeliveryOutcome) => Promise<void> | void;
	} = { from: "main" },
): Promise<DeliveryReceipt> {
	const entry = agents.get(registryId);
	if (!entry) return { status: "failed", reason: `No agent "${registryId}" (it may have been disposed).` };

	const wrapped = `<agent-message from="${opts.from}">\n${message}\n</agent-message>`;

	if (entry.state === "running" || entry.busy) {
		// Queued in the LIFECYCLE (not the session) so a park cannot drop it;
		// markAgentIdle / parkAgent drain this queue.
		entry.queue.push({ wrapped, from: opts.from, onReply: opts.onQueuedReply });
		return { status: "queued" };
	}

	const outcome = await runDeliveryTurn(entry, wrapped);
	if ("failed" in outcome) return { status: "failed", reason: outcome.failed };
	return opts.awaitReply ? { status: "replied", reply: outcome.reply, usage: outcome.usage } : { status: "queued" };
}

/** Kill/park sweep for parent shutdown. */
export function disposeAllAgents(): void {
	for (const entry of [...agents.values()]) {
		clearTimer(entry);
		entry.dispose?.();
		entry.session = undefined;
		entry.state = "disposed";
	}
	agents.clear();
}

/** Test helper. */
export function resetLifecycleForTests(): void {
	disposeAllAgents();
}
