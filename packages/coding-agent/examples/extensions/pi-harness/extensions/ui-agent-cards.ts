/**
 * ui-agent-cards.ts — rich bordered task cards for subagent/delegate runs (oh-my-pi swarm look).
 *
 * A delegated subagent used to surface as a plain notify line. This renders it as the omp-style
 * task card: a header (task id + one-line intent), a body (live status · req · tokens · cost, then
 * the yielded result), and a settled-summary tree ("✔ 1 job settled 1 done └─ …"). Purely a
 * display module — delegate.ts feeds it via the shared functions below; the model's context is
 * never touched.
 *
 * Shared singleton (import-shared), so delegate (and chains) can call agentStart/agentUpdate/
 * agentEnd and this module owns the rendering + the setWidget calls.
 *
 * Config: KP_UI_AGENT_CARDS_ENABLED=0 disable.
 */

const ENABLED = process.env.KP_UI_AGENT_CARDS_ENABLED !== "0";

export type AgentCard = {
	id: string; // task id (e.g. "HiPing2")
	kind: string; // agent kind / type ("task", "review", "sonic"…)
	intent: string; // one-line description
	state: "running" | "done" | "failed";
	reqs: number; // model requests so far
	tokensK: number; // tokens used (in millions-fraction, shown as %/1M like omp) — we store raw
	costUsd: number; // $ so far
	result: string; // final yield / error
	startedAt: number;
	endedAt?: number;
};

// Shared on globalThis: pi loads delegate.ts (writer) and ui-agent-cards' hooks with SEPARATE jiti
// module instances (moduleCache:false), so plain module-level Maps would diverge. globalThis makes
// delegate's agentStart/Update and the UI's render see the ONE set of cards. (Same reason as
// process-registry.)
const G = globalThis as any;
G.__kpAgentCards ??= {
	cards: new Map<string, AgentCard>(),
	procs: new Map<string, { kill: () => void }>(),
};
const _s = G.__kpAgentCards;
const cards: Map<string, AgentCard> = _s.cards;
const procs: Map<string, { kill: () => void }> = _s.procs;
let ui: any = null; // captured setWidget + setStatus ctx (per-instance, rebound from hooks)

// UI methods live on ctx.ui (ExtensionUIContext), not on ctx directly. Accept either a raw ctx
// (capture its .ui) or an already-unwrapped ui object, so callers can't get the path wrong.
export function bindUi(ctx: any): void {
	const u = ctx?.ui?.setWidget ? ctx.ui : ctx?.setWidget ? ctx : null;
	if (u) ui = u;
}

// Register a killable handle for a running agent so it can be stopped mid-flight (Claude Code
// parity). delegate passes its child proc; /stop-agents (or stopAgent) calls kill().
export function registerProc(id: string, handle: { kill: () => void }): void {
	procs.set(id, handle);
}
export function stopAgent(id: string): boolean {
	const h = procs.get(id);
	if (!h) return false;
	try {
		h.kill();
	} catch {}
	procs.delete(id);
	agentEnd(id, "failed", "[stopped by user]");
	return true;
}
export function stopAllAgents(): number {
	let n = 0;
	for (const [id, h] of procs) {
		try {
			h.kill();
			n++;
		} catch {}
		agentEnd(id, "failed", "[stopped by user]");
	}
	procs.clear();
	return n;
}
export function runningAgents(): string[] {
	return [...cards.values()].filter((c) => c.state === "running").map((c) => c.id);
}

// Status-bar segment: how many subagents are running (like Claude Code's bg-task indicator).
function refreshStatus(): void {
	if (!ui?.setStatus) return;
	const running = [...cards.values()].filter((c) => c.state === "running").length;
	try {
		ui.setStatus("kp-agents", running ? `🤖 ${running} agent${running === 1 ? "" : "s"}` : undefined);
	} catch {}
}

export function agentStart(id: string, kind: string, intent: string): void {
	cards.set(id, {
		id,
		kind,
		intent,
		state: "running",
		reqs: 0,
		tokensK: 0,
		costUsd: 0,
		result: "",
		startedAt: Date.now(),
	});
	render();
	refreshStatus();
}
export function agentUpdate(id: string, patch: Partial<AgentCard>): void {
	const c = cards.get(id);
	if (!c) return;
	Object.assign(c, patch);
	render();
}
export function agentEnd(id: string, state: "done" | "failed", result: string): void {
	const c = cards.get(id);
	if (!c) return;
	c.state = state;
	c.result = result;
	c.endedAt = Date.now();
	procs.delete(id);
	render();
	refreshStatus();
}
export function clearAgentCards(): void {
	cards.clear();
	procs.clear();
	try {
		ui?.setWidget?.("kp-agent-cards", undefined);
	} catch {}
	try {
		ui?.setStatus?.("kp-agents", undefined);
	} catch {}
}

const glyph = (s: string) => (s === "done" ? "✔" : s === "failed" ? "✘" : "•");
const dur = (c: AgentCard) => `${(((c.endedAt ?? Date.now()) - c.startedAt) / 1000).toFixed(1)}s`;

// Render ALL active cards as one widget (box per task + a settled-summary tree if any finished).
function render(): void {
	if (!ui?.setWidget) return;
	const all = [...cards.values()];
	if (!all.length) {
		try {
			ui.setWidget("kp-agent-cards", undefined);
		} catch {}
		return;
	}
	const lines: string[] = [];

	for (const c of all) {
		// header + body card, omp-style. Metrics differ for running (req/tokens) vs settled (dur).
		const metrics =
			c.state === "running"
				? `${c.reqs} req · ${c.tokensK ? `${c.tokensK.toFixed(1)}k tok` : "…"}${c.costUsd ? ` · $${c.costUsd.toFixed(2)}` : ""}`
				: `${dur(c)}${c.costUsd ? ` · $${c.costUsd.toFixed(2)}` : ""}`;
		const head = `${glyph(c.state)} Task ${c.id} · ${c.kind}`;
		const intent = c.intent.replace(/\s+/g, " ").slice(0, 92);
		const bodyLine = `${glyph(c.state)} ${metrics}`;
		const resultLine = c.result ? c.result.replace(/\s+/g, " ").slice(0, 92) : "";
		// inner width fits the widest content row, so borders align.
		const inner = Math.max(head.length + 4, intent.length, bodyLine.length, resultLine.length, 40);
		const pad = (s: string) => `│ ${s.padEnd(inner)} │`;
		lines.push(`╭─ ${head} ${"─".repeat(Math.max(1, inner - head.length - 1))}╮`);
		lines.push(pad(intent));
		lines.push(`├${"─".repeat(inner + 2)}┤`);
		lines.push(pad(bodyLine));
		if (resultLine) lines.push(pad(`  ${resultLine}`));
		lines.push(`╰${"─".repeat(inner + 2)}╯`);
	}

	// settled summary tree (like "⚠ 1 job settled 1 failed └─ …")
	const settled = all.filter((c) => c.state !== "running");
	if (settled.length) {
		const done = settled.filter((c) => c.state === "done").length;
		const failed = settled.length - done;
		const icon = failed ? "⚠" : "✔";
		lines.push("");
		lines.push(
			`${icon} ${settled.length} job${settled.length === 1 ? "" : "s"} settled · ${done} done${failed ? ` · ${failed} failed` : ""}`,
		);
		for (const c of settled) {
			lines.push(`└─ ${glyph(c.state)} ⟦${c.kind}⟧ ${c.id} ${dur(c)}`);
			if (c.result) lines.push(`     ${c.result.replace(/\s+/g, " ").slice(0, 88)}`);
		}
	}
	try {
		ui.setWidget("kp-agent-cards", lines, { placement: "aboveEditor" });
	} catch {}
}

export default function (pi: any) {
	if (!ENABLED) return;
	const grab = (_e: any, ctx: any) => bindUi(ctx);
	pi.on("session_start", grab);
	pi.on("turn_start", grab);
	// Clear cards when the user starts a fresh turn — UNLESS agents are still running (don't wipe a
	// live subagent's card just because the user typed; only clear once nothing is running).
	pi.on("input", async () => {
		if (!runningAgents().length) clearAgentCards();
	});

	// /agents — list running subagents (Claude Code parity: see what's running in the background).
	pi.registerCommand?.("agents", {
		description: "List running subagents (delegated tasks) + stop them",
		handler: async (args: string, ctx: any) => {
			bindUi(ctx);
			const a = (args || "").trim();
			if (a === "stop" || a.startsWith("stop ")) {
				const target = a.replace(/^stop\s*/, "").trim();
				const n = target ? (stopAgent(target) ? 1 : 0) : stopAllAgents();
				ctx.ui.notify(
					n ? `⊘ stopped ${n} agent${n === 1 ? "" : "s"}` : `no ${target || "running"} agent to stop`,
					"info",
				);
				return;
			}
			const running = runningAgents();
			ctx.ui.notify(
				running.length
					? `Running subagents (${running.length}):\n${running.map((id) => `  🤖 ${id}`).join("\n")}\n(/agents stop [id] to stop)`
					: "No subagents running.",
				"info",
			);
		},
	});
	// Kill any still-running subagents on shutdown so they don't outlive the session.
	pi.on("session_shutdown", async () => {
		stopAllAgents();
	});
}
