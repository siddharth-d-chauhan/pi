/**
 * auto-thinking.ts — set the thinking budget per turn by classifying difficulty.
 *
 * oh-my-pi's "auto thinking": cheap turns stay cheap, hard ones get the budget,
 * instead of a fixed global level. The effort cost/quality lever — you were paying
 * one flat thinking level for "fix this typo" and "design this architecture" alike.
 *
 * Two-tier classifier (cheap-first, no LLM on the common path):
 *  1. Heuristic (instant, free): signals in the user's message → a level. Trivial
 *     asks (fix typo, rename, yes/no) → low; design/debug/architecture/why →
 *     high/xhigh; default medium. Handles the vast majority.
 *  2. Optional model classifier for genuinely ambiguous mid-length turns
 *     (KP_AUTOTHINK_MODEL set) → one cheap call returns low|medium|high|xhigh.
 *
 * Only classifies REAL user turns (not tool-result continuations). Respects a
 * manual override: if you set the level yourself, auto-thinking backs off for the
 * session (KP_AUTOTHINK=resume to re-enable).
 *
 * Config: KP_AUTOTHINK=0 disable · KP_AUTOTHINK_MODEL (optional LLM classifier) ·
 *   KP_AUTOTHINK_MAX (cap, default xhigh).
 */

const ENABLED = process.env.KP_AUTOTHINK !== "0";
const CLASSIFIER = process.env.KP_AUTOTHINK_MODEL || ""; // "" = heuristic only
const MAX = (process.env.KP_AUTOTHINK_MAX || "xhigh") as Level;

type Level = "low" | "medium" | "high" | "xhigh";
const ORDER: Level[] = ["low", "medium", "high", "xhigh"];
const cap = (l: Level): Level => (ORDER.indexOf(l) > ORDER.indexOf(MAX) ? MAX : l);

// signal → level. Ordered strongest-first.
const HARD =
	/\b(architect|design|refactor|debug|why (is|does|isn'?t|won'?t)|root cause|trade-?off|strategy|migrate|concurren|race condition|deadlock|optimiz|algorithm|prove|reason about|edge cases?|security|threat model|plan (the|a|out)|figure out|investigate|diagnose)\b/i;
const XHARD =
	/\b(complex|subtle|tricky|deep|end-to-end|whole system|across (the|multiple)|from scratch|rewrite|hard problem)\b/i;
const EASY =
	/\b(typo|rename|format|lint|indent|add a comment|bump|version|spelling|whitespace|import|one-?liner|quick|trivial|simple|just (add|change|fix|update|remove)|yes|no|ok|sure|thanks|list|show me|what is the|print)\b/i;

function heuristic(text: string): { level: Level; reason: string } | null {
	const t = text.trim();
	if (t.length < 12 && EASY.test(t)) return { level: "low", reason: "short/simple" };
	if (XHARD.test(t) || (HARD.test(t) && t.length > 200)) return { level: "xhigh", reason: "complex/deep" };
	if (HARD.test(t)) return { level: "high", reason: "design/debug/reasoning" };
	if (EASY.test(t) && t.length < 80) return { level: "low", reason: "trivial edit" };
	if (t.length > 400) return { level: "high", reason: "long/detailed request" };
	return null; // ambiguous → medium or classifier
}

function classify(text: string): Promise<Level> {
	return new Promise((res) => {
		if (!CLASSIFIER) return res("medium");
		const { execFileSync } = require("node:child_process");
		const { readFileSync, rmSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const { join } = require("node:path");
		const out = join(tmpdir(), `autothink-${process.pid}-${Date.now()}.txt`);
		const prompt = `Classify the effort this coding request needs. Reply ONE word: low, medium, high, or xhigh.\nlow=trivial edit/lookup; medium=normal change; high=design/debug/multi-file reasoning; xhigh=complex architecture/subtle bug.\n\nRequest: ${text.slice(0, 500)}`;
		try {
			execFileSync(
				"codex",
				["exec", "-m", CLASSIFIER, "--skip-git-repo-check", "--output-last-message", out, prompt],
				{ encoding: "utf-8", timeout: 30_000, cwd: tmpdir() },
			);
			const ans = readFileSync(out, "utf-8").trim().toLowerCase();
			rmSync(out, { force: true });
			const m = ans.match(/low|medium|high|xhigh/);
			res((m?.[0] as Level) || "medium");
		} catch {
			res("medium");
		}
	});
}

export default function (pi: any) {
	if (!ENABLED) return;

	let manualOverride = false;
	let lastInput = "";
	let auto: Level | null = null;

	// Track manual thinking changes → back off (don't fight the user).
	pi.on("thinking_level_select", async () => {
		if (auto === null) return; // ignore our own set
		manualOverride = true;
	});

	pi.on("input", async (event: any) => {
		lastInput = String(event?.text ?? "").trim();
	});

	pi.on("before_agent_start", async () => {
		if (manualOverride || !lastInput) return;
		const h = heuristic(lastInput);
		let level: Level;
		if (h) level = h.level;
		else level = await classify(lastInput); // ambiguous → medium or model
		level = cap(level);
		try {
			auto = level;
			pi.setThinkingLevel(level);
			auto = null; // reset guard after our own set fires thinking_level_select
		} catch {}
		lastInput = ""; // consume — don't re-classify tool-result continuations
	});

	pi.registerCommand("autothink", {
		description: "Auto-thinking: /autothink (status) · /autothink resume (re-enable after manual override)",
		handler: async (args: string, ctx: any) => {
			if ((args || "").trim() === "resume") {
				manualOverride = false;
				ctx.ui.notify("Auto-thinking re-enabled.", "info");
				return;
			}
			ctx.ui.notify(
				`Auto-thinking ${manualOverride ? "PAUSED (manual override — /autothink resume)" : "active"}. ` +
					`Classifier: ${CLASSIFIER || "heuristic-only"}, cap ${MAX}. Sets thinking per turn by difficulty.`,
				"info",
			);
		},
	});
}
