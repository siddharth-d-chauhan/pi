/**
 * Self-Optimize — the agent learns standing preferences from YOU correcting it.
 *
 * Same journal→distill→promote→measure engine as the loop optimizer, but the
 * failure signal is a user correction and the mutable surface is the agent's
 * own standing instructions.
 *
 *   (automatic)         a user message that looks like a correction is journaled
 *   /self note <lesson> record a lesson explicitly (high precision)
 *   /self optimize      show recurring corrections distilled into candidates
 *                       (semantic clustering via the KP embedder, keyword fallback)
 *   /self optimize apply promote candidates into standing instructions (versioned)
 *   /self                show active standing instructions
 *   /self forget <n>     drop standing instruction n
 *
 * SAFETY: detection only produces CANDIDATES — it never changes behavior. Only
 * `apply` (a human action) promotes, and a promoted instruction is injected as
 * a clearly-labeled, byte-stable context block the user can inspect and forget.
 * A lesson must recur across DISTINCT sessions (an explicit /self note counts
 * once), so a one-off preference never becomes a standing rule.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { copper, heatLine } from "./lib/card.ts";
import {
	type CorrectionProposal,
	type CorrectionRecord,
	distillCorrections,
	distillCorrectionsSemantic,
	parseJournal,
	type StandingInstruction,
} from "./lib/correction-optimizer.ts";

const MIN_SESSIONS = Math.max(2, Number(process.env.PI_SELF_MIN_SESSIONS ?? 2));
// Measured on live bge-small vectors (10 pairs): lowest same-lesson cosine
// 0.681, highest different-lesson 0.639 — 0.66 is the midpoint. Recall-biased
// on purpose: a false merge still needs distinct sessions + human `apply`
// (samples shown), while a false split hides a real lesson forever.
const SEMANTIC_THRESHOLD = Number(process.env.PI_SELF_COSINE ?? 0.66);
const KP_EMBED_TIMEOUT_MS = Number(process.env.PI_KP_EMBED_TIMEOUT_MS ?? 8_000);

interface KpShared {
	connect: () => Promise<{
		callTool: (
			req: { name: string; arguments: Record<string, unknown> },
			schema?: undefined,
			opts?: { timeout?: number },
		) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
	}>;
	timeoutMs: number;
}

/** Embed texts through the shared KP client (bge-small). Returns undefined when
 *  KP is unavailable or the count doesn't round-trip — the caller then falls
 *  back to keyword clustering. */
async function embedViaKp(texts: string[]): Promise<number[][] | undefined> {
	const shared = (globalThis as Record<string, unknown>).__pi_kp__ as KpShared | undefined;
	if (!shared || texts.length === 0) return undefined;
	try {
		const client = await shared.connect();
		const result = await client.callTool({ name: "pi.embed_texts", arguments: { texts } }, undefined, {
			timeout: KP_EMBED_TIMEOUT_MS,
		});
		if (result.isError) return undefined;
		const raw = result.content?.find((c) => c.type === "text")?.text;
		if (!raw) return undefined;
		const parsed = JSON.parse(raw) as { vectors?: number[][] };
		const vectors = parsed.vectors;
		if (
			!Array.isArray(vectors) ||
			vectors.length !== texts.length ||
			vectors.some((v) => !Array.isArray(v) || v.length === 0)
		) {
			return undefined;
		}
		return vectors;
	} catch {
		return undefined;
	}
}

// Heuristic correction detectors. Deliberately recall-biased: false positives
// are harmless (they only become candidates, gated by recurrence + apply).
const CORRECTION_RES: RegExp[] = [
	/^\s*(no|nope|nah|stop|wrong|actually)\b/i,
	/\b(that'?s wrong|not what i (?:said|asked|meant|wanted)|i (?:said|asked|told you)|why did you|you (?:should|shouldn'?t|keep|always|never|need to)|don'?t (?:do|use|add|include|ever|keep)|instead of|stop (?:doing|using|trying|adding))\b/i,
];

function looksLikeCorrection(text: string): boolean {
	const t = text.trim();
	if (t.length < 3 || t.length > 600) return false;
	if (t.startsWith("/")) return false; // slash commands are not corrections
	return CORRECTION_RES.some((re) => re.test(t));
}

interface Paths {
	dir: string;
	journal: string;
	standing: string;
}
function paths(): Paths {
	const dir = join(getAgentDir(), "self");
	return { dir, journal: join(dir, "corrections.jsonl"), standing: join(dir, "standing-instructions.json") };
}

function loadStanding(): StandingInstruction[] {
	try {
		const parsed = JSON.parse(readFileSync(paths().standing, "utf-8"));
		if (Array.isArray(parsed)) return parsed.filter((s) => s && typeof s.text === "string");
	} catch {
		// none yet
	}
	return [];
}
function loadJournal(): CorrectionRecord[] {
	try {
		return parseJournal(readFileSync(paths().journal, "utf-8"));
	} catch {
		return [];
	}
}
function currentVersion(steps: StandingInstruction[]): number {
	return steps.reduce((m, s) => Math.max(m, s.version ?? 1), 1);
}

/** The byte-stable block injected into context so promoted preferences are
 *  honored every turn (KV-cache friendly: identical until the set changes). */
function standingBlock(steps: StandingInstruction[]): string {
	const lines = [
		"<learned-preferences>",
		"Standing preferences learned from the user's past corrections. Honor them:",
	];
	steps.forEach((s, i) => {
		lines.push(`${i + 1}. ${s.text}`);
	});
	lines.push("</learned-preferences>");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	// Per-process = per-session id (distinct-session counting) + in-session dedup.
	// Random suffix so two sessions launched in the same millisecond never
	// collide into one "session" (which would defeat cross-session recurrence).
	const sessionId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const journaledThisSession = new Set<string>();

	const record = (text: string, source: CorrectionRecord["source"]): void => {
		const key = text.trim().toLowerCase();
		if (journaledThisSession.has(key)) return;
		journaledThisSession.add(key);
		const rec: CorrectionRecord = { session: sessionId, text: text.trim().slice(0, 600), source };
		try {
			mkdirSync(paths().dir, { recursive: true });
			appendFileSync(paths().journal, `${JSON.stringify(rec)}\n`);
		} catch {
			// journal is best-effort
		}
	};

	// Detection: a user prompt that looks like a correction is journaled as a
	// candidate. This changes NOTHING about the current turn.
	pi.on("before_agent_start", async (event) => {
		if (typeof event.prompt === "string" && looksLikeCorrection(event.prompt)) {
			record(event.prompt, "heuristic");
		}
	});

	// Injection: append the active standing preferences as a stable context block.
	pi.on("context", async (event) => {
		const steps = loadStanding();
		if (steps.length === 0) return;
		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		return {
			messages: [
				...messages,
				{ role: "user", content: [{ type: "text", text: standingBlock(steps) }], timestamp: Date.now() },
			],
		};
	});

	const optimize = async (
		apply: boolean,
		notify: (t: string, l: "info" | "warning" | "error") => void,
	): Promise<void> => {
		const records = loadJournal();
		if (records.length === 0) {
			notify(
				"no corrections recorded yet — I journal messages that look like corrections; /self note <lesson> to add one",
				"info",
			);
			return;
		}
		const existing = loadStanding();
		// Prefer semantic clustering (KP embedder) so paraphrases group even with
		// no shared words; fall back to keyword clustering if KP is unavailable.
		let mode: "semantic" | "keyword" = "keyword";
		let proposals: CorrectionProposal[];
		const vectors = await embedViaKp([...records.map((r) => r.text), ...existing.map((e) => e.text)]);
		if (vectors) {
			mode = "semantic";
			const recVecs = vectors.slice(0, records.length);
			const exVecs = vectors.slice(records.length);
			proposals = distillCorrectionsSemantic(records, recVecs, exVecs, MIN_SESSIONS, SEMANTIC_THRESHOLD);
		} else {
			proposals = distillCorrections(records, existing, MIN_SESSIONS);
		}
		let applied: CorrectionProposal[] = [];
		if (apply && proposals.length > 0) {
			const version = currentVersion(existing) + 1;
			const promoted: StandingInstruction[] = [
				...existing,
				...proposals.map((p) => ({ text: p.text, sessions: p.sessions, version })),
			];
			try {
				mkdirSync(paths().dir, { recursive: true });
				writeFileSync(paths().standing, `${JSON.stringify(promoted, null, 2)}\n`);
				applied = proposals;
				notify(`self-optimize: promoted ${proposals.length} standing preference(s) (v${version})`, "info");
			} catch {
				notify("self-optimize: failed to write standing-instructions.json", "error");
			}
		}
		pi.sendMessage(
			{
				customType: "self-optimize",
				content: "self-optimize",
				display: true,
				details: {
					totalCorrections: records.length,
					distinctSessions: new Set(records.map((r) => r.session)).size,
					minSessions: MIN_SESSIONS,
					mode,
					proposals: applied.length > 0 ? [] : proposals,
					applied,
					standing: existing.map((s) => ({ text: s.text, sessions: s.sessions, version: s.version })),
				},
			},
			{ triggerTurn: false },
		);
	};

	pi.registerMessageRenderer<{
		totalCorrections?: number;
		distinctSessions?: number;
		minSessions?: number;
		mode?: "semantic" | "keyword";
		proposals?: CorrectionProposal[];
		applied?: CorrectionProposal[];
		standing?: StandingInstruction[];
	}>("self-optimize", (message, _options, theme) => {
		const d = message.details ?? {};
		const lines: string[] = [];
		lines.push(
			`${copper("▎")} ⚙ ${theme.fg("text", "self-optimize")} · ${theme.fg("muted", `${d.totalCorrections ?? 0} corrections across ${d.distinctSessions ?? 0} sessions · promote ≥${d.minSessions ?? 2} · ${d.mode ?? "keyword"} clustering`)}`,
		);
		lines.push(heatLine(46));
		const applied = d.applied ?? [];
		const proposals = d.proposals ?? [];
		if (applied.length > 0) {
			lines.push(theme.fg("success", `✓ promoted ${applied.length} standing preference(s)`));
			for (const p of applied) lines.push(`  ${theme.fg("success", "+")} ${theme.fg("text", p.text.slice(0, 80))}`);
		} else if (proposals.length > 0) {
			lines.push(theme.fg("accent", `${proposals.length} candidate(s) — /self optimize apply to adopt`));
			for (const p of proposals) {
				lines.push(
					`  ${theme.fg("accent", "▸")} ${theme.fg("text", p.text.slice(0, 78))} ${theme.fg("muted", `(${p.sessions} sessions)`)}`,
				);
			}
		} else {
			lines.push(theme.fg("muted", "no candidates — nothing recurred across enough sessions yet"));
		}
		const standing = d.standing ?? [];
		if (standing.length > 0) {
			lines.push(theme.fg("muted", "active standing preferences:"));
			standing.forEach((s, i) => {
				lines.push(`  ${theme.fg("dim", `${i + 1}.`)} ${theme.fg("dim", s.text.slice(0, 78))}`);
			});
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("self", {
		description: "Self-optimize from your corrections: /self [note <lesson> | optimize [apply] | forget <n>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = (args ?? "").trim();
			const [sub, ...rest] = raw.split(/\s+/);
			const notify = (t: string, l: "info" | "warning" | "error") => ctx.ui.notify(t, l);

			if (sub === "note") {
				const lesson = rest.join(" ").trim();
				if (!lesson) {
					notify("Usage: /self note <lesson to remember>", "error");
					return;
				}
				record(lesson, "explicit");
				notify("noted — recorded as an explicit lesson; /self optimize apply to make it standing", "info");
				return;
			}
			if (sub === "optimize") {
				await optimize(/\bapply\b/i.test(raw), notify);
				return;
			}
			if (sub === "forget") {
				const n = Number(rest[0]);
				const steps = loadStanding();
				if (!n || n < 1 || n > steps.length) {
					notify(`Usage: /self forget <1..${steps.length}>`, "error");
					return;
				}
				const dropped = steps.splice(n - 1, 1)[0];
				try {
					writeFileSync(paths().standing, `${JSON.stringify(steps, null, 2)}\n`);
					notify(`forgot standing preference: ${dropped.text.slice(0, 60)}`, "info");
				} catch {
					notify("failed to update standing-instructions.json", "error");
				}
				return;
			}
			// default: show active standing preferences
			const steps = loadStanding();
			if (steps.length === 0) {
				notify(
					"no standing preferences yet — I learn them from your corrections; /self optimize to review candidates",
					"info",
				);
				return;
			}
			const body = steps.map((s, i) => `${i + 1}. ${s.text} (v${s.version}, ${s.sessions} sessions)`).join("\n");
			notify(`active standing preferences (/self forget <n> to drop):\n${body}`, "info");
		},
	});
}
