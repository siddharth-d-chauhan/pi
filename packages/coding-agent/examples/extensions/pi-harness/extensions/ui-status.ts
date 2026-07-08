/**
 * ui-status.ts — live working indicator + a persistent status line (oh-my-pi-inspired UI).
 *
 * pi's UI extension API exposes setWorkingMessage/setWorkingIndicator (the streaming loader) and
 * setStatus (the footer), but nothing used them for turn-level feedback. This fills that: while the
 * agent generates, the loader shows WHAT IT'S DOING — the current tool + its target + elapsed time —
 * instead of a blank spinner. And a persistent status segment shows model · context% · cache-hit ·
 * turn count, updated from the provider's real usage each turn.
 *
 * Everything is UI-only (setWorkingMessage/setStatus). No prompt tokens, no context — pure display.
 *
 * Config: KP_UI_STATUS_ENABLED=0 disable.
 */

const ENABLED = process.env.KP_UI_STATUS_ENABLED !== "0";

const _fmt = (n: number | null | undefined): string =>
	n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// A friendly one-liner for what a given tool call is doing, from its args.
function describeTool(name: string, input: any): string {
	const s = (v: any) =>
		String(v ?? "")
			.replace(/\s+/g, " ")
			.slice(0, 48);
	switch (true) {
		case name === "bash":
			return `running: ${s(input?.command)}`;
		case /^(hread|read)$/.test(name):
			return `reading ${s(input?.path)}`;
		case /^(hedit|edit|write)$/.test(name):
			return `editing ${s(input?.path)}`;
		case /^(grep|rg|find|glob|ls)$/.test(name):
			return `searching ${s(input?.pattern || input?.query || input?.path)}`;
		case name.startsWith("knowledge_"):
			return `${name.replace("knowledge_", "brain: ")} ${s(input?.query || input?.question || input?.kind || "")}`;
		case name.startsWith("browser_"):
			return `browser ${name.replace("browser_", "")} ${s(input?.url || input?.selector || "")}`;
		case name.startsWith("bg_"):
			return `bg ${name.replace("bg_", "")} ${s(input?.command || input?.id || "")}`;
		case name === "delegate":
			return `delegating ${s(input?.kind || input?.task)}`;
		case name === "todo_write":
			return `updating the checklist`;
		default:
			return `${name} ${s(input?.query || input?.path || input?.command || "")}`.trim();
	}
}

export default function (pi: any) {
	if (!ENABLED) return;

	let uiCtx: any = null;
	let turnStart = 0;
	let turns = 0;
	let elapsedTimer: any = null;
	let currentAction = "";
	// last provider usage → the status line
	const lastUsage: { pct?: number; hitPct?: number; model?: string } = {};

	const grab = (_e: any, ctx: any) => {
		if (ctx?.ui?.setWorkingMessage || ctx?.ui?.setStatus) uiCtx = ctx.ui;
	};
	pi.on("session_start", grab);
	pi.on("turn_start", grab);

	// Persistent status line: model · context% · cache-hit · turns. Rebuilt when usage changes.
	function refreshStatus(): void {
		if (!uiCtx?.setStatus) return;
		const parts: string[] = [];
		if (lastUsage.model) parts.push(lastUsage.model);
		if (lastUsage.pct != null) {
			const p = lastUsage.pct;
			const dot = p >= 85 ? "🔴" : p >= 60 ? "🟡" : "🟢";
			parts.push(`${dot} ctx ${p.toFixed(0)}%`);
		}
		if (lastUsage.hitPct != null) parts.push(`cache ${lastUsage.hitPct}%`);
		if (turns) parts.push(`turn ${turns}`);
		try {
			uiCtx.setStatus("kp-ui", parts.length ? parts.join(" · ") : undefined);
		} catch {}
	}

	// Live working message: "⚙ <action> · <elapsed>s". Ticks the elapsed time while generating.
	function setWorking(action: string): void {
		currentAction = action;
		if (!uiCtx?.setWorkingMessage) return;
		const tick = () => {
			const secs = turnStart ? ((Date.now() - turnStart) / 1000).toFixed(1) : "0";
			try {
				uiCtx.setWorkingMessage(`⚙ ${currentAction} · ${secs}s`);
			} catch {}
		};
		tick();
		if (!elapsedTimer) elapsedTimer = setInterval(tick, 500);
	}
	function stopWorking(): void {
		if (elapsedTimer) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
		try {
			uiCtx?.setWorkingMessage?.();
		} catch {} // restore default
	}

	pi.on("turn_start", async (_e: any, ctx: any) => {
		if (ctx?.ui?.setWorkingMessage) uiCtx = ctx.ui;
		turnStart = Date.now();
		turns++;
		setWorking("thinking…");
		refreshStatus();
	});

	// As each tool fires, update the loader to name the live action.
	pi.on("tool_call", async (event: any) => {
		setWorking(describeTool(event?.toolName || "", event?.input));
	});

	// RICH in-progress detail: a tool that streams progress (bg output, browser step, delegate
	// stage, an import's running count) emits tool_execution_update with a partialResult. Surface
	// it live so a long tool shows movement, not a frozen label. We take the last line of any text
	// in the partial as the progress hint.
	pi.on("tool_execution_update", async (event: any) => {
		try {
			const p = event?.partialResult;
			const txt =
				typeof p === "string"
					? p
					: Array.isArray(p?.content)
						? (p.content.find((b: any) => b?.type === "text")?.text ?? "")
						: p?.progress || p?.status || "";
			const hint = String(txt).trim().split("\n").filter(Boolean).pop();
			if (hint) setWorking(`${describeTool(event?.toolName || "", event?.args)} — ${hint.slice(0, 40)}`);
		} catch {}
	});

	// Between tools (back to the model), show generating.
	pi.on("tool_result", async () => {
		setWorking("thinking…");
	});

	// On each model message, pull the real usage → status line.
	pi.on("message_end", async (event: any) => {
		try {
			const u = event?.message?.usage;
			const model = event?.message?.model || event?.model;
			if (model) lastUsage.model = String(model).split("/").pop()?.slice(0, 22);
			if (u) {
				const prompt = (u.input ?? 0) + (u.cacheRead ?? 0);
				if (u.contextWindow || u.percent != null)
					lastUsage.pct = u.percent ?? (prompt / (u.contextWindow || 200000)) * 100;
				if (prompt) lastUsage.hitPct = Math.round(((u.cacheRead ?? 0) / prompt) * 100);
			}
			refreshStatus();
		} catch {}
	});

	pi.on("turn_end", async () => {
		stopWorking();
		refreshStatus();
	});
	pi.on("agent_end", async () => {
		stopWorking();
	});
	pi.on("session_shutdown", async () => {
		stopWorking();
		try {
			uiCtx?.setStatus?.("kp-ui", undefined);
		} catch {}
	});
}
