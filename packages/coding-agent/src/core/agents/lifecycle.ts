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
}

export type DeliveryReceipt =
	| { status: "queued" }
	| { status: "replied"; reply: string }
	| { status: "failed"; reason: string };

/** Default idle TTL before an agent's session is parked to disk. */
export const DEFAULT_IDLE_TTL_MS = 420_000;

/** Turn cap for a single message delivery (prevents runaway revived agents). */
const DELIVERY_MAX_TURNS = 20;

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
	return true;
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

/** Reopen a parked agent's session. Idempotent for idle agents. */
export async function reviveAgent(registryId: string): Promise<AgentSession | undefined> {
	const entry = agents.get(registryId);
	if (!entry) return undefined;
	if (entry.state === "idle" || entry.state === "running") return entry.session;
	if (entry.state !== "parked" || !entry.revive) return undefined;
	const revived = await entry.revive();
	entry.session = revived.session;
	entry.dispose = revived.dispose;
	entry.state = "idle";
	getBackgroundProcessRegistry().setStatus(registryId, "idle");
	schedulePark(entry);
	return revived.session;
}

export function getAgentLifecycle(registryId: string): AgentLifecycleEntry | undefined {
	return agents.get(registryId);
}

export function listLifecycleAgents(): AgentLifecycleEntry[] {
	return [...agents.values()];
}

/**
 * Deliver a message to an agent per the delivery matrix. `awaitReply`
 * (idle/parked targets only) runs the turn to completion and returns the
 * agent's reply text.
 */
export async function deliverToAgent(
	registryId: string,
	message: string,
	opts: { from: string; awaitReply?: boolean } = { from: "main" },
): Promise<DeliveryReceipt> {
	const entry = agents.get(registryId);
	if (!entry) return { status: "failed", reason: `No agent "${registryId}" (it may have been disposed).` };

	const wrapped = `<agent-message from="${opts.from}">\n${message}\n</agent-message>`;

	if (entry.state === "running" || entry.busy) {
		const session = entry.session;
		if (!session) return { status: "failed", reason: "Agent is transitioning; retry shortly." };
		void session.followUp(wrapped);
		return { status: "queued" };
	}

	const session = entry.state === "parked" ? await reviveAgent(registryId) : entry.session;
	if (!session) return { status: "failed", reason: "Agent could not be revived." };

	clearTimer(entry);
	entry.busy = true;
	getBackgroundProcessRegistry().setStatus(registryId, "running");
	let turns = 0;
	const turnUnsub = session.subscribe((event) => {
		if (event.type !== "turn_end") return;
		turns += 1;
		if (turns === DELIVERY_MAX_TURNS) {
			void session.steer("Budget notice: wrap up now and return your final answer.");
		} else if (turns > DELIVERY_MAX_TURNS) {
			session.abort();
		}
	});
	try {
		await session.prompt(wrapped);
		const reply = session.getLastAssistantText()?.trim() ?? "";
		return opts.awaitReply ? { status: "replied", reply } : { status: "queued" };
	} catch (err) {
		return { status: "failed", reason: (err as Error).message };
	} finally {
		turnUnsub();
		entry.busy = false;
		if (entry.state === "idle" || entry.state === "parked") {
			entry.state = "idle";
		}
		getBackgroundProcessRegistry().setStatus(registryId, "idle");
		schedulePark(entry);
	}
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
