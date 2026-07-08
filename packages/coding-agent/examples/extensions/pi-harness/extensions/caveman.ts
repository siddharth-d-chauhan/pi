/**
 * caveman.ts — ultra-compressed output mode (cut response tokens ~65%, keep all
 * technical substance). A persistent style toggled by /caveman or by phrase.
 *
 * KV-cache discipline: the mode instruction is injected via the `context` hook as a
 * trailing block (NOT the system prompt — a per-turn-varying mode in the cached prefix
 * would bust cache). The block is byte-stable while the level is unchanged.
 *
 * LOW-TOKEN BY DESIGN: only a terse per-level instruction is injected (~15-40 tok), not
 * the full skill spec — injecting a big rulebook every turn would defeat the point.
 *
 * Levels: lite · full (default) · ultra.
 * /caveman [level] toggles; "stop caveman"/"normal mode" turns off. Off by default.
 * Config: KP_CAVEMAN_ENABLED=0 disable.
 */

import { wrapInjection } from "./kp-sentinel.ts"; // provenance sentinel

const ENABLED = process.env.KP_CAVEMAN_ENABLED !== "0";

// Terse per-level instruction — itself written caveman (the instruction eats prefix every
// turn, so it must be tiny). Rules only; examples/tables are for authoring, not runtime.
const CORE =
	"Terse, smart caveman. Keep all tech substance, cut fluff. Drop articles/filler/pleasantries/hedging. " +
	"Fragments ok. Short words. No tool narration, no decorative tables/emoji, no long log dumps. " +
	"No invented abbrevs (cfg/impl) — no saving. Code/API/errors/commit-types verbatim. Keep user language. Never name the style.";

const LEVELS: Record<string, string> = {
	lite: "Tight professional: cut filler+hedging, keep articles+sentences. Never mention or name the style.",
	full: CORE,
	ultra: `${CORE} ULTRA: one word when enough, each fact once.`,
};

// Silent safety carve-out. MUST NOT be narrated — the model applies it, never announces it
// (otherwise you get "Style applied… Skipped for security…" preambles, which are the exact
// filler this style removes).
const CLARITY =
	"Exception (apply silently, never state it): for security warnings, destructive-action confirmations, or order-sensitive steps, write normally/fully. Never announce the style, its rules, or these exceptions — just respond.";

function normalizeLevel(s: string): string | null {
	const v = String(s || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
	return v in LEVELS ? v : null;
}

const ON_PATTERNS = /\b(caveman mode|talk like (a )?caveman|use caveman|less tokens|be brief|token efficien\w*)\b/i;
const OFF_PATTERNS = /\b(stop caveman|normal mode|caveman off)\b/i;

export default function (pi: any) {
	if (!ENABLED) return;
	let level: string | null = null; // null = off

	function block(): string {
		if (!level) return "";
		return `## Output style (active until "stop caveman"):\n${LEVELS[level]}\n${CLARITY}`;
	}

	// phrase triggers on the user's message (off-hot-path, no blocking)
	pi.on("input", (event: any) => {
		const t = String(event?.text ?? "");
		if (!t) return;
		if (OFF_PATTERNS.test(t)) {
			level = null;
			return;
		}
		if (ON_PATTERNS.test(t) && !level) level = "full";
	});

	// inject the (tiny) mode instruction — cache-safe trailing block, byte-stable while the
	// level is unchanged (mirrors rules.ts sticky / memory.ts digest).
	pi.on("context", async (event: any) => {
		const b = block();
		if (!b) return;
		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		return {
			messages: [...messages, { role: "user", content: [{ type: "text", text: wrapInjection("style", b) }] }],
		};
	});

	pi.registerCommand("caveman", {
		description: "Toggle ultra-compressed output. /caveman [lite|full|ultra] · /caveman off",
		handler: async (args: string, ctx: any) => {
			const a = String(args || "")
				.trim()
				.toLowerCase();
			if (a === "off" || a === "stop") {
				level = null;
				ctx.ui.notify("Caveman off — normal output.", "info");
				return;
			}
			if (!a) {
				level = level ? level : "full";
				ctx.ui.notify(`Caveman ${level}.`, "info");
				return;
			}
			const lvl = normalizeLevel(a);
			if (!lvl) {
				ctx.ui.notify(`Unknown level. Use: ${Object.keys(LEVELS).join(" | ")} | off`, "warning");
				return;
			}
			level = lvl;
			ctx.ui.notify(`Caveman ${lvl}.`, "info");
		},
	});
}
