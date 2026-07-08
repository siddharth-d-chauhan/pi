/**
 * context-lcm.ts — bounded context via the vendored LCM engine (M2).
 *
 * Wires harness-core's pristine hermes-lcm DAG compressor into pi's `context`
 * hook through a Python sidecar (sidecar/lcm_sidecar.py). Each turn, if the
 * conversation is over threshold, cold/superseded spans are evicted and
 * summarized into DAG nodes; the model keeps recent + pinned messages plus
 * compact summaries, and recovers detail on demand via lcm_grep / lcm_expand.
 *
 * Losslessness: pi's session JSONL is never touched — the `context` event hands
 * us a deep copy, so eviction is per-request only. Full history lives in both
 * pi's JSONL and LCM's own lcm.db.
 *
 * Fail-open: any sidecar error (down, timeout, bad reply) → return the original
 * messages unchanged. Never break a turn to save tokens.
 *
 * Aux summaries: the sidecar forwards summarization via aux_request; we run it
 * on a low-cost model so DAG summaries are readable without burning frontier
 * tokens. The aux model is SELECTABLE (/lcm-aux) and defaults to pi's currently
 * configured session model — so switching pi's provider switches aux too, and
 * you can pin a cheaper one when you want. Runs via `codex exec` on the
 * subscription. Config:
 *   KP_LCM_ENABLED=0        disable entirely
 *   KP_LCM_PYTHON           python3.11+ interpreter (default: python3.11)
 *   KP_LCM_THRESHOLD_FRAC   compress when tokens exceed this fraction (0.75)
 *   KP_LCM_AUX_MODEL        pin the aux model id (default: gpt-5.3-codex-spark, cheapest)
 *   KP_LCM_AUX=0            disable LLM summaries (lossless non-LLM eviction only)
 *
 * Robustness (oh-my-pi compaction hardening — see notes at each site):
 *   KP_LCM_FAILSAFE=0       disable the model-free overflow ladder (default on)
 *   KP_LCM_OVERFLOW_FRAC    true-overflow trip point as a fraction of the window
 *                           (default 0.95) — above this we mechanically evict even
 *                           if the sidecar/aux is unreachable, so a turn NEVER dies
 *                           from an over-window summarizer that can't itself run.
 *   KP_LCM_PROMOTE_MODEL    same-provider larger-window model to try before any
 *                           mechanical drop when truly overflowing (optional).
 *   KP_LCM_PROTECT_RECENT   protect-recent token window never evicted (default 24000).
 *   KP_LCM_MIN_SAVINGS      don't churn the cache for a compaction that saves fewer
 *                           than this many tokens (default 20000).
 *   KP_LCM_CACHE_TTL_MS     idle window after which in-place blanking is cache-safe
 *                           (default 300000 = 5min; suffix-small check also applies).
 *   KP_LCM_PRESERVE_TAGS    comma list of content markers force-preserved from
 *                           eviction (default: active DLC scope/plan + firing rules).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = resolve(HERE, "..", "sidecar", "lcm_sidecar.py");
const PYTHON = process.env.KP_LCM_PYTHON || "python3.11";
const ENABLED = process.env.KP_LCM_ENABLED !== "0";
const THRESHOLD_FRAC = Number(process.env.KP_LCM_THRESHOLD_FRAC || 0.75);
const AUX_ENABLED = process.env.KP_LCM_AUX !== "0";
const ROUGH_CHARS_PER_TOKEN = 4;

// ── Robustness knobs (oh-my-pi compaction hardening) ─────────────────────────
const FAILSAFE_ENABLED = process.env.KP_LCM_FAILSAFE !== "0";
const OVERFLOW_FRAC = Number(process.env.KP_LCM_OVERFLOW_FRAC || 0.95);
const PROMOTE_MODEL = process.env.KP_LCM_PROMOTE_MODEL || "";
const PROTECT_RECENT_TOKENS = Number(process.env.KP_LCM_PROTECT_RECENT || 24_000);
const MIN_SAVINGS_TOKENS = Number(process.env.KP_LCM_MIN_SAVINGS || 20_000);
const _CACHE_TTL_MS = Number(process.env.KP_LCM_CACHE_TTL_MS || 300_000);
// Content markers that must survive eviction: the active DLC scope/plan and any
// firing rule are load-bearing state the model needs to keep working. pi writes
// these as bracket-tagged text ([rule], [scope], [plan], [DLC], preserved-*).
const PRESERVE_TAGS = (
	process.env.KP_LCM_PRESERVE_TAGS ||
	"[rule],[scope],[plan],[dlc],active task list was preserved,current user objective preserved"
)
	.split(",")
	.map((s) => s.trim().toLowerCase())
	.filter(Boolean);

// A message is force-preserved if its flattened text carries a preserve marker.
function isPreserved(text: string): boolean {
	const t = (text || "").toLowerCase();
	return PRESERVE_TAGS.some((tag) => t.includes(tag));
}

// Map a pi model id to what `codex exec -m` accepts. pi's openai-codex ids pass
// through; anything else (e.g. a Claude id) falls back to a known cheap codex tier.
function toCodexModel(piModel: string): string {
	if (/^gpt-/.test(piModel)) return piModel;
	return "gpt-5.4-mini";
}

// Build a minimal env for the aux `codex exec` child: PATH (resolve `codex`), HOME (~/.codex auth),
// and any explicit provider keys the user set. Otherwise we spawn-inherit process.env, which can
// grow large enough to hit ARG_MAX (E2BIG) and crash the summarizer.
function auxChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const k of ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL"]) {
		const v = process.env[k];
		if (v != null) env[k] = v;
	}
	for (const k of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "CODEX_HOME", "CODEX_CONFIG"]) {
		const v = process.env[k];
		if (v) env[k] = v;
	}
	return env;
}

/** Run one summary via `codex exec` on the subscription. Fail-open → null.
 *  Uses --output-last-message so we get exactly the final text, no frame parsing. */
function auxSummarize(prompt: string, model: string): Promise<string | null> {
	// The prompt can be huge after compaction — passing it as a CLI arg blows past
	// ARG_MAX (E2BIG). `codex exec` reads instructions from stdin when no positional
	// PROMPT is given, so we pipe via stdin and keep argv small.
	const instruction =
		"Summarize the following conversation span concisely and losslessly; " +
		"preserve decisions, facts, file names, and open threads:\n\n" +
		prompt;
	return new Promise((res) => {
		const outFile = join(tmpdir(), `lcm-aux-${process.pid}-${Date.now()}.txt`);
		const child = spawn(
			"codex",
			["exec", "-m", toCodexModel(model), "--skip-git-repo-check", "--output-last-message", outFile],
			// Curated env: inheriting all of process.env can blow ARG_MAX (E2BIG) once the parent
			// session has accumulated a large env (many provider keys, MCP state, etc.). Codex reads
			// its auth from ~/.codex/, so PATH+HOME is enough for the subscription path; we forward
			// any explicit provider keys the user has set so an OPENAI_API_KEY override still works.
			{ stdio: ["pipe", "ignore", "ignore"], cwd: tmpdir(), env: auxChildEnv() },
		);
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
		}, 90_000);
		child.once("error", (e) => {
			clearTimeout(timer);
			res(null);
			console.error("[lcm] aux spawn failed:", e?.message || e);
		});
		child.once("close", () => {
			clearTimeout(timer);
			let text: string | null = null;
			try {
				text = readFileSync(outFile, "utf-8").trim() || null;
			} catch (e) {
				console.error("[lcm] aux read failed:", (e as Error)?.message || e);
			} finally {
				rmSync(outFile, { force: true });
			}
			res(text);
		});
		// EPIPE if the child exits before consuming all stdin is harmless; stdin.end() below.
		child.stdin.on("error", () => {});
		child.stdin.end(instruction);
	});
}

export default function (pi: any) {
	if (!ENABLED) return;

	let proc: ChildProcessWithoutNullStreams | null = null;
	let rl: ReturnType<typeof createInterface> | null = null;
	let seq = 0;
	const pending = new Map<number, (v: any) => void>();
	let contextLength = 200_000;
	// Persisted user default — survives sessions (unlike a bare /lcm-aux override).
	// Precedence: env pin (KP_LCM_AUX_MODEL) > saved default > pi's session model > cheap fallback.
	const AUX_CFG = join(homedir(), ".pi", "agent", "pi-harness", "lcm-aux.json");
	function loadDefaultAux(): string {
		try {
			if (existsSync(AUX_CFG)) return String(JSON.parse(readFileSync(AUX_CFG, "utf-8"))?.model || "");
		} catch {}
		return "";
	}
	function saveDefaultAux(model: string): void {
		try {
			mkdirSync(dirname(AUX_CFG), { recursive: true });
			writeFileSync(AUX_CFG, `${JSON.stringify({ model }, null, 2)}\n`);
		} catch {}
	}
	// Aux model: env pin > saved default > pi's session model > cheap fallback. Resolved at
	// session_start, overridable live via /lcm-aux.
	let auxModel = process.env.KP_LCM_AUX_MODEL || loadDefaultAux();
	// Observability so "is it working" is a one-command check.
	const stats = {
		turnEvictions: 0,
		compactions: 0,
		lastCompactBefore: 0,
		lastCompactAfter: 0,
		auxCalls: 0,
		cacheReuses: 0,
		mechanicalEvicts: 0,
		promotions: 0,
		minSavingsSkips: 0,
	};
	// Wall-clock of the last time we saw a turn — used to decide whether an in-place
	// rewrite is cache-safe (a session idle past the provider's cache TTL has already
	// lost its cached prefix, so re-writing it costs nothing).
	let lastActivityAt = Date.now();
	// Cache discipline: the transport (Agent SDK / codex) caches the prefix and
	// charges cached reads at ~10% of input. Re-writing the message list every
	// turn busts that cache and re-bills the whole tail at full price. So we make
	// per-turn eviction STABLE: only re-compress after REEVICT_EVERY new messages,
	// and between those points return the SAME rewrite (byte-identical prefix →
	// cache stays warm). Batch eviction at the boundary is the one place the model
	// already expects a cache reset.
	const REEVICT_EVERY = Number(process.env.KP_LCM_REEVICT_EVERY || 12);
	let lastEvictAtLen = 0; // message count when we last actually compressed
	let lastEvictResult: any[] | null = null; // the rewrite to reuse until the next boundary

	function ensureProc(_sessionId: string): boolean {
		if (proc) return true;
		try {
			proc = spawn(PYTHON, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			return false;
		}
		proc.on("error", () => {
			proc = null;
		});
		proc.on("exit", () => {
			proc = null;
			rl = null;
		});
		proc.stderr.on("data", () => {}); // keep the pipe drained; logs go nowhere noisy
		rl = createInterface({ input: proc.stdout });
		rl.on("line", (line) => {
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (msg.aux_request) {
				// Sidecar wants a summary — run it on the selected aux model.
				void (async () => {
					stats.auxCalls++;
					const content = await auxSummarize(msg.aux_request.prompt, auxModel);
					proc?.stdin.write(`${JSON.stringify({ aux_response: { seq: msg.aux_request.seq, content } })}\n`);
				})();
				return;
			}
			if (msg.id != null && pending.has(msg.id)) {
				pending.get(msg.id)!(msg);
				pending.delete(msg.id);
			}
		});
		return true;
	}

	function call(method: string, params: any = {}, timeoutMs = 120_000): Promise<any> {
		return new Promise((res) => {
			if (!proc) return res({ error: "no sidecar" });
			const id = ++seq;
			const timer = setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					res({ error: "timeout" });
				}
			}, timeoutMs);
			pending.set(id, (v) => {
				clearTimeout(timer);
				res(v);
			});
			proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	// Flatten pi's block content to a plain string LCM understands; keep role.
	function toLcm(messages: any[]): any[] {
		return messages.map((m) => ({
			role: m.role,
			content: Array.isArray(m.content)
				? m.content
						.map((b: any) =>
							b.type === "text"
								? b.text
								: b.type === "toolCall"
									? `[tool_call ${b.name} ${JSON.stringify(b.arguments ?? {})}]`
									: b.type === "thinking"
										? ""
										: `[${b.type}]`,
						)
						.filter(Boolean)
						.join("\n")
				: String(m.content ?? ""),
			_orig: m, // keep the original for pass-through of unchanged messages
		}));
	}

	// Rehydrate: unchanged messages keep their rich original; summary/new messages
	// become plain text blocks.
	function _fromLcm(out: any[]): any[] {
		return out.map((m) =>
			m._orig ? m._orig : { role: m.role, content: [{ type: "text", text: String(m.content ?? "") }] },
		);
	}

	function roughTokens(messages: any[]): number {
		let chars = 0;
		for (const m of messages) chars += JSON.stringify(m.content ?? "").length;
		return Math.ceil(chars / ROUGH_CHARS_PER_TOKEN);
	}

	// ── PAIR-INTEGRITY (rank 8) ────────────────────────────────────────────────
	// A tool_use (assistant `toolCall` block) and its tool_result (a message with
	// role:"toolResult" carrying the same toolCallId) must NEVER be split across an
	// eviction boundary — orphaning either half makes the provider reject replay.
	//
	// The sidecar engine has its own pair guardrail, but it keys off structured
	// `tool_calls` / `tool_call_id` fields, which our wire flattening (toLcm →
	// {role, content:string}) erases — so we cannot rely on it across this seam.
	// We therefore enforce pairing HERE, on pi's native message objects, before
	// ever handing a slice to the sidecar or a mechanical evictor.

	// Collect the toolCallId of every assistant toolCall block in a message.
	function callIdsOf(m: any): string[] {
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			return m.content
				.filter((b: any) => b?.type === "toolCall")
				.map((b: any) => String(b.toolCallId ?? b.id ?? ""))
				.filter(Boolean);
		}
		return [];
	}
	// The toolCallId a toolResult message answers.
	function resultIdOf(m: any): string | null {
		if (m?.role === "toolResult") return String(m.toolCallId ?? m.id ?? "") || null;
		return null;
	}

	// Given a proposed cut index (keep messages[cut..]), pull it EARLIER so no kept
	// toolResult is orphaned from its evicted toolCall. i.e. if the kept region
	// opens with (or contains, reachable from the boundary) a toolResult whose call
	// sits in the evicted head, move the cut back to include that call. Also pull
	// trailing metadata (a lone toolResult with no matching call ahead) into the
	// kept region rather than stranding it. Returns an adjusted cut index.
	function safeCutIndex(messages: any[], cut: number): number {
		if (cut <= 0 || cut >= messages.length) return cut;
		// Map every toolCallId to the index of the message that ISSUED the call.
		const callAt = new Map<string, number>();
		for (let i = 0; i < messages.length; i++)
			for (const id of callIdsOf(messages[i])) if (!callAt.has(id)) callAt.set(id, i);
		let c = cut;
		// Walk the kept region; for any toolResult whose call is in the evicted head,
		// drag the cut back to keep the call. Iterate to a fixpoint (dragging back can
		// expose earlier results whose calls are earlier still).
		let changed = true;
		while (changed) {
			changed = false;
			for (let i = c; i < messages.length; i++) {
				const rid = resultIdOf(messages[i]);
				if (rid && callAt.has(rid) && callAt.get(rid)! < c) {
					c = callAt.get(rid)!;
					changed = true;
					break;
				}
			}
		}
		return c;
	}

	// Audit: true iff every toolResult in `messages` has its matching toolCall
	// present in the same list (no orphan). Used to fail-open a bad sidecar reply.
	function pairsIntact(messages: any[]): boolean {
		const calls = new Set<string>();
		for (const m of messages) for (const id of callIdsOf(m)) calls.add(id);
		for (const m of messages) {
			const rid = resultIdOf(m);
			if (rid && !calls.has(rid)) return false;
		}
		return true;
	}

	function msgTokens(m: any): number {
		return Math.ceil(JSON.stringify(m.content ?? "").length / ROUGH_CHARS_PER_TOKEN);
	}

	// ── MODEL-FREE OVERFLOW LADDER (rank 7) ────────────────────────────────────
	// The normal path summarizes evicted spans via the aux/codex model. But when we
	// are ALREADY over the window, that model call can itself fail (its own request
	// won't fit / times out) — the exact case where we most need to shed tokens.
	// So on TRUE overflow we drop to a purely MECHANICAL evictor: no model call,
	// no sidecar dependency. Keep the recent protect-window, keep anything pinned
	// (preserve markers), keep pairs whole; drop the oldest cold messages until we
	// are back under a safe target. Deterministic, always terminates, never throws.
	function mechanicalEvict(messages: any[], targetTokens: number): any[] {
		const n = messages.length;
		if (n < 8) return messages;
		// 1) Protected set: force-kept regardless of age.
		const keep = new Array<boolean>(n).fill(false);
		// Protect-recent: keep the newest messages up to PROTECT_RECENT_TOKENS.
		let recentBudget = PROTECT_RECENT_TOKENS;
		let recentFrom = n;
		for (let i = n - 1; i >= 0; i--) {
			keep[i] = true;
			recentFrom = i;
			recentBudget -= msgTokens(messages[i]);
			if (recentBudget <= 0) break;
		}
		// Always keep the leading anchor (system/first user) and any preserve-marked
		// (active DLC scope/plan, firing rules) message anywhere in history.
		if (n > 0) keep[0] = true;
		for (let i = 0; i < n; i++) {
			const txt = Array.isArray(messages[i].content)
				? messages[i].content.map((b: any) => (b?.type === "text" ? b.text : "")).join(" ")
				: String(messages[i].content ?? "");
			if (isPreserved(txt)) keep[i] = true;
		}
		// 2) Extend the kept-recent boundary so no tool pair is split at recentFrom.
		recentFrom = safeCutIndex(messages, recentFrom);
		for (let i = recentFrom; i < n; i++) keep[i] = true;
		// 3) Drop oldest cold (non-kept) messages until under target. Because pairs
		//    are only ever fully inside or fully outside the kept-recent region, and
		//    older calls/results live together in the cold head, dropping the head
		//    wholesale keeps pairs balanced; we still audit at the end.
		let total = 0;
		for (let i = 0; i < n; i++) total += msgTokens(messages[i]);
		const drop = new Array<boolean>(n).fill(false);
		for (let i = 0; i < n && total > targetTokens; i++) {
			if (!keep[i]) {
				total -= msgTokens(messages[i]);
				drop[i] = true;
			}
		}
		let out = messages.filter((_, i) => !drop[i]);
		// 4) Final pair audit — if a drop still orphaned a result (unusual: an evicted
		//    head call answered by a kept result outside the recent window), drop the
		//    orphan results too so replay stays valid.
		if (!pairsIntact(out)) {
			const calls = new Set<string>();
			for (const m of out) for (const id of callIdsOf(m)) calls.add(id);
			out = out.filter((m) => {
				const rid = resultIdOf(m);
				return !(rid && !calls.has(rid));
			});
		}
		return out;
	}

	pi.on("session_start", async (event: any, ctx: any) => {
		if (!ensureProc(event?.sessionId || "pi")) {
			ctx?.ui?.notify?.("LCM context engine unavailable (sidecar didn't start)", "warning");
			return;
		}
		contextLength = ctx?.model?.contextWindow || 200_000;
		// Precedence for the aux model: env pin / saved default (already in auxModel) >
		// pi's session model > cheapest capable fallback. Summarization is cheap+high-volume,
		// so the cheap tier is the last resort, not the session's smart model by force.
		if (!auxModel) auxModel = ctx?.model?.id || "gpt-5.3-codex-spark";
		const init = await call("init", {
			session_id: event?.sessionId || "pi",
			context_length: contextLength,
			threshold_tokens: Math.floor(contextLength * THRESHOLD_FRAC),
			aux: AUX_ENABLED,
		});
		if (init.error) ctx?.ui?.notify?.(`LCM init failed: ${init.error}`, "warning");
		else
			ctx?.ui?.notify?.(
				`LCM context engine ready (aux=${AUX_ENABLED ? `${auxModel}→${toCodexModel(auxModel)}` : "off"})`,
				"info",
			);
	});

	const DEBUG = process.env.KP_LCM_DEBUG === "1";
	const dbg = (m: string) => {
		if (DEBUG)
			try {
				appendFileSync(join(tmpdir(), "lcm-ctx-debug.log"), `${new Date().toISOString()} ${m}\n`);
			} catch {}
	};
	if (DEBUG) dbg("extension loaded, context handler registering");

	pi.on("context", async (event: any) => {
		if (!proc) return;
		const messages = event.messages;
		if (!Array.isArray(messages)) return;
		const _idleMs = Date.now() - lastActivityAt;
		lastActivityAt = Date.now();
		const tokens = roughTokens(messages);
		const threshold = Math.floor(contextLength * THRESHOLD_FRAC);
		const overflowAt = Math.floor(contextLength * OVERFLOW_FRAC);
		dbg(`context: ${messages.length} msgs, ~${tokens} tok, threshold ${threshold}, overflowAt ${overflowAt}`);
		if (messages.length < 8) return;

		// ── MODEL-FREE OVERFLOW LADDER (rank 7) ─────────────────────────────────
		// TRUE overflow (near/over the window) — not the ordinary 0.75 pressure. Here
		// the aux summarizer may itself be too big to run, so we must guarantee a
		// token drop WITHOUT depending on a model. Ladder:
		//   (a) if a larger-window same-provider model is configured, prefer promoting
		//       to it (no eviction needed) — signalled to pi via modelOverride;
		//   (b) else mechanically evict (no model call) down to the threshold and
		//       return immediately — never let an over-window summarizer sink the turn.
		if (FAILSAFE_ENABLED && tokens >= overflowAt) {
			if (PROMOTE_MODEL) {
				stats.promotions++;
				dbg(`overflow: promoting to larger-window model ${PROMOTE_MODEL}`);
				// pi honors modelOverride on a context result; leave messages untouched.
				return { modelOverride: PROMOTE_MODEL };
			}
			const evicted = mechanicalEvict(messages, threshold);
			stats.mechanicalEvicts++;
			dbg(
				`overflow: mechanical evict ${messages.length}→${evicted.length} msgs (no model call), pairsIntact=${pairsIntact(evicted)}`,
			);
			// Anchor the cache baseline to this mechanical head so the subsequent
			// REEVICT_EVERY turns reuse it (mechanical output is a strict subset → the
			// model already expects a reset here).
			lastEvictAtLen = messages.length;
			lastEvictResult = evicted;
			return { messages: evicted };
		}

		if (tokens < threshold) return;

		// Cache discipline: don't re-compress on every turn. If we compressed recently
		// and fewer than REEVICT_EVERY new messages have arrived, reuse the previous
		// rewrite verbatim so the cached prefix stays byte-identical.
		if (lastEvictResult && messages.length - lastEvictAtLen < REEVICT_EVERY) {
			stats.cacheReuses++;
			// Reuse the compressed HEAD verbatim (byte-identical → cache stays warm) and
			// append only the messages that arrived AFTER the last compression.
			const freshTail = messages.slice(lastEvictAtLen);
			return { messages: [...lastEvictResult, ...freshTail] };
		}

		const lcmMsgs = toLcm(messages);
		// Strip _orig before sending (keep index alignment via position).
		const wire = lcmMsgs.map(({ role, content }) => ({ role, content }));
		const resp = await call("compress", { messages: wire, current_tokens: tokens });
		dbg(`compress → status=${resp.status} stats=${JSON.stringify(resp.stats)} err=${resp.error ?? ""}`);
		if (resp.error || !Array.isArray(resp.messages)) return; // fail-open
		if (resp.status === "compacted" && resp.stats?.after < resp.stats?.before) stats.turnEvictions++;

		// Map compressed output back: LCM preserves the fresh tail verbatim, so
		// align surviving originals by (role, content) match; unmatched = summaries.
		const origByKey = new Map<string, any>();
		for (const lm of lcmMsgs) origByKey.set(`${lm.role}::${lm.content}`, lm._orig);
		const rehydrated = resp.messages.map((m: any) => {
			const orig = origByKey.get(`${m.role}::${m.content}`);
			return orig ?? { role: m.role, content: [{ type: "text", text: String(m.content ?? "") }] };
		});

		// ── PAIR-INTEGRITY AUDIT (rank 8) ───────────────────────────────────────
		// Our wire flattening erases the structured tool_call/tool_result fields the
		// sidecar guardrail keys off, so verify on the REHYDRATED native messages that
		// no tool pair got split. If the summary orphaned a result, fail-open to raw
		// (a warm-cache miss beats a provider replay rejection).
		if (!pairsIntact(rehydrated)) {
			dbg("compress output orphaned a tool pair — failing open to raw messages");
			return;
		}

		// ── MIN-SAVINGS GATE (rank 16) ──────────────────────────────────────────
		// Rewriting the message list busts the cached prefix and re-bills the tail.
		// If this compaction saves fewer than MIN_SAVINGS_TOKENS, the churn costs more
		// than it saves — skip it and leave the cache warm.
		const savedTokens = tokens - roughTokens(rehydrated);
		if (savedTokens < MIN_SAVINGS_TOKENS) {
			stats.minSavingsSkips++;
			dbg(`min-savings gate: would save only ~${savedTokens} tok (< ${MIN_SAVINGS_TOKENS}) — skip, keep cache warm`);
			return;
		}

		// ── CACHE-SAFE IN-PLACE REWRITE (rank 16) ───────────────────────────────
		// Rewriting head content in place is only cache-safe when little is at stake:
		// either the fresh (post-baseline) suffix is small, or the session idled past
		// the provider cache TTL (its cached prefix is already gone). Otherwise defer
		// to the boundary-batched reuse path already anchored above. We still return
		// the rewrite — this only decides whether to RE-ANCHOR the reuse baseline now
		// vs. let it ride to the next REEVICT_EVERY boundary.
		// KV-cache invariant: what we RETURN this turn must equal the baseline we STORE, or the
		// next reuse turn emits [...old-baseline, ...freshTail] — different prefix bytes than we
		// just returned, on a turn where nothing relevant changed. So always anchor the stored
		// baseline to exactly what we return. (The cacheSafe check only decided WHETHER to
		// re-anchor now vs. let it ride — but not re-anchoring while still returning the fresh
		// head is precisely what diverges return from baseline. Always anchor.)
		lastEvictAtLen = messages.length;
		lastEvictResult = rehydrated;
		return { messages: rehydrated };
	});

	// LCM OWNS compaction: when pi decides to compact (its timing is fine), we
	// supply an LCM lossless DAG summary instead of pi's lossy summarize-and-drop.
	// This structurally replaces pi's native summary — one coherent system, and
	// lcm_expand can recover any detail the summary elided.
	pi.on("session_before_compact", async (event: any) => {
		if (!proc) return; // fail-open → pi's native compaction runs
		const prep = event?.preparation ?? {};
		const toSummarize = prep.messagesToSummarize ?? [];
		if (!Array.isArray(toSummarize) || !toSummarize.length) return;
		dbg(`session_before_compact: ${toSummarize.length} msgs, reason=${event?.reason}`);

		// PAIR-INTEGRITY at compaction: the eviction boundary here is pi's own
		// (firstKeptEntryId) — we do NOT re-slice it, we only replace the summary
		// TEXT for the already-chosen evicted span. Everything in `toSummarize`
		// collapses to prose together, so no tool pair is split by us: a call and its
		// result are either both summarized (fine — both become prose) or both kept.
		// The one hazard is a kept result whose call pi put in the summarized span;
		// that is pi's boundary decision, so we surface it (debug) rather than move it.
		const wire = toLcm(toSummarize).map(({ role, content }) => ({ role, content }));
		const resp = await call("compress", { messages: wire, current_tokens: prep.tokensBefore }, 120_000);
		if (resp.error || !Array.isArray(resp.messages)) return; // fail-open to pi native

		// The compressed output's summary nodes ARE the compaction summary; join their text.
		let summary = resp.messages
			.filter((m: any) => m.role !== "user" || /summary/i.test(String(m.content)))
			.map((m: any) => String(m.content ?? ""))
			.join("\n\n")
			.trim();
		if (!summary) return;

		// PRESERVE-ACTIVE (rank 16): the active DLC scope/plan and any firing rule are
		// load-bearing — never let them be reduced to lossy summary prose. Re-inject
		// their verbatim text from the evicted span so they ride through compaction
		// intact and the model keeps working against the same scope after the cut.
		const preservedVerbatim: string[] = [];
		for (const m of toSummarize) {
			const txt = Array.isArray(m.content)
				? m.content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n")
				: String(m.content ?? "");
			if (txt && isPreserved(txt) && !summary.includes(txt.trim())) preservedVerbatim.push(txt.trim());
		}
		if (preservedVerbatim.length) {
			summary = `[LCM: preserved active scope/plan/rules]\n${preservedVerbatim.join("\n\n")}\n\n${summary}`;
			dbg(`compaction: re-injected ${preservedVerbatim.length} preserved (scope/plan/rule) block(s) verbatim`);
		}
		stats.compactions++;
		stats.lastCompactBefore = resp.stats?.before ?? 0;
		stats.lastCompactAfter = resp.stats?.after ?? 0;
		dbg(`compaction summary: ${summary.length} chars from ${resp.stats?.before}→${resp.stats?.after}`);
		return {
			compaction: {
				summary: `${summary}\n\n[LCM: full history recoverable via lcm_grep / lcm_expand]`,
				firstKeptEntryId: prep.firstKeptEntryId,
				tokensBefore: prep.tokensBefore,
				details: { engine: "lcm", stats: resp.stats },
			},
		};
	});

	// Recovery tools so the model can drill into evicted history.
	for (const [name, desc] of [
		["lcm_grep", "Search evicted/compacted conversation history for a term; returns matching spans."],
		["lcm_expand", "Expand a compacted summary node back to its underlying detail."],
		["lcm_status", "Show LCM context-engine status: tokens, compression count, DAG nodes."],
	] as const) {
		pi.registerTool({
			name,
			label: name.replace("_", " "),
			description: desc,
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "search term or node id" },
					scope: { type: "string", description: "optional scope" },
				},
			},
			async execute(_id: string, params: any) {
				if (!proc) return { content: [{ type: "text", text: "LCM engine not running" }] };
				const r = await call("tool", { name, args: params ?? {} }, 60_000);
				return { content: [{ type: "text", text: r.error ? `error: ${r.error}` : String(r.result ?? "") }] };
			},
		});
	}

	pi.registerCommand("lcm-status", {
		description: "Show LCM context-engine status: is it running, has it compacted, engine internals",
		handler: async (_args: string, ctx: any) => {
			if (!proc) {
				ctx.ui.notify("LCM: sidecar NOT running (check python3.11 / KP_LCM_ENABLED)", "warning");
				return;
			}
			const s = await call("status", {}, 10_000);
			const engine = s.status || {};
			ctx.ui.notify(
				`LCM context engine — RUNNING\n` +
					`this session: ${stats.turnEvictions} turn-evictions, ${stats.cacheReuses} cache-preserving reuses, ${stats.compactions} compactions, ${stats.auxCalls} aux-summaries\n` +
					`robustness: ${stats.mechanicalEvicts} model-free overflow evictions, ${stats.promotions} model promotions, ${stats.minSavingsSkips} min-savings skips (failsafe=${FAILSAFE_ENABLED ? "on" : "off"}, overflow@${Math.floor(contextLength * OVERFLOW_FRAC)} tok)\n` +
					(stats.compactions
						? `last compaction: ${stats.lastCompactBefore}→${stats.lastCompactAfter} msgs\n`
						: "") +
					`engine: ${engine.compression_count ?? 0} total compressions, ${engine.dag_nodes ?? 0} DAG nodes, ${engine.store_messages ?? 0} stored msgs\n` +
					`aux model: ${auxModel} (→codex ${toCodexModel(auxModel)}), threshold ${Math.floor(contextLength * THRESHOLD_FRAC)} tok\n` +
					`owns compaction: yes (pi native summary replaced). Recover detail: lcm_grep / lcm_expand`,
				"info",
			);
		},
	});

	pi.registerCommand("lcm-aux", {
		description:
			"Select the LCM aux model · /lcm-aux <id> (session) · /lcm-aux <id> --default (persist) · no arg = menu",
		handler: async (args: string, ctx: any) => {
			const raw = (args || "").trim();
			// Direct forms: `/lcm-aux <id>` (this session) or `/lcm-aux <id> --default` (persist).
			const wantDefault = /(^|\s)--default(\s|$)/.test(raw);
			const typed = raw.replace(/(^|\s)--default(\s|$)/, " ").trim();
			const apply = (model: string, persist: boolean) => {
				auxModel = model;
				if (persist) saveDefaultAux(model);
				ctx.ui.notify(
					`LCM aux model → ${auxModel} (codex: ${toCodexModel(auxModel)})` +
						(persist ? " · saved as default (all future sessions)" : " · this session"),
					"info",
				);
			};
			if (typed) {
				apply(typed, wantDefault);
				return;
			}

			// Menu: pick a model, then choose session-only vs. persist-as-default.
			const sessionModel = ctx?.model?.id || "";
			const savedDefault = loadDefaultAux();
			const opts = [
				...(sessionModel ? [`Use pi's session model (${sessionModel})`] : []),
				"gpt-5.4-mini (cheap)",
				"gpt-5.3-codex-spark (cheapest)",
				"Custom…",
			];
			const label = `LCM aux model — current: ${auxModel}${savedDefault ? ` · default: ${savedDefault}` : " · no saved default"}`;
			const choice = await ctx.ui.select(label, opts);
			if (!choice) return;
			let model = "";
			if (choice.startsWith("Use pi's")) model = sessionModel;
			else if (choice === "Custom…") {
				const v = await ctx.ui.input("Model id");
				model = v?.trim() || "";
			} else model = choice.split(" ")[0];
			if (!model) return;
			// Session-only or persist as the default for every future session?
			const scope = await ctx.ui.select(`Set ${model}:`, ["This session only", "Set as default (all sessions)"]);
			if (!scope) return;
			apply(model, scope.startsWith("Set as default"));
		},
	});

	pi.on("session_shutdown", async () => {
		await call("shutdown", {}, 3000).catch(() => {});
		proc?.kill();
		proc = null;
	});
}
