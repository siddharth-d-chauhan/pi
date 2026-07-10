/**
 * Rollout flags for the Knowledge Platform broker integration (PR-11 scaffold).
 *
 * These mirror the KP-side `Settings` flags (context_broker_v2, packet_version,
 * broker_deadlines, …) and the CR-side `CONTEXT_RAG_BROKER_V2`, so the pi side
 * can be staged through the same off → shadow → on rollout.
 *
 * Scaffolding only: the defaults preserve today's behaviour and nothing flips
 * until the broker wiring reads these. `/context` surfaces them so rollout state
 * is observable at a glance.
 */

/** V2 broker packet path on the pi side. Default OFF (V1 behaviour). */
export const PI_KP_BROKER_V2 = process.env.PI_KP_BROKER_V2 === "1";

/** Whether automatic learning (auto-learn briefing/nudge) is active. Default ON. */
export const PI_KP_AUTO_LEARN = process.env.PI_KP_AUTO_LEARN !== "0";

/** Snapshot of the pi-side rollout flags, for `/context` and diagnostics. */
export function rolloutFlags(): Record<string, boolean> {
	return { PI_KP_BROKER_V2, PI_KP_AUTO_LEARN };
}
