/**
 * memory.ts — cross-session memory through the Knowledge Platform brain.
 *
 * KP already IS a genuinely-good memory system (matching the 2026 SOTA: write-time
 * structured-fact extraction, cross-encoder multi-signal retrieval, non-destructive
 * correction for staleness, entity linking, provenance). So memory routes through
 * KP rather than reinventing a weaker keyword store locally — "don't rebuild what
 * exists." This extension is the thin pi-side glue: detect corrections, write them,
 * expose recall, honor the gate and the bloat budget.
 *
 * Design constraints (all the hard-won lessons):
 *  - Corrections: pure-code detection (no LLM), SANCTIONED GATE EXCEPTION (user
 *    decision) — autoconfirm but NEVER silent (notify + reversible via /memory
 *    undo). Secret-scanned. All other categories propose through the gate.
 *  - Write-time quality is KP's job: knowledge_remember proposes a structured
 *    fact; knowledge_search recipe:cross_encoder reranks; knowledge_correct
 *    supersedes stale/contradicting facts non-destructively.
 *
 * RECALL — two paths (proactive + pull), both cheap and race-free:
 *  - PROACTIVE auto-surface (the better-than-pull path). When you send a message,
 *    a BACKGROUND (non-blocking) KP search finds corrections/preferences relevant
 *    to THAT message; the top few are injected on the NEXT turn via the `context`
 *    hook (a trailing message — cache-safe, no prefix churn). This is NOT the old
 *    session-start sync-inject that raced: it's async per-turn, only fires on a
 *    relevant hit, deduped vs what's already surfaced this session, and capped. So
 *    a relevant past correction surfaces WITHOUT the model having to think to ask.
 *  - PULL on demand: recall_memory tool, for when the model wants to search deeper.
 *  Relevance = KP cross_encoder rerank, biased toward corrections/preferences and
 *  this project's scope. Superseded facts never surface (KP handles staleness).
 *
 * ALWAYS-ON DIGEST (the MEMORY.md-shaped tier). A small, human-readable, EDITABLE
 * file `.pi/pi-memory.md` — the handful of standing facts pi should know EVERY
 * session without a query. It has two parts:
 *   ## Pinned (you own this) — hand-written; NEVER touched by the auto-refresh.
 *   ## From the brain (auto) — the top-N standing corrections/observations,
 *      regenerated from KP by `reflect_memory`/`/memory digest --refresh`.
 * It's a DERIVED CACHE of the brain, not a parallel store (so it can't drift as the
 * source of truth), and it survives brain-down (works when FalkorDB is unreachable).
 * Injected at session start, cache-safe (trailing message, not the system prompt).
 * You can see it (`/memory digest`) and edit it (it's just a file) — both by design.
 *
 * Config: KP_MEMORY_STRUCTURED=0 disable typed memory (ON by default) — (Preference/Convention/Rule/Style/
 * Knowledge kinds + added_by=pi + scope/activity as real KP fields + dedup-on-write +
 * correct_edge supersession) instead of text tags · KP_MEMORY_STALE_DAYS (/memory stale TTL,
 * default 180) · KP_MEMORY_ENABLED=0 disable · KP_MEMORY_AUTOCONFIRM=0 require confirm on
 * corrections · KP_MEMORY_PROACTIVE=0 disable auto-surface (pull-only) ·
 * KP_MEMORY_SURFACE_MAX (top-N surfaced, default 3) · KP_MEMORY_DIGEST=0 disable the
 * always-on digest · KP_MEMORY_DIGEST_MAX (lines from brain, default 10) · KP_PI_TIMEOUT_MS ·
 * KP_MEMORY_LOCAL=0 disable the local snapshot (turn-path matching falls back to the KP
 * cross-encoder — slow on this stack) · KP_MEMORY_ERROR_RECALL=0 disable error-checkpoint
 * recall · KP_MEMORY_ERROR_MAX (mid-task error injections per session, default 2) ·
 * KP_MEMORY_ERROR_MIN (error-recall match bar, default 0.25).
 *
 * DELIVERY LANES (write-time compilation — expensive work at write time, read path local):
 *   always-on  → the digest (globals only, once per session)
 *   triggered  → recurring @file-scoped steers compile to glob-gated rules (.pi/rules/mem-*)
 *                that rules.ts fires the moment a matching file is touched — zero tokens otherwise
 *   on-demand  → episodic/procedural bulk stays in the brain, pulled via recall_memory
 * The per-turn proactive lane matches against a LOCAL snapshot of typed memories
 * (.pi/memory-snapshot.json, synced in background) — <10ms, so same-turn injection lands.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { wrapInjection } from "./kp-sentinel.ts"; // provenance sentinel (anti-injection)

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const KP_CWD = join(REPO_ROOT, "knowledge-platform");
const ENABLED = process.env.KP_MEMORY_ENABLED !== "0";
const AUTOCONFIRM = process.env.KP_MEMORY_AUTOCONFIRM !== "0";
const CALL_TIMEOUT = Number(process.env.KP_PI_TIMEOUT_MS ?? 300_000);

const SECRET_RE =
	/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/;

// A question or a task request is not a fact/preference/correction to STORE — capturing it pollutes
// memory. Interrogatives: ends with '?', or opens with a question/request word. Defined before the
// pattern checks so they can exclude it.
const QUESTION_OPENERS =
	/^(does|do|is|are|was|were|can|could|should|would|will|has|have|what|why|how|when|where|which|who|whose|whom|whether|any|did)\b/i;
const REQUEST_OPENERS =
	/^(add|fix|check|make|create|remove|delete|update|change|build|run|write|show|find|test|implement|refactor|open|close|start|stop|set|get|use|try|give|let'?s|can you|could you|would you|please|tell me|explain|describe|list|search|look)\b/i;
function isQuestionOrRequest(t: string): boolean {
	const s = (t || "").trim();
	if (!s) return false;
	if (s.endsWith("?")) return true;
	return QUESTION_OPENERS.test(s) || REQUEST_OPENERS.test(s);
}

// TIGHTENED: each pattern requires a genuine steering shape (imperative to pi / explicit
// dissatisfaction), anchored so it doesn't fire inside a question or an embedded instruction like
// "say no if you don't know". Interrogatives are excluded up-front in isCorrection.
const CORRECTION_PATTERNS: RegExp[] = [
	// leading "no/don't/stop/never … <verb>" — a real correction OPENS with it (not mid-sentence,
	// which is usually a question/quote). Anchored to the start (allow a short lead-in).
	/^(no,?|nope,?|don'?t|do not|stop|never|avoid)\s+\b(use|do|add|call|import|run|writ|creat|includ|put|name|set|return|make|commit|push|change|touch|edit)/i,
	/\b(actually|instead|rather)\b[, ].{0,24}\b(use|should|prefer|do it|name|call it)\b/i,
	/^(always|from now on|going forward|next time|every time)\b/i, // must OPEN with it (a directive)
	/\bthat'?s (wrong|not right|incorrect|not what i|not how)\b/i,
	/\byou (should(n'?t)? have|shouldn'?t have|forgot to|missed|were supposed to)\b/i, // past-tense = a real correction, not a question about what pi should do
	/^(don'?t forget|remember to|make sure to|be sure to|please (always|never|remember))\b/i,
	/\bwrong[.,]?\s+(should be|use|it'?s)\b/i,
];
function isCorrection(t: string): boolean {
	if (!t || t.length > 400) return false;
	if (isQuestionOrRequest(t)) return false; // a question/request is never a correction
	return CORRECTION_PATTERNS.some((re) => re.test(t));
}

// PREFERENCES / CUSTOMIZATIONS — durable standing choices (not a fix of a mistake, but a
// stated way you want things). Captured as [preference] facts. Kept distinct from
// corrections so recall/digest can weight them, and so a wrong capture is obvious in the
// widget. Guarded (below) against one-off task requests.
// TIGHTENED: anchored to a stated STANDING choice (I/we prefer…, our convention is…), not a
// one-off imperative. Dropped the loose "call/name X" and "set X to Y" patterns — those fire on
// ordinary task requests ("call the API", "set the timeout to 30"), not preferences.
const PREFERENCE_PATTERNS: RegExp[] = [
	/\b(we|i|our team|this (project|repo|codebase)) (prefer|prefers|favou?r|standardi[sz]e|always use|convention is|style is)\b/i,
	/\b(i|we) (like|want|expect|require)\b.{0,40}\b(to be|named|called|formatted|structured|as a (convention|standard|rule|pattern))\b/i,
	/\b(let'?s|we should) (always|adopt|standardi[sz]e on|stick to)\b/i,
	/\b(the|our) (convention|standard|rule|policy|style guide) (here )?is\b/i,
	/\b(i|we) prefer(red)?\b.{0,30}\b(over|to|instead of)\b/i, // "I prefer X over Y"
];
// Guard: skip if it reads like a one-off task ("add a preference page", "call the API")
// rather than a standing preference — cheap heuristic to cut the obvious false positives.
const ONEOFF_GUARD =
	/\b(add|create|build|implement|write|fix|make me|generate|can you|please)\b.{0,20}\b(a |an |the |this |that |page|endpoint|function|method|class|file|component|test|feature)\b/i;
function isPreference(t: string): boolean {
	if (!t || t.length > 400) return false;
	if (isQuestionOrRequest(t)) return false; // a question/request is never a preference
	if (ONEOFF_GUARD.test(t) && !/\b(prefer|convention|standard|always|from now on)\b/i.test(t)) return false;
	return PREFERENCE_PATTERNS.some((re) => re.test(t));
}

// SOFT steering — implicit dissatisfaction/redirection ("make it simpler", "too verbose",
// "not quite", rephrases). Research: implicit-feedback detection is only ~40% accurate, so
// these NEVER write a durable rule — they only INCREMENT a recurrence counter. A soft steer
// that recurs ≥ threshold is what earns promotion, so noise here is self-limiting.
const SOFT_STEER_PATTERNS: RegExp[] = [
	/\b(too|way too|bit)\s+(long|verbose|complex|complicated|much|terse|short|clever)\b/i,
	/\b(make it|keep it|can you make|let'?s keep)\b.{0,20}\b(simpler|shorter|cleaner|smaller|leaner|concise)\b/i,
	/\b(not quite|not really|hmm|meh|close but|almost)\b/i,
	/\b(simpler|cleaner|less)\b.{0,15}\b(please|version|approach|way)\b/i,
];
function isSoftSteer(t: string): boolean {
	if (!t || t.length > 300) return false;
	return SOFT_STEER_PATTERNS.some((re) => re.test(t));
}

function loadSpec(): any {
	for (const dir of [REPO_ROOT, KP_CWD]) {
		try {
			const cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
			if (cfg.mcpServers?.knowledge) return cfg.mcpServers.knowledge;
		} catch {}
	}
	return null;
}

// --- always-on digest (the MEMORY.md-shaped tier) ---
const DIGEST_ENABLED = process.env.KP_MEMORY_DIGEST !== "0";
const DIGEST_MAX = Number(process.env.KP_MEMORY_DIGEST_MAX || 10);
const DIGEST_START = "<!-- BRAIN:BEGIN (auto — regenerated; edit above the Pinned line, not here) -->";
const DIGEST_END = "<!-- BRAIN:END -->";
const DIGEST_TEMPLATE =
	"# pi memory — always-on digest\n" +
	"#\n" +
	"# This file loads at the start of every pi session. Two parts:\n" +
	"#   ## Pinned  — YOU own this. Hand-write standing facts here; never auto-touched.\n" +
	"#   ## From the brain — auto-regenerated top standing facts (do not hand-edit).\n" +
	"# It's a cache of the KP brain, so it also works when the brain is down.\n" +
	"\n## Pinned\n\n" +
	"- (add your own standing notes here — conventions, gotchas, do/don'ts)\n" +
	"\n## From the brain\n\n" +
	DIGEST_START +
	"\n" +
	"- (empty — run `reflect_memory` or `/memory digest --refresh` to populate)\n" +
	DIGEST_END +
	"\n";

function digestPath(): string {
	const { join: pjoin } = require("node:path");
	return pjoin(process.cwd(), ".pi", "pi-memory.md");
}

// Read the hand-authored CLAUDE.md layers (repo + system) — the cold-start priming that
// claude-md.ts injects. Used to keep the brain digest from re-injecting the same line.
function claudeMdCorpus(): string {
	const { join: pjoin } = require("node:path");
	const { existsSync: ex, readFileSync: rf } = require("node:fs");
	const { homedir: hd } = require("node:os");
	let out = "";
	for (const p of [pjoin(process.cwd(), "CLAUDE.md"), pjoin(hd(), ".claude", "CLAUDE.md")]) {
		try {
			if (ex(p)) out += `\n${rf(p, "utf-8")}`;
		} catch {}
	}
	return out.replace(/\s+/g, " ");
}
// Drop any digest line whose text is already substantially in CLAUDE.md (first ~90 chars probe).
function dropLinesInClaudeMd(snapshot: string): string {
	const corpus = claudeMdCorpus();
	if (!corpus.trim()) return snapshot;
	return snapshot
		.split("\n")
		.filter((line) => {
			const probe = line
				.replace(/^[-*]\s*/, "")
				.trim()
				.slice(0, 90)
				.replace(/\s+/g, " ");
			if (probe.length < 24) return true; // too short to match confidently — keep
			return !corpus.includes(probe); // in CLAUDE.md → drop (deduped)
		})
		.join("\n")
		.trim();
}

export default function (pi: any) {
	// UI methods live on ctx.ui (ExtensionUIContext), not on `pi`. Capture it from any hook.
	let uiRef: any = null;
	const grabUi = (_e: any, ctx: any) => {
		if (ctx?.ui?.setWidget) uiRef = ctx.ui;
	};
	pi.on("session_start", grabUi);
	pi.on("turn_start", grabUi);
	pi.on("before_agent_start", grabUi); // fires before the input hook → uiRef ready for the proposal widget
	if (!ENABLED) return;
	let client: Client | null = null;
	const stats = { corrections: 0, recalls: 0, softSteers: 0, preferences: 0 };
	let lastFact: string | null = null; // text of last auto-saved correction, for /memory undo

	// Hermes-style VISIBLE + REVERSIBLE auto-save. Broadened detection is only safe if every
	// auto-save is shown and easily undone — so we keep a small ring of recent saves, render
	// it as a widget above the editor, and let /memory undo <n> retract any one. A save in a
	// delegated CHILD posts to the parent a2a inbox → main surfaces it here (see poll below).
	type Save = { text: string; category: string; source: string; ts: number };
	const recentSaves: Save[] = []; // most-recent last; capped
	const SAVE_RING = Number(process.env.KP_MEMORY_RING || 6);
	const WIDGET = process.env.KP_MEMORY_WIDGET !== "0";
	// Subagent → main propagation. Delegated children share a run dir (A2A_RUN); a child
	// appends its saves to <run>/memory-saves.jsonl and the MAIN session polls that file so
	// a save made deep in a delegation is still visible + removable from the main widget.
	const A2A_ID = process.env.A2A_ID || "parent";
	const isChild = A2A_ID !== "parent";
	function savesFeedPath(): string | null {
		const run = process.env.A2A_RUN;
		if (!run) return null;
		return require("node:path").join(
			require("node:os").homedir(),
			".pi",
			"agent",
			"pi-harness",
			"a2a",
			run,
			"memory-saves.jsonl",
		);
	}
	// ── PROPOSE-THEN-CONFIRM capture (replaces silent auto-store) ────────────────────────────
	// Rejected texts persist so we NEVER re-prompt the same thing. Keyed by a normalized form.
	const rejectedPath = (): string =>
		require("node:path").join(require("node:os").homedir(), ".pi", "agent", "pi-harness", "memory-rejected.json");
	const normCap = (t: string): string => (t || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
	// A looser KEYWORD SIGNATURE so a rejection generalizes to paraphrases — reject "no don't use var
	// here" and "never use var" is suppressed too (both → sig "use var"). Drops stopwords/filler,
	// keeps the salient content words, sorted. So you don't get re-prompted for restatements.
	const STOP = new Set(
		"the a an of to in on for and or but no not don dont do does is are was were be been i you we it this that use used using should would could can will just please always never from now going forward next time make sure".split(
			" ",
		),
	);
	const sigCap = (t: string): string => {
		const words = (t || "")
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 2 && !STOP.has(w));
		return [...new Set(words)].sort().slice(0, 8).join(" ");
	};
	let rejectedSet: Set<string> | null = null; // exact keys
	let rejectedSigs: Set<string> | null = null; // keyword signatures
	function loadRejected(): Set<string> {
		if (rejectedSet) return rejectedSet;
		try {
			const arr = JSON.parse(require("node:fs").readFileSync(rejectedPath(), "utf-8"));
			rejectedSet = new Set(arr);
			rejectedSigs = new Set(arr.map((k: string) => sigCap(k)).filter(Boolean));
		} catch {
			rejectedSet = new Set();
			rejectedSigs = new Set();
		}
		return rejectedSet;
	}
	// Rejected if the exact text matches, OR its keywords substantially OVERLAP a prior rejection's
	// (≥60% of the smaller keyword set). So "no don't use var here" rejected suppresses "never use
	// var" / "stop using var" too — paraphrases don't re-prompt.
	function isRejectedCapture(text: string): boolean {
		loadRejected();
		if (rejectedSet!.has(normCap(text))) return true;
		const words = new Set(sigCap(text).split(" ").filter(Boolean));
		if (!words.size) return false;
		for (const rej of rejectedSigs!) {
			const rw = rej.split(" ").filter(Boolean);
			if (!rw.length) continue;
			let overlap = 0;
			for (const w of rw) if (words.has(w)) overlap++;
			const smaller = Math.min(words.size, rw.length);
			if (smaller > 0 && overlap / smaller >= 0.6) return true;
		}
		return false;
	}
	function rememberRejected(text: string): void {
		const s = loadRejected();
		s.add(normCap(text));
		const sig = sigCap(text);
		if (sig) rejectedSigs!.add(sig);
		try {
			const p = rejectedPath();
			require("node:fs").mkdirSync(require("node:path").dirname(p), { recursive: true });
			require("node:fs").writeFileSync(p, JSON.stringify([...s].slice(-500))); // cap the file
		} catch {}
	}

	// Show an in-UI accept/reject for a detected capture. Stores ONLY on accept; a reject is
	// remembered so it never prompts again. NON-BLOCKING: proposals go into a passive queue shown as
	// a widget above the editor — NEVER a modal select() (which steals focus and would interrupt the
	// turn / your typing). You act on them with /memory yes|no (or ignore them; they don't persist).
	type Pending = { text: string; category: string; ts?: number };
	// PERSISTED across sessions: proposals live in a file so a capture you didn't review before quitting
	// is still waiting next session (and shared if multiple sessions run). Loaded lazily, re-read on each
	// access so concurrent sessions see each other's, saved on every mutation.
	const pendingPath = (): string =>
		require("node:path").join(require("node:os").homedir(), ".pi", "agent", "pi-harness", "memory-proposed.json");
	function loadPending(): Pending[] {
		try {
			const a = JSON.parse(require("node:fs").readFileSync(pendingPath(), "utf-8"));
			return Array.isArray(a) ? a : [];
		} catch {
			return [];
		}
	}
	function savePending(list: Pending[]): void {
		try {
			const p = pendingPath();
			require("node:fs").mkdirSync(require("node:path").dirname(p), { recursive: true });
			require("node:fs").writeFileSync(p, JSON.stringify(list.slice(-12))); // cap
		} catch {}
	}
	const pendingList = (): Pending[] => loadPending(); // always fresh from disk (cross-session)
	function renderPending(): void {
		if (!uiRef?.setWidget) return;
		const pending = pendingList();
		if (!pending.length) {
			try {
				uiRef.setWidget("kp-propose", undefined as any);
			} catch {}
			return;
		}
		const lines = pending.map((p, i) => {
			const label = p.category === "knowledge" ? "fact" : p.category;
			return `${i + 1}. [${label}] ${p.text.slice(0, 60)}${p.text.length > 60 ? "…" : ""}`;
		});
		try {
			uiRef.setWidget("kp-propose", [`📝 ${pending.length} proposed — /memory to accept/reject`, ...lines]);
		} catch {}
	}
	// Queue a detected capture as a PROPOSAL (persisted; does not store to brain; does not block).
	function proposeCapture(text: string, category: string, _ctx: any): void {
		const key = normCap(text);
		if (isRejectedCapture(text)) return;
		const list = loadPending();
		if (list.some((p) => normCap(p.text) === key)) return; // already queued (this or another session)
		list.push({ text, category, ts: Date.now() });
		savePending(list);
		renderPending();
	}
	// Accept a pending proposal (by index, or all) → store it + remove from the persisted queue.
	async function acceptPending(idx?: number): Promise<string> {
		const list = loadPending();
		const items = idx == null ? list.splice(0) : list.splice(idx - 1, 1);
		if (!items.length) return "Nothing to accept.";
		savePending(list);
		let n = 0;
		for (const p of items) {
			if (await store(p.category, p.text, true)) {
				n++;
				lastFact = p.text;
				pushSave(p.text, p.category);
			}
		}
		renderPending();
		if (n && LOCAL) void syncSnapshot(); // keep the turn-path snapshot current
		return `🧠 saved ${n} memory${n === 1 ? "" : "ies"}.`;
	}
	// Reject a pending proposal (by index, or all) → remove from queue + remember so it never re-proposes.
	function rejectPending(idx?: number): string {
		const list = loadPending();
		const items = idx == null ? list.splice(0) : list.splice(idx - 1, 1);
		savePending(list);
		for (const p of items) {
			rememberRejected(p.text);
		}
		renderPending();
		return items.length ? `↩ rejected ${items.length} — won't ask again.` : "Nothing to reject.";
	}

	// A PROPER focusable review panel — navigate proposals with ↑↓, accept (a/y/enter) or reject
	// (r/n) each in place, per-item. Non-blocking to the turn (opened on demand via /memory review).
	// Uses ctx.ui.custom (the same overlay pattern as the log viewer): width-padded rows so it draws.
	async function openProposeReview(ctx: any): Promise<void> {
		if (typeof ctx?.ui?.custom !== "function") {
			// no overlay UI → list + quick-command fallback
			const p0 = pendingList();
			ctx.ui.notify(
				p0.length
					? `Proposed memories (${p0.length}) — /memory yes [n] · no [n] · yes-all · no-all:\n` +
							p0.map((p, i) => `  ${i + 1}. [${p.category}] ${p.text.slice(0, 70)}`).join("\n")
					: "No proposed memories to review.",
				"info",
			);
			return;
		}
		const vw = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
		const trunc = (s: string, w: number) => (vw(s) <= w ? s : `${[...s].slice(0, Math.max(0, w - 1)).join("")}…`);
		const padc = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vw(s)));
		await ctx.ui.custom(
			(tui: any, _theme: any, _kb: any, done: (r: any) => void) => {
				let sel = 0;
				const panel: any = {
					render(width: number): string[] {
						const pending = pendingList(); // fresh from disk each render (cross-session)
						const w = Math.max(24, Math.min(width, 110));
						const inner = w - 2;
						const rowLine = (c = "") => `│${padc(trunc(c, inner), inner)}│`;
						const out = [`╭${"─".repeat(inner)}╮`, rowLine(" 📝 Review proposed memories"), rowLine("")];
						if (!pending.length) out.push(rowLine("  (none proposed — Esc to close)"));
						for (let i = 0; i < pending.length; i++) {
							const p = pending[i];
							const mark = i === sel ? "›" : " ";
							out.push(
								rowLine(
									` ${mark} [${p.category === "knowledge" ? "fact" : p.category}] ${p.text.slice(0, inner - 16)}`,
								),
							);
						}
						out.push(
							rowLine(""),
							rowLine(
								" ↑↓ move · a/Enter accept · r reject (never ask) · A accept-all · R reject-all · Esc close",
							),
							`╰${"─".repeat(inner)}╯`,
						);
						return out;
					},
					handleInput(data: string): void {
						const pending = pendingList();
						if (data === "\x1b" || data === "q" || data === "\x03") {
							done("closed");
							return;
						} // always closes
						if (!pending.length) {
							tui?.requestRender?.();
							return;
						} // empty: ignore other keys, stay open
						if (data === "\x1b[A" || data === "k") sel = Math.max(0, sel - 1);
						else if (data === "\x1b[B" || data === "j") sel = Math.min(pending.length - 1, sel + 1);
						else if (data === "a" || data === "y" || data === "\r" || data === "\n") {
							void acceptPending(sel + 1);
						} else if (data === "r" || data === "n") {
							rejectPending(sel + 1);
						} else if (data === "A") {
							void acceptPending();
							done("closed");
							return;
						} else if (data === "R") {
							rejectPending();
							done("closed");
							return;
						}
						sel = Math.max(0, Math.min(sel, pendingList().length - 1));
						tui?.requestRender?.();
					},
					invalidate() {},
					dispose() {},
				};
				return panel;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "bottom-center",
					width: "92%",
					minWidth: 50,
					maxHeight: "55%",
					margin: { bottom: 1, left: 1, right: 1 },
				},
			},
		);
	}

	function pushSave(text: string, category: string, source = "you"): void {
		recentSaves.push({ text, category, source, ts: Date.now() });
		while (recentSaves.length > SAVE_RING) recentSaves.shift();
		renderWidget();
		// if I'm a delegated child, also post it to the shared feed so main surfaces it.
		if (isChild) {
			try {
				const p = savesFeedPath();
				if (p) {
					require("node:fs").mkdirSync(require("node:path").dirname(p), { recursive: true });
					require("node:fs").appendFileSync(
						p,
						`${JSON.stringify({ text, category, source: A2A_ID, ts: Date.now() })}\n`,
					);
				}
			} catch {}
		}
	}
	// MAIN polls the shared feed for child saves and folds them into the widget.
	let feedOffset = 0;
	function pollChildSaves(): void {
		if (isChild) return; // only the parent aggregates
		try {
			const p = savesFeedPath();
			if (!p || !require("node:fs").existsSync(p)) return;
			const raw = require("node:fs").readFileSync(p, "utf-8");
			if (raw.length <= feedOffset) return;
			const fresh = raw.slice(feedOffset);
			feedOffset = raw.length;
			for (const line of fresh.split("\n").filter(Boolean)) {
				try {
					const s = JSON.parse(line);
					recentSaves.push({
						text: String(s.text),
						category: String(s.category),
						source: String(s.source || "child"),
						ts: Number(s.ts) || Date.now(),
					});
				} catch {}
			}
			while (recentSaves.length > SAVE_RING) recentSaves.shift();
			renderWidget();
		} catch {}
	}
	function renderWidget(): void {
		if (!WIDGET) return;
		try {
			if (!recentSaves.length) {
				uiRef?.setWidget?.([]);
				return;
			}
			const lines = recentSaves.map(
				(s, i) =>
					`${i + 1}. [${s.category}] ${s.text.slice(0, 60)}${s.text.length > 60 ? "…" : ""}${s.source !== "you" ? `  [from: ${s.source}]` : ""}`,
			);
			uiRef?.setWidget?.("kp-memory", [`🧠 recent memory (auto-saved — /memory undo <n> to remove):`, ...lines]);
		} catch {}
	}
	// Second widget: what's currently INJECTED into context this session (visibility — so you
	// can SEE which past memories the model is being fed, not just what got saved).
	function renderInjectedWidget(): void {
		if (!WIDGET) return;
		try {
			if (!activeMemories.length) {
				uiRef?.setWidget?.("kp-injected", undefined as any);
				return;
			}
			const lines = activeMemories
				.slice(0, 8)
				.map((f) => `· ${stripCat(f).slice(0, 66)}${f.length > 66 ? "…" : ""}`);
			uiRef?.setWidget?.("kp-injected", [
				`💉 injected into context (${activeMemories.length} — recalled from memory):`,
				...lines,
			]);
		} catch {}
	}
	const stripCat = (f: string) =>
		f
			.replace(/^\[[a-z-]+\]\s*/i, "")
			.replace(/@[\w:.-]+\s*/g, "")
			.trim();

	async function kp(): Promise<Client | null> {
		if (client) return client;
		const spec = loadSpec();
		if (!spec) return null;
		try {
			const transport = new StdioClientTransport({
				command: join(KP_CWD, spec.command),
				args: spec.args,
				cwd: KP_CWD,
				env: { ...process.env, ...spec.env },
			});
			const c = new Client({ name: "pi-memory", version: "0.1.0" });
			await c.connect(transport);
			client = c;
			return c;
		} catch {
			return null;
		}
	}

	async function call(name: string, args: any): Promise<any | null> {
		const c = await kp();
		if (!c) return null;
		try {
			const r = await c.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT });
			if (r.isError) return null;
			return (r.content as any[])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
		} catch {
			return null;
		}
	}

	// Store a memory as a category-tagged fact. KP does write-time extraction +
	// dedup; we just tag the category so recall can filter. Corrections autoconfirm
	// (exempt, visible); other categories propose (go through the normal flow).
	// SMART SCOPING — every memory (correction/preference/decision/note) is classified to the
	// narrowest true level so recall can weight it right:
	//   @file:<name>  — tied to a specific file/symbol ("in auth.ts…", "the validateOtp fn…")
	//   @global       — cross-project truth: tooling, language convention, personal preference
	//                   ("I prefer…", "always tabs", "never force-push", generic git/shell/editor)
	//   @<project>    — default; tied to THIS codebase.
	// An explicit #tag / #global still wins (manual override). File wins over global wins over
	// project when signals collide (narrowest applicable, except a clearly-global preference).
	const projectTag = () => `@${require("node:path").basename(process.cwd())}`;
	// cross-project signals: about the toolchain/language/personal style, not this repo.
	const GLOBAL_HINTS =
		/\b(i (prefer|like|always|never)|from now on|in (general|every project)|globally|any (project|repo)|my (default|preference|style)|(always|never) (use|do|run|commit|push|force|rebase)|git|force-push|rebase|shell|bash|zsh|editor|vim|vscode|terminal|commit message|tabs|spaces|indent|line ending)\b/i;
	// file signals: an explicit filename, or "the X function/class/method/endpoint".
	const FILE_RE = /\b([\w./-]+\.[a-z]{1,5})\b/i;
	const SYMBOL_RE =
		/\bthe\s+`?(\w+)`?\s+(function|method|class|component|endpoint|handler|module|hook|type|interface)\b/i;
	function classifyScope(text: string, fileInPlay?: string): { text: string; scope: string } {
		// explicit override first
		const m = text.match(/#(global|[a-z0-9_-]+)\b/i);
		if (m && m[1].toLowerCase() === "global")
			return { text: text.replace(/#global\b/i, "").trim(), scope: "@global" };
		if (m) return { text, scope: `@${m[1]}` };
		// file level — a filename mentioned in the text, or the file currently being edited
		const fm = text.match(FILE_RE);
		const sym = text.match(SYMBOL_RE);
		if (fm) return { text, scope: `@file:${fm[1].split(/[\\/]/).pop()}` };
		if (fileInPlay && (sym || /\bthis (file|function|method|class)\b/i.test(text)))
			return { text, scope: `@file:${fileInPlay}` }; // "this function" + a file in play → scope to it
		// global level — cross-project truth (personal style, toolchain, language convention)
		if (GLOBAL_HINTS.test(text)) return { text, scope: "@global" };
		// default: this project
		return { text, scope: projectTag() };
	}

	// STRUCTURED memory (KP_MEMORY_STRUCTURED): store typed memory via KP's structured
	// remember (kind + scope + activity + added_by=pi as real graph fields + dedup-on-write),
	// instead of stuffing keywords into text. ON by default (verified end-to-end); set
	// KP_MEMORY_STRUCTURED=0 to fall back to the legacy text-tag path (backward-compat).
	const STRUCTURED = process.env.KP_MEMORY_STRUCTURED !== "0";
	// pi memory categories → KP cognitive kinds (the full taxonomy):
	//   EPISODIC (what happened): failure, decision → Episodic
	//   PROCEDURAL (how-to): procedure → Procedural
	//   SEMANTIC (facts/norms): correction→Rule/Style, preference→Preference/Convention, else Knowledge
	// TIMELESS-FACT GUARD — a durable fact about you/your context ("my name is …", "I work
	// in IAM", "our prod db is Postgres") is always true regardless of age, so it must NEVER
	// become the decaying Episodic kind, even if a caller tags it 'decision'. It routes to
	// Knowledge (which already never decays) — NOT a separate kind. This is a guard, not a type:
	// the only real axis is "is it an event (Episodic, decays)?" — everything else is timeless.
	const TIMELESS_RE =
		/\b(my (name|role|title|team|timezone|tz|email|handle|company|employer|manager) (is|=|:)|i (am|work) (a |an |at |in |on )|i'?m (a |an |at |in )|our (prod|production|staging|main) (stack|db|database|cloud|region) is|we (run|use|are) on|the (prod|production) (db|database|stack|region) is|call me )\b/i;
	function isTimelessFact(text: string): boolean {
		return TIMELESS_RE.test(text);
	}

	// ── THE 7 KINDS — clear, non-overlapping boundaries (checked in this exact order) ──
	//  Two orthogonal questions decide the kind; the FIRST that matches wins:
	//
	//   Q1 — Is it a fact, or a directive (telling pi how to behave)?
	//   Q2 — (facts)     what happened=Episodic · how-to=Procedural · everything-else=Knowledge
	//        (directives) formatting=Style · hard-constraint=Rule · team-norm=Convention · soft=Preference
	//
	//  FACTS (things that are true — no behavioral instruction):
	//   • Episodic   — a specific EVENT that happened: a failure, an outcome, a decision made.
	//                  "the checkout broke on stale tax." The ONLY kind that decays (recency).
	//   • Procedural — a repeatable HOW-TO recipe: "to add an endpoint, do X then Y."
	//   • Knowledge  — any other durable fact: about you, your codebase, the domain, the world.
	//                  "broker flow goes through IdentityBrokerHandler", "my name is Siddharth",
	//                  "JWTs expire." The catch-all fact kind. Never decays.
	//
	//  DIRECTIVES (how pi should WORK — imperative, about behavior not truth):
	//   • Style      — formatting/naming only: tabs, casing, quotes, line length, layout.
	//   • Rule       — a hard, non-negotiable constraint: never/always/must ("never force-push").
	//   • Convention — a team/project NORM: "we/the team/this repo uses/standardizes on X."
	//   • Preference — a soft personal choice: "I prefer / I like X" (weaker than a Rule/Convention).
	//
	//  Boundary tie-breaks: a directive about formatting is Style even if phrased as a Rule
	//  ("always use tabs" → Style, not Rule). A timeless self/context fact is Knowledge, never
	//  Episodic (the guard above). "we use X" is a Convention (team norm); "I prefer X" is a
	//  Preference (personal). Episodic requires an EVENT — a standing structural fact is Knowledge.
	function kindFor(category: string, text: string): string {
		const t = text.toLowerCase();
		// 0. guard: a timeless self/context fact is a durable Knowledge fact, never a decaying event.
		if (isTimelessFact(text)) return "Knowledge";
		// 1. FACTS — event / how-to. (categories come from remember_note.)
		if (
			category === "failure" ||
			category === "decision" ||
			/\b(happened|failed|broke|turned out|the bug was|root cause)\b/.test(t)
		)
			return "Episodic";
		if (
			category === "procedure" ||
			/\b(to (fix|add|build|do|set ?up)\b.{0,30}\b(you|first|then|step)|steps? (to|are)|the way to)\b/.test(t)
		)
			return "Procedural";
		// 2. DIRECTIVES — formatting first (Style beats Rule when it's about format), then hard
		//    constraint (Rule), then team norm (Convention), then soft personal choice (Preference).
		const isDirective =
			category === "correction" ||
			category === "preference" ||
			/\b(never|always|must|forbidden|do not|don'?t|should|prefer|use|avoid)\b/.test(t);
		if (isDirective) {
			const teamNorm =
				/\b(we|our team|the team|this (project|repo|codebase)) (use|uses|standardi[sz]e|convention|prefer)|the convention (is|here)\b/.test(
					t,
				);
			const styleWord =
				/\b(tabs?|spaces?|indent\w*|format\w*|nam(e|ing)|cas(e|ing)|camel ?case|snake ?case|snake_case|kebab|pascal|semicolons?|quotes?|line ?length|layout|whitespace|blank ?line)\b/.test(
					t,
				);
			const hardWord =
				/\b(never|always|must|forbidden|do not|don'?t ever|required|mandatory|draft.?confirm|no auto)\b/.test(t);
			// A team-norm phrasing wins even if it names a format ("we use snake_case" = Convention,
			// a team standard — not a bare Style rule). Otherwise: format→Style, hard→Rule, else Preference.
			if (teamNorm) return "Convention";
			if (styleWord) return "Style";
			if (hardWord) return "Rule";
			return "Preference"; // soft personal choice ("I prefer …")
		}
		// 3. everything else — a durable fact.
		return "Knowledge";
	}
	const EPISODIC_KINDS = new Set(["Episodic"]);

	async function store(category: string, text: string, confirm: boolean): Promise<boolean> {
		if (SECRET_RE.test(text)) return false;
		const { text: clean, scope } = classifyScope(text, currentFileInPlay() ?? undefined);
		const activity = inferActivity(currentFileInPlay(), "", clean);

		if (STRUCTURED) {
			// typed structured write — KP stores kind as a real node label + provenance on the edge,
			// and dedups against a close existing memory of the same kind (supersede, not duplicate).
			const kind = kindFor(category, clean);
			const res = await call("knowledge.remember", {
				text: clean,
				kind,
				scope,
				activity,
				dedup: true,
				autoconfirm: confirm,
			});
			return res !== null;
		}

		// legacy path: rank-boosting ⟦keys⟧ text enrichment (KP has no structured channel when off).
		const digestKind = /^(correction|preference|decision|observation)$/.test(category)
			? "standing convention preference rule"
			: "";
		const keys = [activity, digestKind].filter(Boolean).join(" ").trim();
		const enriched = keys ? `[${category}] ${scope} ${clean}  ⟦keys: ${keys}⟧` : `[${category}] ${scope} ${clean}`;
		const res = await call("knowledge.remember", { text: enriched, autoconfirm: confirm });
		return res !== null;
	}

	// Smart recall bias — LAYERED, narrowest-to-widest. The scope is a hierarchy, not a
	// partition: at the FILE level you want file + project + global (the file's specifics PLUS
	// this repo's conventions PLUS your personal preferences), so the hint always includes all
	// applicable tiers. cross_encoder rewards the tag match, so a file-scoped memory ranks up
	// for its file, project memories surface across this repo, and global surface everywhere —
	// and when a file is in play, all three tiers are eligible at once.
	function recallScopeHint(): string {
		const f = currentFileInPlay();
		// widest → narrowest, all included: global ⊃ project ⊃ file(when in play)
		return `@global ${projectTag()}${f ? ` @file:${f}` : ""}`;
	}

	// strip the rank-boosting ⟦keys: …⟧ tag store() appends — it aids retrieval, not display.
	const stripKeys = (f: string) => f.replace(/\s*⟦keys:[^⟧]*⟧\s*$/u, "").trim();

	async function recallFacts(query: string, category: string): Promise<string[]> {
		return recallFactsScoped(query, category, recallScopeHint());
	}
	// recallFacts with an explicit scope bias (e.g. "@global" to pull cross-project preferences
	// that would otherwise be out-ranked by local facts under the project/file-scoped hint).
	async function recallFactsScoped(query: string, category: string, scopeHint: string): Promise<string[]> {
		// cross_encoder recipe = KP's reranked multi-signal retrieval (the quality path).
		const q = `${category === "any" ? query : `[${category}] ${query}`} ${scopeHint}`;
		const res = await call("knowledge.search", { query: q, recipe: "cross_encoder", include_proposed: true });
		if (!res) return [];
		try {
			const hits = JSON.parse(res).hits ?? [];
			return hits
				.map((h: any) => h.fact)
				.filter((f: any) => typeof f === "string")
				.map(stripKeys);
		} catch {
			return res.split("\n").filter(Boolean);
		}
	}

	// Ranked recall for proactive surfacing. IMPORTANT (verified against the live brain
	// 2026-07-05): KP's search hits carry NO numeric relevance score — the *recipe* is the
	// ranker. cross_encoder returns an already-reranked, noise-cut list (rrf/mmr return raw
	// recall incl. unrelated facts). So relevance = "made cross_encoder's cut, high in its
	// order", NOT a threshold on a score field. We keep a `score` on each hit only as a
	// RANK-DERIVED proxy (1.0 for rank 0, decaying) so downstream cap/sort still works, but
	// the real distractor-guard is: trust cross_encoder + take the top few. Only
	// corrections/preferences/decisions are surfaced (highest-value, lowest-noise).
	// Episodic recency weight (recency + relevance). KP freshness gives every fact an age_days;
	// an EPISODIC memory (what happened) is more useful when recent, so its relevance score is
	// multiplied by a gentle recency factor that decays with a half-life (KP_MEMORY_EPISODIC_HALFLIFE
	// days, default 30). CRITICAL: this is a RANK weight, never deletion — the floor is 0.4, so an
	// old episodic memory still surfaces if it's the most relevant thing; memory always stays.
	const EPISODIC_HALFLIFE = Number(process.env.KP_MEMORY_EPISODIC_HALFLIFE || 30);
	function recencyWeight(ageDays: number): number {
		if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
		const w = 0.5 ** (ageDays / EPISODIC_HALFLIFE);
		return Math.max(0.4, w); // floor: recency down-weights but NEVER drops a memory
	}
	const kindOf = (fact: string): string => {
		const m = fact.match(/^\[([a-z-]+)\]/i);
		const cat = m ? m[1].toLowerCase() : "";
		if (cat === "failure" || cat === "failure-lesson" || cat === "decision") return "Episodic";
		return ""; // typed structured facts carry their kind on the node, not the text — handled below
	};

	async function recallScored(query: string): Promise<Array<{ fact: string; score: number }>> {
		const res = await call("knowledge.search", {
			query: `${query} ${recallScopeHint()}`,
			recipe: "cross_encoder",
			include_proposed: true,
		});
		if (!res) return [];
		try {
			const hits = JSON.parse(res).hits ?? [];
			return (
				hits
					// rank-derived relevance (KP returns no score → position IS the signal), then apply the
					// episodic recency weight so recent events outrank stale ones for equal relevance. An
					// old episodic memory keeps a score ≥ 0.4×relevance — down-weighted, never removed.
					.map((h: any, i: number) => {
						const fact = stripKeys(String(h.fact ?? ""));
						const relevance = Number(h.score ?? h.rerank_score ?? h.relevance ?? 1 / (1 + i * 0.25));
						const ageDays = Number(h?.freshness?.age_days ?? 0);
						const episodic = kindOf(fact) === "Episodic" || EPISODIC_KINDS.has(String(h?.kind ?? h?.type ?? ""));
						const score = episodic ? relevance * recencyWeight(ageDays) : relevance;
						return { fact, score };
					})
					.filter(
						(h: any) => h.fact && /\[(correction|preference|decision|failure|failure-lesson)\]/i.test(h.fact),
					)
			);
		} catch {
			return [];
		}
	}

	// ── LOCAL SNAPSHOT + LOCAL MATCHER (KP_MEMORY_LOCAL, default ON) ─────────────────────
	// The per-turn proactive recall used to hit KP's cross-encoder — 10-15s on this stack's
	// CPU embedder/reranker, against a 300ms same-turn budget — so memory landed a turn late
	// (or never, in short sessions). But typed memories number in the dozens-to-hundreds:
	// picking the top 3 doesn't need a cross-encoder. So the brain's typed memories are
	// mirrored to a small local snapshot (background sync at session_start + after each
	// accepted save via knowledge.memory_by_kind), and the TURN PATH matches lexically
	// against that — <10ms, so same-turn injection actually lands BEFORE the model acts.
	// KP stays the source of truth; the snapshot is a derived cache (same principle as the
	// digest — survives brain-down, can't drift as an authority). The KP cross-encoder still
	// serves recall_memory (deliberate pull, model waits) and clusterKey (write path).
	const LOCAL = process.env.KP_MEMORY_LOCAL !== "0";
	const SNAP_KINDS = ["Rule", "Convention", "Style", "Preference", "Procedural", "Episodic", "Knowledge"];
	type SnapItem = {
		id?: string;
		edge_id?: string;
		text: string;
		kind: string;
		scope?: string;
		activity?: string;
		state?: string;
		valid_at?: string | null;
		age_days?: number;
		confidence?: number | null;
		salience?: number;
		score?: number;
		last_used_at?: string | null;
	};
	// Display string we inject/widget-ize; keeps the legacy [kind]/@scope strippers working.
	const _fmtMem = (m: { text: string; kind: string; scope?: string }): string => {
		const scope = m.scope ? ` ${m.scope.trim()}` : "";
		return `[${m.kind.toLowerCase()}]${scope} ${m.text}`.trim();
	};
	const snapshotPath = (): string => require("node:path").join(process.cwd(), ".pi", "memory-snapshot.json");
	let snapCache: SnapItem[] | null = null;
	function readSnapshot(): SnapItem[] {
		if (snapCache) return snapCache;
		try {
			const j = JSON.parse(require("node:fs").readFileSync(snapshotPath(), "utf-8"));
			snapCache = Array.isArray(j.items) ? j.items : [];
		} catch {
			snapCache = [];
		}
		return snapCache!;
	}
	async function syncSnapshot(): Promise<number> {
		const items: SnapItem[] = [];
		for (const kind of SNAP_KINDS) {
			const res = await call("knowledge.memory_by_kind", { kind, limit: 200 });
			if (!res) continue;
			try {
				for (const m of JSON.parse(res).memories ?? []) {
					// prefer the fuller field: memory_by_kind returns name-first, but on some nodes the
					// name is a short label and the summary carries the actual fact text.
					const text = [String(m?.text ?? ""), String(m?.summary ?? "")]
						.sort((a, b) => b.length - a.length)[0]
						.trim();
					if (text) items.push({ text, kind });
				}
			} catch {}
		}
		if (!items.length) return 0; // brain down/empty → keep the last good snapshot
		try {
			const p = snapshotPath();
			require("node:fs").mkdirSync(require("node:path").dirname(p), { recursive: true });
			require("node:fs").writeFileSync(p, JSON.stringify({ ts: Date.now(), items }));
			snapCache = items;
		} catch {}
		return items.length;
	}
	// Lexical matcher — coverage of the FACT's content by the query, IDF-weighted (rare words
	// count more). ≥2 shared content words required (1 for very short facts) so a one-word
	// coincidence never surfaces. Deterministic, no model, no network: this is what makes the
	// 300ms same-turn window real.
	const tokMem = (s: string): string[] =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s./_-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 2 && !STOP.has(w));
	function localMatch(query: string, max: number): Array<{ fact: string; score: number; kind: string }> {
		const items = readSnapshot();
		if (!items.length) return [];
		const df = new Map<string, number>();
		const factToks = items.map((it) => {
			const ws = [...new Set(tokMem(it.text))];
			for (const w of ws) df.set(w, (df.get(w) || 0) + 1);
			return ws;
		});
		const idf = (w: string) => Math.log(1 + items.length / (df.get(w) || 1));
		const q = new Set(tokMem(query));
		const scored: Array<{ fact: string; score: number; kind: string }> = [];
		for (let i = 0; i < items.length; i++) {
			const ws = factToks[i];
			if (!ws.length) continue;
			const shared = ws.filter((w) => q.has(w));
			// ≥2 shared content words, ALWAYS — no short-fact exception. Verified against the live
			// brain (2026-07-07): it holds ~200 entity-shaped 2-3-word "Rule" fragments from an old
			// extraction ("cac mtls", "passwordless factors"); a 1-word bar would surface one on any
			// topical coincidence. Requiring 2 shared rare words means a short fact only surfaces
			// when the turn is genuinely about it.
			if (shared.length < 2) continue;
			const score = shared.reduce((s, w) => s + idf(w), 0) / ws.reduce((s, w) => s + idf(w), 0);
			scored.push({ fact: `[${items[i].kind.toLowerCase()}] ${items[i].text}`, score, kind: items[i].kind });
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, max);
	}
	if (LOCAL) {
		pi.on("session_start", () => {
			snapCache = null;
			void syncSnapshot();
		});
	}

	// --- WRITE: correction auto-detection (pure-code, exempt, visible, reversible) ---
	// --- + PROACTIVE recall: background-search for relevant corrections on the input ---
	const PROACTIVE = process.env.KP_MEMORY_PROACTIVE !== "0";
	const SURFACE_MAX = Number(process.env.KP_MEMORY_SURFACE_MAX || 3);
	// Rank cutoff: KP hits carry no score, so this gates on the RANK-DERIVED proxy
	// (1/(1+i·0.25)): 0.3 ≈ keep the top ~5 of cross_encoder's already-noise-cut list.
	// A distractor hurts more than a miss, and SURFACE_MAX caps it further. At 0.3 an
	// old episodic memory (recency floor 0.4 × top relevance) stays comfortably above cutoff.
	const SURFACE_MIN_SCORE = Number(process.env.KP_MEMORY_SURFACE_MIN || 0.3);
	// Same-turn injection budget: how long the context hook waits for an in-flight recall
	// before falling through to next-turn. Bounded so a slow brain never stalls the turn.
	const SAME_TURN_WAIT_MS = Number(process.env.KP_MEMORY_SAMETURN_MS || 300);
	// RETENTION = sticky-whole-session (append-only). Injections re-emit the WHOLE active
	// list every turn in stable INSERTION ORDER — so while nothing new enters, the injected
	// tail is byte-identical turn-over-turn → KV cache hit. The list only ever GROWS (never
	// reorders, never shrinks), so the tail only ever extends → the prefix is always warm.
	// (Verified against pi: transformContext runs on a fresh structuredClone each turn and
	// is discarded after the request — runner.ts:947 / agent-loop.ts:285 — so there is no
	// history to mutate and nothing to "evict"; retention is purely what we choose to re-emit.)
	const activeMemories: string[] = []; // ordered, append-only
	const surfacedThisSession = new Set<string>(); // dedup — a fact enters activeMemories once
	let pendingSearch: Promise<void> | null = null; // in-flight recall for THIS turn (same-turn inject)
	let sawInput = false; // set by the input hook → inject memory only on user-input turns
	const filesTouched = new Set<string>(); // real files in play (from hread/hedit) — Cursor-style trigger
	let lastFileTouched: string | null = null; // most-recent file, for file-scope classify + recall
	const currentFileInPlay = () => lastFileTouched;

	// Retrieve relevant memories for `query` and ADD fresh ones to the active list (append
	// only — order preserved for cache stability). Returns the promise so the context hook
	// can optionally await it (bounded) for same-turn injection.
	function queueFresh(hits: Array<{ fact: string; score: number }>): void {
		const fresh = hits
			.filter((h) => h.score >= SURFACE_MIN_SCORE) // threshold-drop distractors
			.filter((h) => !surfacedThisSession.has(h.fact)) // dedup vs already active
			.sort((a, b) => b.score - a.score)
			.slice(0, SURFACE_MAX);
		// append in a deterministic order (by fact text) so concurrent recalls landing in
		// the same turn still produce a stable, reproducible tail.
		for (const h of fresh.sort((a, b) => a.fact.localeCompare(b.fact))) {
			activeMemories.push(h.fact);
			surfacedThisSession.add(h.fact);
		}
	}
	function recallAndQueue(query: string): Promise<void> {
		// FAST PATH: local snapshot matching (<10ms) — resolves before the context hook's
		// same-turn window, so the memory rides THIS turn. Falls back to the KP search only
		// when there's no snapshot yet (first session / brain never synced).
		if (LOCAL && readSnapshot().length) {
			try {
				queueFresh(localMatch(query, SURFACE_MAX * 2));
			} catch {}
			return Promise.resolve();
		}
		return recallScored(query)
			.then(queueFresh)
			.catch(() => {});
	}

	// FILE TRIGGER (Cursor/Windsurf-style): when the model actually reads/edits a file,
	// that file is the highest-precision retrieval key — memory tied to the code in play.
	// Far better than scraping filenames from prose. Fires a background recall keyed on the
	// real path; the result surfaces same-turn (context hook awaits) or next turn.
	// ACTIVITY INFERENCE — what is the model actually doing right now? The activity (testing,
	// api/routing, migration, commit, debug, styling…) is folded into the recall query so
	// cross_encoder surfaces the memories/preferences that fit THAT activity — e.g. editing a
	// *.test.ts surfaces your testing preferences; touching routes/ surfaces API conventions.
	// Signal = the file path + any bash command + your message. Returns keywords to bias recall.
	function inferActivity(file: string | null, cmd: string, text: string): string {
		const hay = `${file || ""} ${cmd} ${text}`.toLowerCase();
		const acts: string[] = [];
		// — lifecycle / workflow —
		if (
			/\b(plan|planning|design|architect|approach|strategy|rfc|spec|proposal|break (this |it )?down|scope out|how should (we|i))\b/.test(
				hay,
			)
		)
			acts.push("planning design architecture approach");
		if (/\b(implement|build|write|add|create|develop|code up|feature|scaffold)\b/.test(hay))
			acts.push("implementing feature building");
		if (/\brefactor|clean ?up|restructure|rename|extract|simplify|dedupe|tidy|tech ?debt\b/.test(hay))
			acts.push("refactoring cleanup restructure");
		if (/\breview|code ?review|critique|feedback|lgtm|nit|approve|\bpr\b|pull request|reviewing|diff\b/.test(hay))
			acts.push("code-review pr-review critique diff-review");
		if (/\bdocument|\bdocs?\b|readme|comment|docstring|jsdoc|changelog|adr\b/.test(hay))
			acts.push("documentation docs writing-style");
		// — engineering domains —
		if (
			/\.(test|spec)\.[a-z]+$|__tests__|\btest\b|\bjest\b|\bpytest\b|\bvitest\b|\btdd\b|assert|coverage|mock|fixture/.test(
				hay,
			)
		)
			acts.push("testing tests test-style tdd");
		if (
			/\broutes?\b|\bapi\b|controller|endpoint|handler|\.http|openapi|swagger|graphql|\brest\b|grpc|webhook/.test(
				hay,
			)
		)
			acts.push("api endpoint routing http contract");
		if (
			/migration|schema|\balter table\b|\bcreate table\b|\bddl\b|\bsql\b|query|prisma|knex|alembic|flyway|orm|index|\bdb\b/.test(
				hay,
			)
		)
			acts.push("database migration schema query");
		if (/\bgit (commit|push|rebase|merge|cherry)\b|commit message|\bpr\b|pull request|branch|conflict/.test(hay))
			acts.push("git commit-style pr version-control");
		if (/\b(debug|bug|error|exception|stack ?trace|failing|throws?|traceback|repro|crash|panic)\b/.test(hay))
			acts.push("debugging error-handling diagnosis");
		if (
			/\bauth|login|token|jwt|oauth|session|password|permission|acl|secret|credential|encrypt|csrf|xss|injection\b/.test(
				hay,
			)
		)
			acts.push("auth security");
		// — user's domains: microservices, IAM, backend, PR review (deeper than the generic ones above) —
		if (
			/\bmicroservice|service ?mesh|inter-?service|service boundary|\bgrpc\b|message queue|\bkafka\b|rabbitmq|\bsaga\b|event-?driven|service discovery|circuit ?break|\bapi gateway\b|distributed|downstream|upstream service|service contract/.test(
				hay,
			)
		)
			acts.push("microservices service-boundaries inter-service-contracts distributed-systems");
		if (
			/\biam\b|identity|\brbac\b|\babac\b|role-?based|policy|policies|tenant|multi-?tenan|authoriz|entitlement|scope|claim|principal|federation|\bsso\b|\bsaml\b|\boidc\b|access control|least privilege|grant|revoke/.test(
				hay,
			)
		)
			acts.push("iam identity-access rbac policies multi-tenancy authorization");
		if (
			/\bbackend|server-?side|\bservice\b|\brepository\b|\bdao\b|\bdto\b|business logic|domain (model|logic)|use ?case|\bhandler\b|middleware|serializ|deserializ|pagination|idempoten|transaction/.test(
				hay,
			)
		)
			acts.push("backend server-side domain-logic service-layer");
		if (/\b(css|style|tailwind|component|render|\bui\b|jsx|tsx|layout|responsive|a11y|accessib)\b/.test(hay))
			acts.push("ui styling component frontend");
		if (/\bperf|performance|slow|latency|optimi[sz]e|cache|n\+1|throughput|memory leak|profil/.test(hay))
			acts.push("performance optimization");
		if (/\b(async|concurren|thread|lock|race|deadlock|mutex|goroutine|promise|await|queue|worker)\b/.test(hay))
			acts.push("concurrency async");
		if (/\btype|typing|generic|interface|\benum\b|\bdto\b|validation|zod|pydantic|schema-valid/.test(hay))
			acts.push("types typing validation");
		// — ops / config —
		if (
			/\bdepend|package\.json|requirements|cargo\.toml|go\.mod|npm|pnpm|yarn|pip|\bpoetry\b|upgrade|bump|version/.test(
				hay,
			)
		)
			acts.push("dependencies packages versioning");
		if (/\bconfig|\benv\b|\.env|settings|dockerfile|docker-compose|\byaml\b|\btoml\b|\.ini|feature flag/.test(hay))
			acts.push("configuration env settings");
		if (/\bci\b|\bcd\b|pipeline|github ?action|workflow|deploy|release|build script|makefile/.test(hay))
			acts.push("ci-cd deploy release");
		if (/\blog|logging|trace|metric|observab|telemetry|monitor|alert|sentry|datadog/.test(hay))
			acts.push("observability logging");
		if (/\berror ?handl|exception|try ?catch|result type|fallback|retry|timeout|circuit break/.test(hay))
			acts.push("error-handling resilience");
		return acts.join(" ");
	}
	if (PROACTIVE) {
		// register a file as "in play": set the file-scope signal + fire a one-per-file recall,
		// biased by the inferred ACTIVITY so activity-relevant preferences surface.
		const noteFile = (path: string, cmd = "") => {
			const base = path.split(/[\\/]/).pop() || path;
			if (!base || !/\.[a-z0-9]{1,6}$/i.test(base)) return; // must look like a file
			lastFileTouched = base; // for file-scope classify + recall weighting
			if (filesTouched.has(base)) return; // one recall per file per session
			filesTouched.add(base);
			const activity = inferActivity(base, cmd, "");
			pendingSearch = recallAndQueue(`${base} ${path} ${activity}`.trim());
		};
		pi.on("tool_call", (event: any) => {
			const name = String(event?.name ?? event?.tool ?? "");
			const args = event?.arguments ?? event?.args ?? event?.params ?? event?.input ?? {};
			// harness file tools — the path is a structured arg.
			if (/^(hread|hedit|edit|read|write)$/i.test(name)) {
				const path = String(args.path ?? args.file ?? args.file_path ?? "").trim();
				if (path) noteFile(path);
				return;
			}
			// BASH: the model often reads a file via cat/head/tail/less/grep/sed/vim — that's a
			// file in play too, even though it isn't a structured file tool. Extract the file
			// path from the command so file-scope activates however the model looks at a file
			// (Q: "most of the time I'm at project dir, working through files"). Best-effort.
			if (/^bash$/i.test(name)) {
				const cmd = String(args.command ?? "");
				const m = cmd.match(
					/\b(?:cat|head|tail|less|more|bat|grep|rg|sed|awk|vim|nano|wc)\b[^|;&]*?\s([\w./-]+\.[a-z0-9]{1,6})\b/i,
				);
				if (m) noteFile(m[1], cmd);
			}
		});
	}

	// ── CHECKPOINT RECALL on errors (KP_MEMORY_ERROR_RECALL, default ON) ─────────────────
	// The single highest-value recall moment is an ERROR — "hit this before?" answered at
	// the moment it matters, not on the next user turn. On an error-shaped tool_result we
	// match the error text against the local snapshot (episodic/procedural/knowledge) and,
	// on a strong hit, permit ONE mid-task injection. That deliberately pierces the
	// sawInput gate (which exists to stop per-continuation re-nudging) — but narrowly:
	// capped per session (KP_MEMORY_ERROR_MAX), once per error signature, high match bar
	// (KP_MEMORY_ERROR_MIN), and only when a past memory actually matches. isError alone
	// is NOT enough (grep exit 1 is not an error worth recalling) — the text must look
	// like a real failure.
	const ERROR_RECALL = process.env.KP_MEMORY_ERROR_RECALL !== "0";
	const ERROR_MAX = Number(process.env.KP_MEMORY_ERROR_MAX || 2);
	// 0.25, not higher: the matcher scores coverage OF THE FACT, and an episodic memory is
	// half error-description, half lesson ("X failed → do Y") — the lesson half never appears
	// in the error text, capping honest matches near ~0.4. The real distractor guards are the
	// ≥2-shared-rare-words floor in localMatch, the per-signature dedup, and the session cap.
	const ERROR_MIN = Number(process.env.KP_MEMORY_ERROR_MIN || 0.25);
	const ERROR_SHAPE = /\b(error|exception|traceback|failed|failure|fatal|panic|assert(ion)? ?(error|failed))\b/i;
	let errorInjects = 0;
	let errorPending = false; // permits one mid-task injection in the context hook
	const errorSigs = new Set<string>(); // one recall per distinct error per session
	function errorSignature(text: string): string {
		const line = text.split("\n").find((l) => ERROR_SHAPE.test(l)) || text.slice(0, 160);
		return line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
	}
	if (ERROR_RECALL && LOCAL) {
		pi.on("tool_result", (event: any) => {
			if (errorInjects >= ERROR_MAX) return;
			const text = (event?.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => String(b.text ?? ""))
				.join("\n");
			if (!text || !ERROR_SHAPE.test(text.slice(0, 2000))) return; // must be error-SHAPED text
			const sig = errorSignature(text);
			if (!sig || errorSigs.has(sig)) return;
			errorSigs.add(sig);
			const hits = localMatch(`${sig} ${text.slice(0, 400)}`, 2)
				.filter((h) => h.score >= ERROR_MIN)
				.filter((h) => h.kind === "Episodic" || h.kind === "Procedural" || h.kind === "Knowledge");
			let added = 0;
			for (const h of hits.sort((a, b) => a.fact.localeCompare(b.fact))) {
				if (surfacedThisSession.has(h.fact)) continue;
				activeMemories.push(h.fact);
				surfacedThisSession.add(h.fact);
				added++;
			}
			if (added) errorPending = true;
		});
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// SELF-IMPROVEMENT LOOP — make steering DECLINE over time, not just get captured.
	// Grounded in the research (Generative Agents reflection · Reflexion · Mem0
	// consolidation · SSGM guards · Anthropic autonomy metrics):
	//   • recurrence ladder: correction → cluster → count → PROMOTE at ≥3 to an
	//     always-on OVERRIDE rule in the digest (so it stops recurring).
	//   • importance-weighted auto-reflect at session end (crystallize corrections
	//     into durable principles — not on a fixed N, on accumulated weight).
	//   • steering-rate visibility (/memory trend) — corrections/session over time.
	// GUARDS (the research's failure modes): scope-tag every promotion (over-
	// generalization), require recurrence≥3 before promoting (one correction never
	// becomes a global rule), soft steering only INCREMENTS a counter — never writes
	// a rule (implicit-feedback detection is ~40% acc, so weak signal only), and all
	// of it stays reversible via /memory undo.
	const SELFIMPROVE = process.env.KP_MEMORY_SELFIMPROVE !== "0";
	const PROMOTE_AT = Number(process.env.KP_MEMORY_PROMOTE_AT || 3); // recurrence→promote threshold
	const REFLECT_WEIGHT = Number(process.env.KP_MEMORY_REFLECT_WEIGHT || 6); // reflect trigger (accumulated weight)
	const STATE_FILE = () => require("node:path").join(process.cwd(), ".pi", "memory-recurrence.json");
	// accumulated importance weight since the last reflect (corrections*2 + soft); drives the
	// compaction-time auto-reflect and is reset by it and by a manual /memory reflect.
	let weightSinceReflect = 0;
	const bumpWeight = (soft: boolean) => {
		weightSinceReflect += soft ? 1 : 2;
	};

	type SteerState = {
		// per-correction cluster: canonical text → {count, scope, promoted, lastSeen(ISO)}
		clusters: Record<string, { count: number; scope: string; promoted: boolean; canonical: string; last: string }>;
		// per-session steering counts, for the trend: ISO-date → {explicit, soft}
		trend: Record<string, { explicit: number; soft: number }>;
	};
	function loadState(): SteerState {
		try {
			return JSON.parse(require("node:fs").readFileSync(STATE_FILE(), "utf-8"));
		} catch {
			return { clusters: {}, trend: {} };
		}
	}
	function saveState(s: SteerState): void {
		try {
			const { writeFileSync, mkdirSync } = require("node:fs");
			const { dirname } = require("node:path");
			mkdirSync(dirname(STATE_FILE()), { recursive: true });
			writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2));
		} catch {}
	}
	const todayKey = () => new Date().toISOString().slice(0, 10);

	// Cluster corrections by SEMANTIC similarity via the brain (research: cos≈0.92, the
	// Mem0/production method — lexical signatures can't group paraphrases like "no var, use
	// const" / "stop using var" / "always const"). We ask KP for corrections similar to this
	// one; if a strong match exists we treat it as the SAME cluster (key = the match's text),
	// so rewordings collapse. Falls back to the raw text as its own key if the brain is down.
	const SIM_THRESHOLD = Number(process.env.KP_MEMORY_SIM || 0.6); // rank-derived proxy cutoff
	async function clusterKey(text: string): Promise<string> {
		try {
			const hits = await recallScored(text); // reranked corrections/preferences/decisions
			const top = hits.filter((h) => h.score >= SIM_THRESHOLD).sort((a, b) => b.score - a.score)[0];
			if (top) return signatureOf(top.fact); // an existing similar correction → same cluster
		} catch {}
		return signatureOf(text); // novel → its own cluster
	}
	// stable short key from a fact's text (so the same fact always maps to the same cluster).
	function signatureOf(text: string): string {
		return text
			.toLowerCase()
			.replace(/#\w+|@[\w-]+|\[[a-z]+\]/g, "")
			.replace(/[^a-z0-9 ]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120);
	}

	// Record a steering event; on the Nth recurrence of the same (semantic) cluster, PROMOTE
	// it to an always-on rule in the digest. `soft`=true (rephrase/implicit) only counts —
	// never promotes on its own, and never writes a durable fact (research: implicit
	// detection is unreliable). Emits a visible notify on promotion.
	async function recordSteer(text: string, soft: boolean, ctxNotify?: (m: string, l: string) => void): Promise<void> {
		if (!SELFIMPROVE) return;
		const day = todayKey();
		const key = await clusterKey(text); // semantic cluster (await — off hot path already)
		const s = loadState(); // load AFTER the async so we don't clobber concurrent writes
		s.trend[day] ??= { explicit: 0, soft: 0 };
		s.trend[day][soft ? "soft" : "explicit"]++;
		if (key) {
			const { scope } = classifyScope(text, currentFileInPlay() ?? undefined);
			s.clusters[key] ??= {
				count: 0,
				scope,
				promoted: false,
				canonical: text.slice(0, 160),
				last: day,
			};
			const cl = s.clusters[key];
			cl.count++;
			cl.last = day;
			if (!soft) cl.canonical = text.slice(0, 160); // explicit text wins as canonical
			if (!cl.promoted && cl.count >= PROMOTE_AT) {
				cl.promoted = true;
				const promoted = await promoteToDigest(cl.canonical, cl.scope, cl.count);
				const how = cl.scope.startsWith("@file:") ? `a ${cl.scope}-triggered rule` : "always-on";
				if (promoted && ctxNotify)
					ctxNotify(`🎯 recurring steer (${cl.count}×) promoted to ${how}: ${cl.canonical.slice(0, 60)}…`, "info");
			}
		}
		saveState(s);
	}

	// Promote a recurring correction — DELIVERY IS SCOPE-ROUTED (write-time compilation):
	//   @file:X → a glob-gated RULE (.pi/rules/mem-*.json). rules.ts fires it the moment a
	//             matching file is touched — on time, zero tokens on every other turn. A
	//             file-scoped lesson in the always-on digest would pay context tax on turns
	//             where the file isn't even in play; as a rule it costs nothing until it applies.
	//   else    → an always-on digest line (small, once per session) — true globals only.
	// Both also persist to KP as a [rule] fact so cross-session recall still finds them.
	function ruleIdFor(canonical: string): string {
		let h = 0;
		for (let i = 0; i < canonical.length; i++) h = (h * 31 + canonical.charCodeAt(i)) | 0;
		return `mem${(h >>> 0).toString(36)}`;
	}
	function promoteToRuleFile(canonical: string, scope: string, count: number): boolean {
		try {
			const file = scope.slice("@file:".length);
			if (!file) return false;
			const { writeFileSync, mkdirSync, existsSync } = require("node:fs");
			const { join: pjoin } = require("node:path");
			const dir = pjoin(process.cwd(), ".pi", "rules");
			mkdirSync(dir, { recursive: true });
			const id = ruleIdFor(canonical);
			const p = pjoin(dir, `${id}.json`);
			if (existsSync(p)) return true; // already promoted (same canonical → same id)
			const rule = {
				id,
				name: id,
				correction: canonical, // glob-triggered: fires when a touched file matches (rules.ts)
				globs: [`**/${file}`],
				everyN: 20, // re-remind at most every 20 turns, not every touch
				from: `memory promotion (recurring ${count}×, ${scope})`,
				source: "memory",
			};
			writeFileSync(p, `${JSON.stringify(rule, null, 2)}\n`);
			return true;
		} catch {
			return false;
		}
	}
	async function promoteToDigest(canonical: string, scope: string, count: number): Promise<boolean> {
		// file-scoped → compile to a conditional rule instead of an always-on digest line.
		if (scope.startsWith("@file:") && promoteToRuleFile(canonical, scope, count)) {
			await store("rule", `${canonical} ${scope}`, true); // brain keeps the durable copy
			return true;
		}
		try {
			const { readFileSync, writeFileSync, existsSync } = require("node:fs");
			const p = digestPath();
			if (!existsSync(p)) readDigest(); // create from template if missing
			let cur = readFileSync(p, "utf-8");
			const line = `- ⚑ ${canonical}  _(recurring ${count}× · ${scope} · applies where scope matches)_`;
			const s = cur.indexOf(DIGEST_START),
				e = cur.indexOf(DIGEST_END);
			if (s !== -1 && e !== -1 && !cur.slice(s, e).includes(canonical.slice(0, 40))) {
				cur =
					cur.slice(0, s + DIGEST_START.length) +
					"\n" +
					line +
					cur.slice(s + DIGEST_START.length, e).replace(/^\n?- \(empty[^\n]*\n/, "") +
					cur.slice(e);
				writeFileSync(p, cur);
			}
			// also persist as a scoped [rule] fact for cross-session recall (not autoconfirm-silent
			// — it's high-signal but goes through the normal proposed flow unless it's a correction).
			await store("rule", `${canonical} ${scope}`, true);
			return true;
		} catch {
			return false;
		}
	}

	pi.on("input", async (event: any, ctx: any) => {
		const text = String(event?.text ?? "").trim();
		pollChildSaves(); // surface any saves made by delegated children since last turn
		if (!text) return;
		sawInput = true; // a real user turn — the context hook may inject memory once, then goes quiet
		// through the tool loop until your next message (no per-continuation re-inject).

		// CAPTURE = PROPOSE, not silent-store. Regex detection can't tell intent (a question's "say no
		// if you don't know" matched the correction pattern), so a match no longer auto-writes to the
		// brain. Instead it PROPOSES an in-UI accept/reject; nothing is stored until you accept. Rejected
		// texts are remembered and NEVER proposed again. Recall still runs below regardless.
		const category = isQuestionOrRequest(text)
			? null // questions/requests are never facts — skip entirely
			: isTimelessFact(text)
				? "knowledge"
				: isCorrection(text)
					? "correction"
					: isPreference(text)
						? "preference"
						: null;
		if (category && !isRejectedCapture(text)) {
			proposeCapture(text, category, ctx);
			if (category === "correction") {
				void recordSteer(text, false, (m, l) => ctx?.ui?.notify?.(m, l));
				bumpWeight(false);
			}
		} else if (isSoftSteer(text)) {
			// soft steer: COUNT only (no durable write) — earns promotion only if it recurs.
			stats.softSteers++;
			void recordSteer(text, true, (m, l) => ctx?.ui?.notify?.(m, l));
			bumpWeight(true);
		}

		// proactive recall: async (Mem0 AsyncMemory pattern). Search for memories relevant to
		// THIS input; queue the strong ones. We keep the promise in `pendingSearch` so the
		// context hook can await it (bounded) and inject SAME-TURN instead of next turn.
		if (PROACTIVE && text.length >= 8) {
			// include filenames the input mentions (weak prose-trigger; the strong one is the
			// tool_call file-trigger above, keyed on the file actually read/edited) AND the
			// inferred ACTIVITY so activity-relevant preferences surface (e.g. "add a test" →
			// testing preferences, even before a test file is opened).
			const files = (text.match(/[\w./-]+\.[a-z]{1,5}\b/gi) || []).slice(0, 5).join(" ");
			const activity = inferActivity(currentFileInPlay(), "", text);
			const query = `${text} ${files} ${activity}`.trim();
			pendingSearch = recallAndQueue(query);
		}
	});

	// Inject the ACTIVE memory list — cache-safe (trailing message, not the system prompt).
	// GATED TO USER-INPUT TURNS: emits the list ONCE on the turn that started from your message,
	// then stays silent through that request's tool-continuation turns (sawInput cleared after one
	// inject). Rationale: re-presenting "apply memory if it bears" on every continuation kept nudging
	// the model to reconsider memory mid-task → extra turns. The block is byte-identical while the
	// list is unchanged, and transformContext runs on a throwaway clone (nothing mutates real
	// history), so dropping it on continuations only changes the ephemeral tail — no eviction, and
	// the persistent prefix stays warm. The list is append-only, so it only ever EXTENDS on re-emit.
	//
	// SAME-TURN: if a recall for this turn is in flight, await it up to SAME_TURN_WAIT_MS so a
	// just-triggered memory lands THIS turn (Cursor/ChatGPT behavior) instead of one turn
	// late. Slow brain → fall through; the fact still enters activeMemories and shows next turn.
	let lastEmittedCount = -1;
	pi.on("context", async (event: any) => {
		// INJECT ONLY ON A USER-INPUT TURN, not on tool-continuation turns of the same request. The
		// context hook fires every turn (incl. each tool-result continuation); re-emitting the memory
		// block on those keeps nudging the model to reconsider memory mid-task, adding turns. `sawInput`
		// is set by the input hook and cleared here after one injection, so memory rides the turn that
		// STARTED from your message and is silent through the tool loop until your next message.
		// EXCEPTION: `errorPending` — an error-checkpoint recall just matched a past failure; that is
		// worth one mid-task injection NOW (budgeted + signature-deduped at the set site).
		if (!sawInput && !errorPending) return;
		// Drain ALL in-flight recalls for this turn (not just one) so everything relevant lands in a
		// SINGLE injection, not dribbled across turns. Both the input-trigger and any file-trigger recall
		// push into activeMemories; we wait (bounded) for whatever is in flight, then emit the complete
		// snapshot once. A recall that arrives AFTER the wait window accumulates silently and folds into
		// the NEXT user turn's single injection — never a mid-response drip.
		if (pendingSearch) {
			const inflight = pendingSearch;
			await Promise.race([inflight, new Promise((r) => setTimeout(r, SAME_TURN_WAIT_MS))]);
			pendingSearch = null; // consumed this turn; a later recall starts a fresh pendingSearch
		}

		// 0-MEMORY CASE: inject NOTHING — no empty header, no stray block. Consume the turn flag and
		// return clean, so an empty brain (or an all-below-threshold search) adds zero bytes.
		if (!activeMemories.length) {
			sawInput = false;
			errorPending = false;
			return;
		}

		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		sawInput = false; // consumed for this user turn; won't re-inject on tool continuations
		if (errorPending) {
			errorPending = false;
			errorInjects++;
		} // consume the one-shot exception

		// ONE injection, COMPLETE set: emit the whole activeMemories snapshot as a single block this
		// turn. (lastEmittedCount only gates the UI notice + recall stat, not the injection itself —
		// the block is always the full current set, so nothing is ever split across injections.)
		if (activeMemories.length !== lastEmittedCount) {
			const added = activeMemories.length - Math.max(lastEmittedCount, 0);
			stats.recalls += added;
			lastEmittedCount = activeMemories.length;
			// UI VISIBILITY: surface that memory was injected this turn (like the save-widget).
			if (added > 0) {
				try {
					uiRef?.notify?.(
						`🧠 injected ${activeMemories.length} relevant ${activeMemories.length === 1 ? "memory" : "memories"} into context`,
						"info",
					);
				} catch {}
			}
			renderInjectedWidget();
		}
		const body = activeMemories.map((f) => `- ${f}`).join("\n"); // stable order → stable bytes
		return {
			messages: [
				...messages,
				{
					role: "user",
					content: [
						{
							type: "text",
							text: wrapInjection(
								"memory",
								`## Relevant memory (context from past sessions — apply only if it bears on the current request; ignore if not):\n${body}`,
							),
						},
					],
				},
			],
		};
	});

	// --- WRITE: model-driven notes (failure/decision/procedure) ---
	pi.registerTool({
		name: "remember_note",
		label: "remember",
		description:
			"Persist a durable cross-session memory. Pick the category by what it IS:\n" +
			"• failure — a specific EVENT that went wrong (what broke + why). [→ Episodic, decays by recency]\n" +
			"• decision — a choice made + rationale (an event). [→ Episodic]\n" +
			"• procedure — a repeatable HOW-TO recipe ('to do X: step 1…'). [→ Procedural]\n" +
			"• knowledge — any other durable fact: about the codebase ('broker flow → HandlerX'), the domain, " +
			"the user, or the world. The catch-all fact. [→ Knowledge, never decays]\n" +
			"Record failures/decisions as they happen; knowledge when you learn a durable fact worth keeping. " +
			"(User preferences/rules/style/conventions are auto-captured from their messages — don't note those.) Proposes for review.",
		promptSnippet:
			"remember_note(category, text) — save a durable memory: failure/decision (event), procedure (how-to), knowledge (any fact). Record failures + learned facts as they happen.",
		parameters: {
			type: "object",
			properties: {
				category: {
					type: "string",
					enum: ["failure", "decision", "procedure", "knowledge"],
					description:
						"failure/decision=an event (Episodic, decays) · procedure=how-to · knowledge=any durable fact",
				},
				text: { type: "string", description: "self-contained memory (read in a future session)" },
			},
			required: ["category", "text"],
		},
		async execute(_id: string, params: any) {
			const noteText = String(params.text ?? "");
			// AUTOCONFIRM (like auto-captured corrections): a model-written note is a deliberate save
			// — proposing-without-confirm left them stuck as "proposed, never approved" so they never
			// persisted to the next session (the "don't make me repeat this" bug). It's visible in the
			// widget + reversible via /memory undo, so applying it is safe. KP_MEMORY_AUTOCONFIRM=0 opts out.
			const ok = await store(params.category, noteText, AUTOCONFIRM);
			if (ok) {
				lastFact = noteText;
				pushSave(noteText, params.category);
				if (LOCAL) void syncSnapshot();
			} // visible in widget + reversible
			return {
				content: [
					{
						type: "text",
						text: ok
							? `saved [${params.category}] to brain: ${noteText.slice(0, 80)}${noteText.length > 80 ? "…" : ""}`
							: "not saved (empty/secret/brain down)",
					},
				],
			};
		},
	});

	// --- RECALL: on demand only (no auto-injection → zero standing context cost) ---
	pi.registerTool({
		name: "recall_memory",
		label: "recall",
		description:
			"Search durable cross-session memory by cognitive TYPE: episodic (what happened — past failures/" +
			"decisions, recency-weighted), procedural (how you solved something before), semantic (standing " +
			"preferences/rules/conventions), or any. Use episodic when debugging ('hit this before?'), " +
			"procedural when implementing ('solved this before?'), semantic to check standing choices before acting.",
		promptSnippet:
			"recall_memory(query, type=episodic|procedural|semantic|any) — past failures/how-tos/preferences before acting",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "keywords / question" },
				type: {
					type: "string",
					enum: ["episodic", "procedural", "semantic", "any"],
					description: "episodic=what happened; procedural=how-to; semantic=facts/preferences",
				},
				category: {
					type: "string",
					enum: ["correction", "failure", "decision", "procedure", "any"],
					description: "(legacy) finer category filter",
				},
			},
			required: ["query"],
		},
		async execute(_id: string, params: any) {
			stats.recalls++;
			const type = String(params.type ?? "any").toLowerCase();
			// type-aware recall via the structured kinds when available; else fall back to text search.
			if (STRUCTURED && type !== "any") {
				const kinds =
					type === "episodic"
						? ["Episodic"]
						: type === "procedural"
							? ["Procedural"]
							: ["Preference", "Convention", "Rule", "Style", "Knowledge"]; // semantic
				// memory_by_kind lists the set; then rank by relevance to the query (recency for episodic).
				const scored = await recallScored(params.query);
				const wanted = scored
					.filter(
						(h) =>
							kinds.some((k) => new RegExp(`\\b${k}\\b|\\[${k.toLowerCase()}`, "i").test(h.fact)) ||
							type === "semantic",
					)
					.sort((a, b) => b.score - a.score);
				const facts = (wanted.length ? wanted : scored).slice(0, 8).map((h) => h.fact);
				return { content: [{ type: "text", text: facts.length ? facts.join("\n") : "no matching memories" }] };
			}
			const cat = params.category || (type === "episodic" ? "failure" : type === "procedural" ? "procedure" : "any");
			const facts = await recallFacts(params.query, cat);
			return {
				content: [{ type: "text", text: facts.length ? facts.slice(0, 8).join("\n") : "no matching memories" }],
			};
		},
	});

	// --- ALWAYS-ON DIGEST: a visible, editable file injected every session ---
	// read the file (create from template on first use so the user has something to edit)
	function readDigest(): string | null {
		const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
		const { dirname: pdir } = require("node:path");
		const p = digestPath();
		try {
			if (!existsSync(p)) {
				mkdirSync(pdir(p), { recursive: true });
				writeFileSync(p, DIGEST_TEMPLATE);
			}
			return readFileSync(p, "utf-8");
		} catch {
			return null;
		}
	}

	// regenerate ONLY the "From the brain" block between the markers; the Pinned section
	// (everything else, incl. the user's hand edits) is preserved byte-for-byte.
	async function refreshDigest(): Promise<{ ok: boolean; n: number; msg: string }> {
		const { writeFileSync } = require("node:fs");
		let cur = readDigest();
		if (cur === null) return { ok: false, n: 0, msg: "digest file unreadable" };
		// Pull standing facts with RESERVED SLOTS per category so no category starves. Previously
		// it was [...corr, ...pref, ...obs] cut at DIGEST_MAX — if corrections filled the digest,
		// PREFERENCES never made the cut (never injected). Now each category gets a guaranteed
		// share of DIGEST_MAX, then any leftover slots are filled from the remainder. Preferences
		// are pulled with a GLOBAL bias (they're usually cross-project) so they aren't out-ranked
		// by local facts under the project/file-scoped hint.
		// Scale note (10k+ node brains): an EMPTY query makes KP's search return an arbitrary
		// capped-at-20 slice, not the most-important facts. So the digest pulls with a MEANINGFUL
		// query — "standing rules and preferences for this project + the user's domains" — so
		// cross_encoder ranks the RIGHT facts into the digest even in a large graph. DIGEST_QUERY
		// is overridable; it should name what matters most (defaults cover generic dev + the
		// user's stored domain profile, which itself surfaces via the @global pull).
		const DIGEST_QUERY =
			process.env.KP_MEMORY_DIGEST_QUERY || "standing conventions preferences rules for this project and my work";
		const corr = await recallFacts(DIGEST_QUERY, "correction");
		const pref = await recallFactsScoped(DIGEST_QUERY, "preference", "@global"); // global-biased pull
		const obs = await recallFacts(DIGEST_QUERY, "observation");
		// reserved: ~half for corrections, a guaranteed third for preferences, rest observations.
		const reserve = {
			correction: Math.ceil(DIGEST_MAX * 0.5),
			preference: Math.max(2, Math.floor(DIGEST_MAX * 0.3)),
			observation: DIGEST_MAX,
		};
		const seen = new Set<string>();
		const lines: string[] = [];
		const take = (facts: string[], limit: number) => {
			let n = 0;
			for (const f of facts) {
				if (n >= limit || lines.length >= DIGEST_MAX) break;
				const clean = f
					.replace(/^\[[a-z]+\]\s*/i, "")
					.replace(/@[\w:-]+\s*/g, "")
					.trim();
				if (clean && !seen.has(clean)) {
					seen.add(clean);
					lines.push(`- ${clean}`);
					n++;
				}
			}
		};
		take(corr, reserve.correction); // corrections first (highest-value)
		take(pref, reserve.preference); // GUARANTEED preference slots — can't be starved
		take(obs, reserve.observation); // observations fill the rest
		// second pass: use any remaining slots from whatever's left (no category wasted)
		if (lines.length < DIGEST_MAX) {
			take(corr, DIGEST_MAX);
			take(pref, DIGEST_MAX);
			take(obs, DIGEST_MAX);
		}
		const block = lines.length ? lines.join("\n") : "- (brain returned no standing facts yet)";
		const s = cur.indexOf(DIGEST_START),
			e = cur.indexOf(DIGEST_END);
		if (s === -1 || e === -1) {
			// markers missing (user removed them?) — don't clobber their file; append a fresh block.
			cur = `${cur.trimEnd()}\n\n## From the brain\n\n${DIGEST_START}\n${block}\n${DIGEST_END}\n`;
		} else {
			cur = `${cur.slice(0, s + DIGEST_START.length)}\n${block}\n${cur.slice(e)}`;
		}
		try {
			writeFileSync(digestPath(), cur);
			return { ok: true, n: lines.length, msg: `refreshed ${lines.length} brain fact(s)` };
		} catch (err: any) {
			return { ok: false, n: 0, msg: `write failed: ${err.message?.slice(0, 80)}` };
		}
	}

	// Inject the digest EXACTLY ONCE per session — cache-safe (trailing message via the
	// context hook, never the system prompt). KV-cache discipline (user requirement): the
	// injected text is SNAPSHOTTED at session start and frozen for the whole session. The
	// file may change mid-session (a new correction, reflect_memory, /memory digest
	// --refresh all rewrite it) but we DELIBERATELY do NOT re-inject — the memory is already
	// in the session, and re-injecting would mutate the conversation tail and bust the cache
	// for zero benefit. New facts land in the digest for the NEXT session's snapshot.
	let digestSnapshot: string | null = null; // frozen at session start; never re-read for injection
	let digestInjected = false;
	if (DIGEST_ENABLED) {
		pi.on("session_start", () => {
			// Take the snapshot from the CURRENT file first (survives brain-down, instant), then
			// refresh the brain block in the background for NEXT session. The refresh's write does
			// NOT affect this session's already-frozen snapshot.
			const body = readDigest();
			if (body?.trim()) {
				const shown = body.replace(/^#.*$/gm, "").replace(DIGEST_START, "").replace(DIGEST_END, "").trim();
				// Defer to CLAUDE.md: it's the hand-authored cold-start layer (architecture/project
				// basics) injected by claude-md.ts. Drop any digest line already substantially present
				// there so the same standing instruction never rides the prefix twice. (Parity with
				// rules.ts's alreadyInClaudeMd guard — CLAUDE.md is the authored source of truth.)
				digestSnapshot = dropLinesInClaudeMd(shown) || null;
			}
			void refreshDigest().catch(() => {});
		});
		pi.on("context", async (event: any) => {
			if (digestInjected || !digestSnapshot) return; // once per session; nothing to inject if empty
			const messages = event?.messages;
			if (!Array.isArray(messages)) return;
			digestInjected = true;
			return {
				messages: [
					...messages,
					{
						role: "user",
						content: [
							{
								type: "text",
								text: wrapInjection(
									"memory",
									`## Standing memory (always-on digest — apply every session):\n${digestSnapshot}`,
								),
							},
						],
					},
				],
			};
		});
	}

	// --- reflect: distill raw facts into higher-level observations (mnemopi/Hindsight
	// memory-quality gap). Pulls related facts, synthesizes durable patterns via a
	// cheap model, stores them back as [observation] facts. Off the hot path.
	const REFLECT_MODEL = process.env.KP_MEMORY_REFLECT_MODEL || "gpt-5.4-mini";
	async function reflect(topic: string): Promise<string> {
		const facts = await recallFacts(topic || "", "any");
		if (facts.length < 3) return "Too few memories to reflect on yet.";
		const { execFileSync } = require("node:child_process");
		const { readFileSync, rmSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const { join: pjoin } = require("node:path");
		const outFile = pjoin(tmpdir(), `mem-reflect-${process.pid}-${Date.now()}.txt`);
		// IMPERATIVE FORM, deliberately: a directive ("When X, do Y") applies without extra
		// reasoning; a description of a past mistake ("you forgot to X") makes the model
		// re-derive the lesson every time it's recalled. Write the lesson, not the history.
		const prompt =
			"From these raw memories, synthesize 1-5 DURABLE DIRECTIVES (merged patterns, standing preferences, " +
			"conventions — not one-off events). Write each as a SELF-CONTAINED IMPERATIVE: 'When <situation>, <do this>' " +
			"or 'Always/Never <do X> when <context>'. No references to past conversations or mistakes ('you forgot…', " +
			"'last time…') — state the standing lesson directly, with enough context to apply it cold. " +
			"Merge repeated points; flag contradictions. One per line, terse.\n\n" +
			facts.slice(0, 30).join("\n");
		try {
			const model = /^gpt-/.test(REFLECT_MODEL) ? REFLECT_MODEL : REFLECT_MODEL;
			execFileSync(
				"codex",
				["exec", "-m", model, "--skip-git-repo-check", "--output-last-message", outFile, prompt],
				{ encoding: "utf-8", timeout: 90_000, cwd: tmpdir(), maxBuffer: 4 * 1024 * 1024 },
			);
			const obs = readFileSync(outFile, "utf-8").trim();
			rmSync(outFile, { force: true });
			if (!obs) return "Reflection produced nothing.";
			// store each observation back (autoconfirm — it's a distillation of confirmed facts)
			let n = 0;
			for (const line of obs
				.split("\n")
				.map((l: string) => l.replace(/^[-*\d.\s]+/, "").trim())
				.filter(Boolean)) {
				if (await store("observation", line, true)) n++;
			}
			return `Reflected ${facts.length} memories → ${n} observations stored:\n${obs.slice(0, 600)}`;
		} catch (e: any) {
			return `Reflection failed: ${e.message?.slice(0, 100)}`;
		}
	}

	pi.registerTool({
		name: "reflect_memory",
		label: "reflect",
		description:
			"Distill accumulated memories into durable OBSERVATIONS (merged patterns/preferences, not events) and store " +
			"them. Run occasionally after learning several things, or when you notice a recurring pattern worth crystallizing.",
		promptSnippet:
			"reflect_memory(topic?) — distill accumulated memories into durable observations (run after learning several things)",
		parameters: {
			type: "object",
			properties: { topic: { type: "string", description: "optional focus (else all recent)" } },
		},
		async execute(_id: string, params: any) {
			const out = await reflect(params.topic || "");
			// keep the always-on digest current: reflection just crystallized new observations.
			if (DIGEST_ENABLED) {
				const r = await refreshDigest();
				return { content: [{ type: "text", text: `${out}\n\ndigest: ${r.msg}` }] };
			}
			return { content: [{ type: "text", text: out }] };
		},
	});

	pi.registerCommand("memory", {
		description:
			"/memory → review proposed (accept/reject panel) or status; /memory <text> save; /memory undo; /memory digest [--refresh]; /memory reflect [topic] (consolidate now); /memory trend (steering over time)",
		handler: async (args: string, ctx: any) => {
			const typed = (args || "").trim();

			// ── Proposed-memory review: bare `/memory` (or `review`) opens the accept/reject PANEL when
			// there are proposals to act on; otherwise it falls through to status. So: type /memory, Enter
			// → the review UI pops up if pi has proposed anything.
			// Bare /memory (or review/proposed) ALWAYS opens the review panel — even with nothing pending
			// it shows an empty "no proposals" panel, so the command reliably opens a UI (never silent).
			if (typed === "" || typed === "review" || typed === "proposed") {
				await openProposeReview(ctx);
				return;
			}
			if (typed === "yes-all") {
				ctx.ui.notify(await acceptPending(), "info");
				return;
			}
			if (typed === "no-all") {
				ctx.ui.notify(rejectPending(), "info");
				return;
			}
			if (/^yes(\s+\d+)?$/.test(typed)) {
				const n = Number(typed.replace("yes", "").trim()) || undefined;
				ctx.ui.notify(await acceptPending(n), "info");
				return;
			}
			if (/^no(\s+\d+)?$/.test(typed)) {
				const n = Number(typed.replace("no", "").trim()) || undefined;
				ctx.ui.notify(rejectPending(n), "info");
				return;
			}

			if (typed === "reflect" || typed.startsWith("reflect ")) {
				// Manual reflect — same consolidation the compaction trigger runs, on demand (no
				// waiting for a compaction). Optional topic focuses it. Refreshes the digest and
				// resets the accumulated weight so the next auto-reflect doesn't immediately re-fire.
				const topic = typed.replace(/^reflect\s*/, "").trim();
				ctx.ui.notify("Reflecting… (distilling corrections → durable observations)", "info");
				const out = await reflect(topic);
				if (DIGEST_ENABLED) await refreshDigest();
				weightSinceReflect = 0;
				ctx.ui.notify(out, "info");
				return;
			}
			if (typed === "stale" || typed.startsWith("stale ")) {
				// Staleness re-verification loop (KP_MEMORY_STALE_DAYS): surface confirmed/supported
				// claims past a freshness TTL so old preferences/rules get re-checked. Report-only.
				const days = Number(typed.replace(/^stale\s*/, "").trim() || process.env.KP_MEMORY_STALE_DAYS || 180);
				const res = await call("knowledge.stale_claims", { max_age_days: days });
				if (!res) {
					ctx.ui.notify("Staleness check failed (brain unreachable).", "warning");
					return;
				}
				try {
					const claims = (JSON.parse(res).claims ?? JSON.parse(res).stale ?? []) as any[];
					if (!claims.length) {
						ctx.ui.notify(`No memories older than ${days} days need re-verification.`, "info");
						return;
					}
					const lines = claims
						.slice(0, 12)
						.map(
							(c: any) =>
								`  • ${String(c.fact ?? c).slice(0, 70)}${c.age_days ? ` (${Math.round(c.age_days)}d)` : ""}`,
						);
					ctx.ui.notify(
						`${claims.length} memories past ${days}d — re-verify (still true? /memory <restate> or /memory undo):\n${lines.join("\n")}`,
						"info",
					);
				} catch {
					ctx.ui.notify(res.slice(0, 800), "info");
				}
				return;
			}
			if (typed === "trend") {
				// Steering-rate visibility (research: interrupt/override rate ↓ = improving).
				const s = loadState();
				const days = Object.keys(s.trend).sort();
				const recent = days.slice(-7);
				const line = (d: string) => {
					const t = s.trend[d];
					return `  ${d}: ${t.explicit} correction(s)${t.soft ? ` + ${t.soft} soft` : ""}`;
				};
				const clusters = Object.values(s.clusters).sort((a, b) => b.count - a.count);
				const recurring = clusters.filter((c) => c.count >= 2).slice(0, 5);
				const promoted = clusters.filter((c) => c.promoted).length;
				const first = recent.length ? s.trend[recent[0]].explicit + s.trend[recent[0]].soft : 0;
				const last = recent.length
					? s.trend[recent[recent.length - 1]].explicit + s.trend[recent[recent.length - 1]].soft
					: 0;
				const arrow = last < first ? "↓ improving (fewer steers)" : last > first ? "↑ steering rose" : "→ flat";
				ctx.ui.notify(
					`Steering trend (goal: this goes down over time) — ${arrow}\n` +
						(recent.length ? recent.map(line).join("\n") : "  (no steering recorded yet)") +
						"\n" +
						`promoted to always-on: ${promoted} rule(s)\n` +
						(recurring.length
							? `recurring (not yet stuck):\n` +
								recurring.map((c) => `  ${c.count}× ${c.canonical.slice(0, 60)}`).join("\n")
							: "no recurring steers — corrections aren't repeating (good)"),
					"info",
				);
				return;
			}
			if (typed === "digest" || typed.startsWith("digest ")) {
				const wantRefresh = /--refresh\b/.test(typed);
				if (wantRefresh) {
					const r = await refreshDigest();
					ctx.ui.notify(r.ok ? `Digest ${r.msg}.` : `Refresh failed: ${r.msg}`, r.ok ? "info" : "warning");
				}
				const body = readDigest();
				ctx.ui.notify(
					body
						? `${digestPath()}\n(edit this file directly — the ## Pinned section is never auto-overwritten)\n\n${body}`
						: "Digest unreadable.",
					"info",
				);
				return;
			}
			if (typed === "undo" || typed.startsWith("undo ")) {
				// /memory undo      → retract the most recent auto-save
				// /memory undo <n>  → retract the Nth item shown in the widget (a false positive)
				const argN = typed.replace(/^undo\s*/, "").trim();
				let target: Save | null = null;
				if (/^\d+$/.test(argN)) {
					const idx = Number(argN) - 1;
					if (idx >= 0 && idx < recentSaves.length) target = recentSaves[idx];
					else {
						ctx.ui.notify(`No item ${argN} in the recent list (1–${recentSaves.length}).`, "warning");
						return;
					}
				} else if (recentSaves.length) {
					target = recentSaves[recentSaves.length - 1];
				} else if (lastFact) {
					target = { text: lastFact, category: "correction", source: "you", ts: 0 };
				}
				if (!target) {
					ctx.ui.notify("Nothing to undo.", "info");
					return;
				}
				// Non-destructive: supersede the fact rather than hard-delete. When STRUCTURED,
				// route through correct_edge — it finds and invalidates the EXACT contradicted edge
				// (semantic match) rather than the actor's last assertion by recency (knowledge.correct).
				const ok = STRUCTURED
					? await call("knowledge.correct_edge", {
							text: `(retracted) ${target.text}`,
							query: target.text,
							autoconfirm: true,
						})
					: await call("knowledge.correct", {
							text: `[${target.category}] (retracted) ${target.text}`,
							autoconfirm: true,
						});
				// drop it from the widget ring so the false positive disappears from view too.
				const ri = recentSaves.indexOf(target);
				if (ri >= 0) recentSaves.splice(ri, 1);
				if (target.text === lastFact) lastFact = null;
				renderWidget();
				ctx.ui.notify(
					ok !== null
						? `Retracted: ${target.text.slice(0, 50)}${target.text.length > 50 ? "…" : ""}`
						: "Undo failed (brain unreachable)",
					ok !== null ? "info" : "warning",
				);
				return;
			}
			if (typed) {
				const ok = await store("correction", typed, AUTOCONFIRM);
				if (ok) {
					lastFact = typed;
					if (LOCAL) void syncSnapshot();
				}
				ctx.ui.notify(ok ? `Saved: ${typed}` : "Not saved (empty/secret/brain down)", ok ? "info" : "warning");
				return;
			}
			const corrections = await recallFacts("", "correction");
			// KP caps search at ~20, so this is a SAMPLE not a true count on a large brain — label it honestly.
			const corrCount = corrections.length >= 20 ? "20+" : String(corrections.length);
			ctx.ui.notify(
				`Memory (via KP brain) — this session: ${stats.corrections} corrections saved, ${stats.recalls} surfaced/recalled\n` +
					`standing corrections in brain: ${corrCount} (sampled) · surfaced this session: ${surfacedThisSession.size}\n` +
					`quality: KP does write-time fact extraction + cross-encoder reranked retrieval + non-destructive supersede\n` +
					`recall: PROACTIVE (${PROACTIVE ? "on" : "off"}) — relevant corrections auto-surface per turn (threshold ${SURFACE_MIN_SCORE}, top ${SURFACE_MAX}, cache-safe) + pull via recall_memory\n` +
					`turn-path matching: ${LOCAL ? `LOCAL snapshot (${readSnapshot().length} typed memories, ${snapshotPath()}) — same-turn, no KP on the hot path` : "KP cross-encoder (KP_MEMORY_LOCAL=0)"}\n` +
					`always-on digest (${DIGEST_ENABLED ? "on" : "off"}): ${digestPath()} — see/edit via /memory digest [--refresh]\n` +
					`self-improvement (${SELFIMPROVE ? "on" : "off"}): recurring steers auto-promote to always-on at ${PROMOTE_AT}× · auto-reflect at session end · see /memory trend`,
				"info",
			);
		},
	});

	// AUTO-REFLECT at COMPACTION, not session end. Reasoning: session_shutdown has no
	// emit timeout and is SKIPPED on signal-exit (interactive-mode.ts) — a ~90s codex-exec
	// reflect there would either hang your quit or never run. Compaction is the right
	// boundary: it's a natural "a chunk of work is done, consolidate now" point, it runs
	// IN-session (no exit hang), and it fires exactly when enough has accumulated — which is
	// the Generative-Agents trigger (reflect on accumulated weight, not a fixed count).
	// We gate on the same importance weight (corrections*2 + soft ≥ REFLECT_WEIGHT) so we
	// don't reflect on trivial compactions, skip `overflow` (mid-turn emergency recovery
	// with willRetry — worst time to shell out), and run it in the BACKGROUND so compaction
	// itself never waits on the reflect. Best-effort; resets the weight after a reflect.
	pi.on("session_compact", (event: any) => {
		if (!SELFIMPROVE) return;
		if (event?.reason === "overflow" || event?.willRetry) return; // emergency recovery — don't
		if (weightSinceReflect < REFLECT_WEIGHT) return; // not enough accumulated
		weightSinceReflect = 0;
		void (async () => {
			try {
				await reflect(""); // distill accumulated corrections → observations
				if (DIGEST_ENABLED) await refreshDigest(); // fold them into the always-on digest
			} catch {}
		})();
	});

	pi.on("session_shutdown", async () => {
		await client?.close().catch(() => {});
		client = null;
	});
}
