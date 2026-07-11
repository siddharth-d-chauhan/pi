/**
 * Intents — prospective memory ("remember to do X when Y happens").
 *
 *   /intend <trigger> :: <reminder>    e.g. /intend licensing :: migrate LicenseGuard first
 *   /intend                            list pending + fired intents
 *   /intend drop <n>                   remove intent n
 *
 * The trigger is a plain substring matched against (a) file paths any tool
 * touches and (b) your task text at turn start. When it fires, the reminder is
 * STEERED into the running turn once (<intent-reminder>), then archived —
 * one-shot by design: standing rules belong in KP (BEFORE_ACTION / preferences),
 * intents are for future one-time follow-ups that would otherwise be forgotten.
 * Store: <repo>/.pi/intents.json (repo-owned, inspectable, git-ignorable).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { copper, heatLine } from "./lib/card.ts";
import { extractPaths } from "./lib/kp-bridge.ts";

interface Intent {
	id: string;
	trigger: string;
	remind: string;
	created: string;
	firedAt?: string;
}

function intentsPath(cwd: string): string {
	return join(cwd, ".pi", "intents.json");
}

function loadIntents(cwd: string): Intent[] {
	try {
		const parsed = JSON.parse(readFileSync(intentsPath(cwd), "utf-8"));
		if (Array.isArray(parsed)) {
			return parsed.filter((i) => i && typeof i.trigger === "string" && typeof i.remind === "string");
		}
	} catch {
		// none yet
	}
	return [];
}

function saveIntents(cwd: string, intents: Intent[]): void {
	try {
		mkdirSync(dirname(intentsPath(cwd)), { recursive: true });
		writeFileSync(intentsPath(cwd), `${JSON.stringify(intents, null, 2)}\n`);
	} catch {
		// best-effort
	}
}

export default function (pi: ExtensionAPI) {
	/** id -> fired this session (avoid double-steer before the file persists). */
	const firedThisSession = new Set<string>();

	function fire(cwd: string, intent: Intent, matchedOn: string): void {
		if (firedThisSession.has(intent.id)) return;
		firedThisSession.add(intent.id);
		const intents = loadIntents(cwd);
		const hit = intents.find((i) => i.id === intent.id);
		if (hit) {
			hit.firedAt = new Date().toISOString();
			saveIntents(cwd, intents);
		}
		pi.sendMessage(
			{
				customType: "intent-reminder",
				content: [
					`<intent-reminder trigger="${intent.trigger}">`,
					`You previously asked to be reminded when work touches '${intent.trigger}' (matched: ${matchedOn}):`,
					intent.remind,
					"Honor it now or tell the user why it no longer applies. This reminder is one-shot.",
					"</intent-reminder>",
				].join("\n"),
				display: true,
				details: { trigger: intent.trigger, remind: intent.remind },
			},
			{ deliverAs: "steer" },
		);
	}

	function check(cwd: string, haystacks: string[]): void {
		const pending = loadIntents(cwd).filter((i) => !i.firedAt);
		if (pending.length === 0) return;
		for (const intent of pending) {
			const needle = intent.trigger.toLowerCase();
			const hit = haystacks.find((h) => h.toLowerCase().includes(needle));
			if (hit) fire(cwd, intent, hit.slice(0, 60));
		}
	}

	pi.on("before_agent_start", async (event) => {
		if (typeof event.prompt === "string") check(process.cwd(), [event.prompt]);
	});

	pi.on("tool_execution_start", async (event) => {
		const paths = extractPaths(event.args);
		if (paths.length > 0) check(process.cwd(), paths);
	});

	pi.registerMessageRenderer<{ trigger?: string; remind?: string }>("intent-reminder", (message, options, theme) => {
		const d = message.details;
		const head =
			`${copper("▎")} ⏰ ${theme.fg("warning", `intent fired: ${d?.trigger ?? "?"}`)} ` +
			`${theme.fg("text", (d?.remind ?? "").slice(0, 60))}${options.expanded ? "" : ` ${theme.fg("dim", "· ctrl+o")}`}`;
		const body = typeof message.content === "string" ? message.content : "";
		return new Text(
			options.expanded ? `${head}\n${heatLine(46)}\n${theme.fg("dim", body)}` : `${head}\n${heatLine(46)}`,
			0,
			0,
		);
	});

	pi.registerCommand("intend", {
		description: "Prospective memory: /intend <trigger> :: <reminder> | /intend [drop <n>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				const intents = loadIntents(ctx.cwd);
				if (intents.length === 0) {
					ctx.ui.notify(
						"no intents — /intend <trigger> :: <reminder> (fires once when work touches the trigger)",
						"info",
					);
					return;
				}
				const lines = intents.map(
					(i, n) => `${n + 1}. ${i.firedAt ? "✓" : "○"} when '${i.trigger}' → ${i.remind.slice(0, 70)}`,
				);
				ctx.ui.notify(`intents (○ pending, ✓ fired; /intend drop <n>):\n${lines.join("\n")}`, "info");
				return;
			}
			const drop = /^drop\s+(\d+)$/.exec(raw);
			if (drop) {
				const intents = loadIntents(ctx.cwd);
				const n = Number(drop[1]);
				if (n < 1 || n > intents.length) {
					ctx.ui.notify(`Usage: /intend drop <1..${intents.length}>`, "error");
					return;
				}
				const [removed] = intents.splice(n - 1, 1);
				saveIntents(ctx.cwd, intents);
				ctx.ui.notify(`dropped intent: when '${removed.trigger}'`, "info");
				return;
			}
			const parts = raw.split("::");
			if (parts.length < 2 || !parts[0].trim() || !parts.slice(1).join("::").trim()) {
				ctx.ui.notify("Usage: /intend <trigger> :: <reminder>", "error");
				return;
			}
			const trigger = parts[0].trim();
			const remind = parts.slice(1).join("::").trim();
			const intents = loadIntents(ctx.cwd);
			intents.push({
				id: `i${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				trigger,
				remind: remind.slice(0, 400),
				created: new Date().toISOString(),
			});
			saveIntents(ctx.cwd, intents);
			ctx.ui.notify(`intent recorded — will remind once when work touches '${trigger}'`, "info");
		},
	});

	// expose for /recall (pending intents are part of the retrieval surface)
	(globalThis as Record<string, unknown>).__pi_intents__ = (cwd: string) => loadIntents(cwd).filter((i) => !i.firedAt);
}
