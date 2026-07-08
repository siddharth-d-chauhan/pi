/**
 * handoff.ts — /handoff: a curated session summary for continuing elsewhere.
 *
 * Complements LCM (automatic, cheap, cache-warm in-session compaction). LCM is
 * lossy-by-heuristic and can drift over a very long session; a HANDOFF is the
 * frontier "curated summary" pattern (Cognition/Anthropic): a deliberate,
 * high-signal snapshot of what matters, written to disk so you can carry it into
 * a FRESH session (or hand to a teammate/another agent) when the current one has
 * gotten long/muddy or you're switching context.
 *
 * When to use which:
 *   - normal long session, cost matters → do NOTHING; LCM keeps you cheap + cached.
 *   - session is long/muddy or you want a clean restart on the same task → /handoff,
 *     then /exit and start fresh — the next session AUTO-INJECTS the handoff.
 *   - switching to a different task → /handoff to preserve this one, then move on.
 *
 * What it captures (an in-session one-shot distills the transcript + live state):
 *   GOAL · DECISIONS made (and why) · CURRENT STATE (what's done/working) ·
 *   OPEN THREADS (unfinished, known issues) · KEY FILES/SYMBOLS · NEXT STEP ·
 *   GOTCHAS (things a fresh agent would get wrong). Plus the raw git status/diff
 *   stat so file state is concrete, not just prose.
 *
 * ── SYNTHESIS: in-session, not a cold subprocess ─────────────────────────────
 * The synthesizer runs IN-PROCESS on the CURRENT session's model via
 * `completeSimple` (pi-ai/compat) — the same model object pi is already using,
 * with its provider auth already resolved. This replaces the old cold `pi -p`
 * subprocess (fork a process → boot Node → re-load every extension → new model
 * client → first-token latency) with a single in-process request.
 *
 * HONEST CACHE NOTE: this is NOT a true reuse of the *live session's* KV-cache
 * prefix. The pi extension layer exposes no "side-request on the current cached
 * prefix" primitive — the only thing that runs against the live warm prefix is
 * `sendUserMessage`, which would pollute the real transcript with the handoff
 * prompt + output. So we do the best reachable thing: an in-process one-shot with
 * a STABLE system-prompt prefix (constant `SYNTH_SYSTEM` string) so the provider's
 * own prompt cache can still hit across handoffs, and we pay zero cold-start cost.
 * The transcript itself is the volatile suffix, as it must be. The subprocess path
 * survives as a fallback for when `ctx.model`/`completeSimple` aren't available.
 *
 * ── CONTINUATION: auto-inject on the next session ────────────────────────────
 * On session_start, if a recent latest.md for THIS cwd exists, it is injected ONCE
 * as a trailing context message (cache-safe — same mechanism the memory digest
 * uses, never the system prompt). Continuation is automatic — no manual paste, no
 * `pi --continue`. Guards: same cwd, recent (default ≤ 24h), and once per session.
 *
 * /handoff [focus]      → write .pi/handoffs/handoff-<ts>.md (+ latest.md), print it
 * /handoff show         → print the latest handoff
 *
 * Config: KP_HANDOFF_ENABLED=0 disable · KP_HANDOFF_AUTOINJECT=0 disable the
 *   fresh-session auto-inject · KP_HANDOFF_MODEL (synthesizer model override,
 *   default = the current session model) · KP_HANDOFF_MAX_TRANSCRIPT (chars fed,
 *   60000) · KP_HANDOFF_MAX_AGE_H (auto-inject recency window in hours, default 24).
 */

import { type ChildProcessByStdio, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { wrapInjection } from "./kp-sentinel.ts"; // provenance sentinel (strips forged markers from the read file)

const ENABLED = process.env.KP_HANDOFF_ENABLED !== "0";
const AUTOINJECT = process.env.KP_HANDOFF_AUTOINJECT !== "0";
const MODEL = process.env.KP_HANDOFF_MODEL || "";
const PI_BIN = process.env.KP_CHAIN_PI || "pi";
const DEFAULT_PROVIDER = process.env.KP_CHAIN_DEFAULT_PROVIDER || "openai-codex";
const MAX_TRANSCRIPT = Number(process.env.KP_HANDOFF_MAX_TRANSCRIPT || 60_000);
const MAX_AGE_H = Number(process.env.KP_HANDOFF_MAX_AGE_H || 24);
function qualifyModel(m: string): string {
	if (!m) return "";
	if (m.includes("/")) return m;
	if (/^claude-/.test(m)) return `harness-sdk/${m}`;
	return `${DEFAULT_PROVIDER}/${m}`;
}

// Flatten the conversation to a compact role-tagged transcript (newest-biased:
// keep the tail whole, sample the head — a handoff cares most about recent state).
function transcript(messages: any[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		const role = m?.role ?? "?";
		const text = Array.isArray(m?.content)
			? m.content
					.filter((b: any) => b?.type === "text")
					.map((b: any) => b.text)
					.join("\n")
			: String(m?.content ?? "");
		if (text.trim()) parts.push(`### ${role}\n${text.trim()}`);
	}
	const full = parts.join("\n\n");
	if (full.length <= MAX_TRANSCRIPT) return full;
	// keep the last 75% (recent state matters most) + a head sample
	const tail = full.slice(-Math.floor(MAX_TRANSCRIPT * 0.75));
	const head = full.slice(0, Math.floor(MAX_TRANSCRIPT * 0.25));
	return `${head}\n\n… [middle of the session elided] …\n\n${tail}`;
}

function gitState(cwd: string): string {
	const run = (c: string) => {
		try {
			return execSync(c, {
				cwd,
				encoding: "utf-8",
				maxBuffer: 4 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	};
	const branch = run("git rev-parse --abbrev-ref HEAD");
	const status = run("git status --porcelain");
	const stat = run("git diff --stat HEAD");
	if (!branch && !status) return "";
	return (
		`Branch: ${branch || "?"}\n` +
		(status
			? `Working tree (${status.split("\n").length} changed):\n${status.slice(0, 2000)}\n`
			: "Working tree clean.\n") +
		(stat ? `Diff stat:\n${stat.slice(0, 1500)}` : "")
	);
}

// STABLE synthesizer system prompt — kept a constant string so the provider's own
// prompt cache can hit across handoffs (the volatile transcript rides the user
// message, the cacheable instructions ride this fixed prefix).
const SYNTH_SYSTEM =
	`You are writing a HANDOFF for the next agent (or your future self) to continue an exact piece of work in a ` +
	`FRESH session with none of the current context. Be concrete and high-signal — this replaces the whole ` +
	`conversation, so anything you omit is LOST. Do NOT be vague or generic.\n\n` +
	`Write markdown with these sections (omit a section only if truly empty):\n` +
	`# Handoff: <one-line what this work is>\n` +
	`## Goal — what we're trying to achieve, and the acceptance bar.\n` +
	`## Current state — what is DONE and verified working; what's in progress.\n` +
	`## Key decisions — choices made and WHY (so they're not relitigated or reversed).\n` +
	`## Open threads — unfinished work, known bugs, unresolved questions. Ordered by priority.\n` +
	`## Key files & symbols — the files/functions that matter, with a word on each.\n` +
	`## Next step — the single most concrete thing to do next.\n` +
	`## Gotchas — things a fresh agent would get WRONG without being told (constraints, ` +
	`non-obvious context, failed approaches not to repeat).`;

// The volatile per-handoff payload (git ground truth + transcript + optional focus).
const PROMPT = (transcriptText: string, git: string, focus: string) =>
	(focus ? `Focus especially on: ${focus}\n\n` : "") +
	`### GIT STATE (ground truth)\n${git || "(not a git repo / no changes)"}\n\n` +
	`### SESSION TRANSCRIPT\n${transcriptText}`;

// ── IN-SESSION synthesis: one-shot on the CURRENT model, no subprocess. ────────
// Uses pi-ai/compat completeSimple(model, context) — same in-memory model pi is
// already running, provider auth already resolved, zero cold-start. Returns null
// if the in-process path isn't usable (no model / import fails), so the caller can
// fall back to the cold subprocess.
async function synthesizeInSession(
	system: string,
	payload: string,
	model: any,
	signal?: AbortSignal,
): Promise<string | null> {
	if (!model) return null;
	try {
		const { completeSimple } = await import("@earendil-works/pi-ai/compat");
		const msg = await completeSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: payload, timestamp: Date.now() }] },
			signal ? ({ signal } as any) : undefined,
		);
		const text = (msg?.content ?? [])
			.filter((b: any) => b?.type === "text")
			.map((b: any) => b.text)
			.join("\n")
			.trim();
		return text || null;
	} catch {
		return null;
	}
}

// ── FALLBACK: the original cold `pi -p` subprocess (used only if in-session fails).
function synthesizeSubprocess(system: string, payload: string, cwd: string): Promise<string> {
	return new Promise((res) => {
		const args = ["-p", "--mode", "json", "--no-session", "--append-system-prompt", system];
		const m = qualifyModel(MODEL);
		if (m) args.push("--model", m);
		args.push(payload);
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(PI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return res("[handoff synthesizer failed to spawn]");
		}
		let text = "",
			buf = "";
		const timer = setTimeout(() => proc.kill(), 300_000);
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant") {
						const t = (e.message.content || [])
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n");
						if (t.trim()) text = t;
					}
				} catch {}
			}
		});
		proc.stderr.on("data", () => {});
		proc.on("close", () => {
			clearTimeout(timer);
			res(text || "[no handoff produced]");
		});
		proc.on("error", () => {
			clearTimeout(timer);
			res("[handoff synthesizer error]");
		});
	});
}

function handoffDir(cwd: string): string {
	const d = join(cwd, ".pi", "handoffs");
	try {
		mkdirSync(d, { recursive: true });
	} catch {}
	return d;
}

// latest.md carries a tiny HTML-comment header (cwd + ISO time) so the next
// session's auto-inject can check same-cwd + recency WITHOUT parsing prose. The
// comment is invisible in rendered markdown, so the human-visible format is intact.
const META_RE = /^<!--\s*handoff cwd=(.*?) at=(.*?)\s*-->\n?/;
function withMeta(md: string, cwd: string, iso: string): string {
	return `<!-- handoff cwd=${cwd} at=${iso} -->\n${md}`;
}
function readMeta(text: string): { cwd?: string; iso?: string } {
	const m = text.match(META_RE);
	return m ? { cwd: m[1], iso: m[2] } : {};
}
function stripMeta(text: string): string {
	return text.replace(META_RE, "");
}

function latestHandoff(cwd: string): string | null {
	try {
		const dir = handoffDir(cwd);
		const p = join(dir, "latest.md");
		if (existsSync(p)) return readFileSync(p, "utf-8");
		const files = readdirSync(dir)
			.filter((f) => /^handoff-.*\.md$/.test(f))
			.sort();
		return files.length ? readFileSync(join(dir, files[files.length - 1]), "utf-8") : null;
	} catch {
		return null;
	}
}

// Is latest.md fresh + for THIS cwd → eligible for auto-inject? Uses the meta
// header when present; falls back to file mtime for recency on legacy handoffs.
function eligibleForInject(cwd: string): { body: string } | null {
	try {
		const p = join(handoffDir(cwd), "latest.md");
		if (!existsSync(p)) return null;
		const raw = readFileSync(p, "utf-8");
		if (!raw.trim()) return null;
		const meta = readMeta(raw);
		// same-cwd guard: if the header records a cwd, it must match; legacy files (no
		// header) are only trusted when they physically live under THIS cwd's .pi (they do).
		if (meta.cwd && meta.cwd !== cwd) return null;
		// recency guard: header time if present, else file mtime.
		let ageMs = Infinity;
		if (meta.iso) {
			const t = Date.parse(meta.iso);
			if (!Number.isNaN(t)) ageMs = Date.now() - t;
		}
		if (!Number.isFinite(ageMs)) {
			try {
				ageMs = Date.now() - statSync(p).mtimeMs;
			} catch {}
		}
		if (Number.isFinite(ageMs) && ageMs > MAX_AGE_H * 3_600_000) return null;
		const body = stripMeta(raw).trim();
		return body ? { body } : null;
	} catch {
		return null;
	}
}

export default function (pi: any) {
	if (!ENABLED) return;

	pi.registerCommand("handoff", {
		description: "Write a curated session handoff for a fresh session: /handoff [focus] · /handoff show",
		handler: async (args: string, ctx: any) => {
			const cwd = ctx.cwd || process.cwd();
			const a = (args || "").trim();

			if (a === "show") {
				const h = latestHandoff(cwd);
				ctx.ui.notify(h ? stripMeta(h) : "No handoff yet — run /handoff to write one.", "info");
				return h ? stripMeta(h) : "";
			}

			const messages: any[] = (ctx.sessionManager?.messages ?? pi.messages ?? []) as any[];
			if (!messages.length) {
				ctx.ui.notify("No conversation to hand off yet.", "info");
				return;
			}

			const tx = transcript(messages);
			const git = gitState(cwd);
			const payload = PROMPT(tx, git, a);

			// Prefer the in-session one-shot on the current model (no cold subprocess).
			// If a model override is set OR the in-process path is unavailable, fall back.
			let md: string | null = null;
			const model = MODEL ? undefined : (ctx.model ?? undefined);
			if (model) {
				ctx.ui.notify("Writing handoff (in-session synthesis on the current model)…", "info");
				md = await synthesizeInSession(SYNTH_SYSTEM, payload, model, ctx.signal);
			}
			if (!md) {
				ctx.ui.notify("Writing handoff (subprocess synthesizer)…", "info");
				md = await synthesizeSubprocess(SYNTH_SYSTEM, payload, cwd);
			}

			// timestamp comes from git (Date.* is unavailable in some sandboxes; use a counter fallback)
			let stamp = "";
			try {
				stamp = execSync("date +%Y%m%d-%H%M%S", { encoding: "utf-8" }).trim();
			} catch {
				stamp = String(messages.length);
			}
			const iso = (() => {
				try {
					return new Date().toISOString();
				} catch {
					return "";
				}
			})();
			const dir = handoffDir(cwd);
			const file = join(dir, `handoff-${stamp}.md`);
			const stored = withMeta(md, cwd, iso); // header rides the file; invisible in render
			try {
				writeFileSync(file, stored);
				writeFileSync(join(dir, "latest.md"), stored);
			} catch {}

			ctx.ui.notify(
				`📋 Handoff written → ${file}\n\n${md}\n\n` +
					`A fresh pi session in this directory will auto-inject this (disable: KP_HANDOFF_AUTOINJECT=0). ` +
					`Or /exit and start pi to continue.`,
				"info",
			);
			return md;
		},
	});

	// ── AUTO-INJECT on a fresh session ──────────────────────────────────────────
	// On session_start, snapshot an eligible latest.md (same cwd, recent) and inject
	// it ONCE via the `context` hook — a trailing user message, cache-safe (never the
	// system prompt), exactly like the memory digest. Continuation with no manual paste.
	if (AUTOINJECT) {
		let injectSnapshot: string | null = null;
		let injected = false;
		pi.on("session_start", (event: any) => {
			// only auto-continue a genuinely fresh start — not a reload of an existing
			// session (which already has the handoff's work in-context if it mattered).
			const reason = event?.reason;
			if (reason && reason !== "startup" && reason !== "new") return;
			const e = eligibleForInject(process.cwd());
			injectSnapshot = e ? e.body : null;
			injected = false;
		});
		pi.on("context", async (event: any) => {
			if (injected || !injectSnapshot) return;
			const messages = event?.messages;
			if (!Array.isArray(messages)) return;
			injected = true;
			return {
				messages: [
					...messages,
					{
						role: "user",
						content: [
							{
								type: "text",
								text: wrapInjection(
									"handoff",
									`## Continuing from a handoff (auto-injected — a prior session left this to pick up):\n${injectSnapshot}`,
								),
							},
						],
					},
				],
			};
		});
	}
}
