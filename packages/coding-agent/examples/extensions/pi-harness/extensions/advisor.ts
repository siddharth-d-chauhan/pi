/**
 * advisor.ts — opt-in second-model live reviewer (adopted from oh-my-pi).
 *
 * When KP_ADVISOR=1, after each turn the delta (the assistant message + this
 * turn's tool results) is handed to a CHEAP reviewer model running in an
 * ISOLATED pi subprocess (same invocation shape as review.ts). The reviewer is
 * instructed to stay silent unless it sees a real concern or blocker; when it
 * does, exactly ONE bounded, deduped note is injected into the NEXT turn via a
 * cache-safe trailing `context` message. It never blocks the turn — the review
 * runs in the background and the note lands on a subsequent turn.
 *
 * The EmissionGuard is what makes a live second reviewer tolerable: it
 * normalizes advice, drops content-free / LGTM chatter, FIFO-dedupes against
 * recently-emitted notes, and enforces one-note-per-turn. Without it a chatty
 * reviewer would flood the conversation and destroy signal.
 *
 * Optional REVIEW.md / WATCHDOG.md (repo root or .pi/) supplies review
 * priorities — these are fed to the REVIEWER only, never injected verbatim into
 * the main conversation.
 *
 * Config:
 *   KP_ADVISOR=1                 enable (off by default; it adds cost)
 *   KP_ADVISOR_MODEL             reviewer model (default a cheap one)
 *   KP_ADVISOR_DELTA_MAX         max chars of delta fed to reviewer (default 24000)
 *   KP_ADVISOR_DEDUPE            FIFO dedupe window size (default 12)
 *   KP_CHAIN_PI / KP_CHAIN_DEFAULT_PROVIDER   (shared with review.ts)
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const ENABLED = process.env.KP_ADVISOR === "1";
const ADVISOR_MODEL = process.env.KP_ADVISOR_MODEL || "gpt-5.5-mini";
const DELTA_MAX = Number(process.env.KP_ADVISOR_DELTA_MAX || 24_000);
const DEDUPE_WINDOW = Number(process.env.KP_ADVISOR_DEDUPE || 12);
const PI_BIN = process.env.KP_CHAIN_PI || "pi";
const DEFAULT_PROVIDER = process.env.KP_CHAIN_DEFAULT_PROVIDER || "openai-codex";

function qualifyModel(m: string): string {
	if (!m) return "";
	if (m.includes("/")) return m;
	if (/^claude-/.test(m)) return `harness-sdk/${m}`;
	return `${DEFAULT_PROVIDER}/${m}`;
}

/** Read review priorities from REVIEW.md / WATCHDOG.md (repo root or .pi/). Reviewer-only. */
function loadPriorities(cwd: string): string {
	for (const rel of ["REVIEW.md", "WATCHDOG.md", join(".pi", "REVIEW.md"), join(".pi", "WATCHDOG.md")]) {
		const p = join(cwd, rel);
		try {
			if (existsSync(p)) {
				const t = readFileSync(p, "utf-8").trim();
				if (t) return t.slice(0, 8_000);
			}
		} catch {}
	}
	return "";
}

/** Flatten a turn's message + toolResults into the reviewable delta text. */
function extractDelta(message: any, toolResults: any[]): string {
	const parts: string[] = [];
	const blocks = Array.isArray(message?.content) ? message.content : [];
	for (const b of blocks) {
		if (b.type === "text" && b.text?.trim()) parts.push(`[assistant said]\n${b.text}`);
		if (b.type === "toolCall")
			parts.push(`[assistant called ${b.name}]\n${JSON.stringify(b.arguments ?? {}).slice(0, 2_000)}`);
	}
	for (const tr of toolResults ?? []) {
		const text = (Array.isArray(tr?.content) ? tr.content : [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		if (text.trim()) parts.push(`[result of ${tr.toolName ?? "tool"}]\n${text.slice(0, 4_000)}`);
	}
	const joined = parts.join("\n\n");
	return joined.length <= DELTA_MAX
		? joined
		: `${joined.slice(0, DELTA_MAX)}\n\n[…delta truncated at ${DELTA_MAX} chars]`;
}

const ADVISOR_PROMPT = (delta: string, priorities: string) =>
	`You are a terse background code advisor watching an agent work turn-by-turn. You see ONLY the ` +
	`latest turn's delta (what the agent just said + did). Your job: catch REAL problems early — ` +
	`a bug being introduced, a wrong assumption, a security/data-loss risk, a drift from the task.\n\n` +
	`STRICT OUTPUT CONTRACT:\n` +
	`- If there is NOTHING at concern-or-blocker severity, output exactly: OK\n` +
	`- Otherwise output ONE line: "<SEVERITY>: <specific, actionable concern>" where SEVERITY is ` +
	`CONCERN or BLOCKER. No preamble, no praise, no "looks good", no restating what they did. ` +
	`Be specific enough to act on. One concern only — the most important.\n` +
	(priorities ? `\nREVIEW PRIORITIES (weight these):\n${priorities}\n` : "") +
	`\n### TURN DELTA\n${delta}`;

/** Run the reviewer in an isolated pi subprocess (same shape as review.ts). Non-blocking caller. */
function runAdvisor(prompt: string, cwd: string, signal?: AbortSignal): Promise<string> {
	return new Promise((res) => {
		const args = ["-p", "--mode", "json", "--no-session"];
		const m = qualifyModel(ADVISOR_MODEL);
		if (m) args.push("--model", m);
		args.push(prompt);
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(PI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return res("");
		}
		let text = "",
			buf = "";
		const timer = setTimeout(() => proc.kill(), 120_000);
		const onAbort = () => proc.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
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
		const finish = (v: string) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			res(v);
		};
		proc.on("close", () => finish(text));
		proc.on("error", () => finish(""));
	});
}

/**
 * EmissionGuard — the discipline that makes a live reviewer tolerable.
 * normalize → drop content-free/LGTM → FIFO-dedupe → one-note-per-turn.
 */
class EmissionGuard {
	private recent: string[] = [];
	private readonly window: number;
	constructor(window: number) {
		this.window = Math.max(1, window);
	}

	private static readonly EMPTY = /^(ok|lgtm|looks good|no concerns?|nothing|n\/?a|none|all good|fine|clear)\.?$/i;

	/** Normalize for comparison: strip severity tag, punctuation, collapse whitespace, lowercase. */
	private normKey(s: string): string {
		return s
			.replace(/^\s*(concern|blocker)\s*:\s*/i, "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	/** Returns the note to emit, or null to stay silent. */
	admit(raw: string): string | null {
		if (!raw) return null;
		// take first non-empty line only (contract is one line)
		const line =
			raw
				.split("\n")
				.map((l) => l.trim())
				.find(Boolean) ?? "";
		if (!line) return null;
		const bare = line.replace(/^\s*(concern|blocker)\s*:\s*/i, "").trim();
		if (!bare || EmissionGuard.EMPTY.test(bare)) return null; // content-free / LGTM
		const key = this.normKey(line);
		if (!key || this.recent.includes(key)) return null; // FIFO dedupe
		this.recent.push(key);
		while (this.recent.length > this.window) this.recent.shift();
		// enforce a severity tag so the injected note reads consistently
		const hasTag = /^\s*(concern|blocker)\s*:/i.test(line);
		return hasTag ? line : `CONCERN: ${line}`;
	}
}

export default function (pi: any) {
	if (!ENABLED) return; // opt-in only; zero footprint otherwise

	const guard = new EmissionGuard(DEDUPE_WINDOW);
	let priorities: string | null = null; // lazily loaded once
	let inflight: AbortController | null = null;
	const accepted: string[] = []; // admitted notes, append-only; re-emitted whole every turn (cache-safe)

	pi.on("turn_end", async (event: any) => {
		try {
			const cwd = process.cwd();
			if (priorities === null) priorities = loadPriorities(cwd);
			const delta = extractDelta(event?.message, event?.toolResults);
			if (!delta.trim()) return;

			// one review at a time — cancel a stale in-flight review, the newest turn wins
			if (inflight) inflight.abort();
			inflight = new AbortController();
			const sig = inflight.signal;

			const raw = await runAdvisor(ADVISOR_PROMPT(delta, priorities), cwd, sig);
			if (sig.aborted) return;
			const note = guard.admit(raw);
			if (note) accepted.push(note); // append-only; never removed (see cache note below)
		} catch {
			// advisory: never let a reviewer failure disturb the main loop
		}
	});

	// Inject the advisor notes cache-safely. KV-cache discipline (mirrors memory.ts):
	// transformContext runs on a throwaway clone, so a note injected then DROPPED next turn
	// is the drain-and-refill anti-pattern — the tail bytes change on a turn where nothing
	// relevant happened, busting the prefix. Instead `accepted` is APPEND-ONLY: we re-emit
	// the WHOLE list every turn in stable order, byte-identical while unchanged, only ever
	// extended when a new note is admitted. The EmissionGuard's dedupe already bounds growth.
	pi.on("context", async (event: any) => {
		const messages = event?.messages;
		if (!Array.isArray(messages) || !accepted.length) return;
		const body = accepted.map((n) => `- ${n}`).join("\n");
		return {
			messages: [
				...messages,
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `## Advisor notes (background reviewer — advisory, verify before acting):\n${body}`,
						},
					],
				},
			],
		};
	});

	pi.registerCommand("advisor", {
		description: "Show background advisor status (KP_ADVISOR live second-model reviewer)",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(
				`Advisor: ENABLED · model=${ADVISOR_MODEL} · notes=${accepted.length} · ` +
					`priorities=${priorities ? "loaded" : "none"}`,
				"info",
			);
		},
	});
}
