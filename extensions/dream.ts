/**
 * Dream — reflective memory consolidation (Claude Code's auto-dream pattern,
 * adapted to the knowledge platform).
 *
 * Capture (episodes, corrections, writebacks) runs continuously; nothing ever
 * CONSOLIDATES — near-duplicate facts accumulate, contradicted facts linger
 * until tripped over, stale proposals pile up. `/dream` dispatches one
 * fresh-context worker on a 4-phase reflective pass over the memory system:
 *
 *   orient      what the store holds (snapshot, coverage, boot surface)
 *   gather      recent episodes, stale claims, pending proposals, drift
 *   consolidate merge near-duplicates, fix contradictions — through the
 *               GOVERNED paths (knowledge.correct / correct_edge propose
 *               first; only content-identical duplicates may be confirmed)
 *   prune       reject stale proposals, report what needs a human decision
 *
 * Guardrails: destructive changes are PROPOSED, never auto-applied; the run
 * is throttled (once per 20h unless `force`); everything is visible in the
 * hub as a normal worker.
 *
 *   /dream          run a consolidation pass (throttled)
 *   /dream force    run now regardless of the throttle
 *   /dream status   when the last pass ran
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { copper, heatLine } from "./lib/card.ts";
import { registerSlashSeam } from "./lib/kp-bridge.ts";

const THROTTLE_MS = Number(process.env.PI_DREAM_THROTTLE_MS ?? 20 * 60 * 60 * 1000);

function statePath(): string {
	return join(getAgentDir(), "self", "dream-state.json");
}

function lastRun(): number {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf-8"));
		return typeof parsed.lastRun === "number" ? parsed.lastRun : 0;
	} catch {
		return 0;
	}
}

function recordRun(): void {
	try {
		mkdirSync(join(getAgentDir(), "self"), { recursive: true });
		writeFileSync(statePath(), `${JSON.stringify({ lastRun: Date.now() })}\n`);
	} catch {
		// best-effort
	}
}

function dreamPrompt(cwd: string): string {
	return [
		`<dream>`,
		"Run a MEMORY CONSOLIDATION pass. Dispatch EXACTLY ONE fresh-context worker via the agent tool",
		"with the self-contained brief below, then relay its summary to the user. Do not do the pass",
		"yourself in this session.",
		"",
		"Worker brief:",
		"You are performing a dream — a reflective pass over the knowledge platform's memory so future",
		"sessions orient faster and never trip over stale facts. Use knowledge_call {list:true} to see",
		"the available knowledge tools, then work in four phases:",
		"",
		"1. ORIENT — knowledge.memory_snapshot and knowledge.coverage: what kinds exist, what the boot",
		"   surface serves, where volume sits. Note anything obviously misfiled (e.g. BOOT_ALWAYS that",
		"   should be topic- or repo-scoped).",
		"2. GATHER — recent signal worth folding in: knowledge.memory_by_kind for Episodic (recent",
		"   session digests), knowledge.stale_claims, and pending writeback proposals.",
		"   (knowledge.gaps requires an entity_id — only call it topic-scoped, skip otherwise.)",
		`   Local stores to skim (read-only): ${cwd}/.pi/loops/*/GUARDRAILS.md and`,
		"   ~/.pi/agent/self/corrections.jsonl — recurring lessons that never got promoted.",
		"3. CONSOLIDATE — through GOVERNED paths only:",
		"   - near-duplicate facts: read the FULL text of both before proposing — same symptom does NOT",
		"     mean same incident (verified live: two MiniMax 400(2013) episodes had different root causes",
		"     and fixes). Causes differ -> propose a distinguishing cross-link note, NOT a merge.",
		"   - true duplicates: propose a merge with knowledge.correct (supersede the weaker copy)",
		"   - contradicted facts: knowledge.correct_edge WITHOUT autoconfirm (preview) — a human applies",
		"   - relative dates in fact text ('yesterday', 'last week'): propose absolute-dated corrections",
		"   - NEVER delete or auto-confirm anything except rejecting your own clearly-stale proposals",
		"4. PRUNE + REPORT — reject stale pending proposals (knowledge.reject) where obviously obsolete;",
		"   then report: N merged/proposed, N contradictions found (with ids), N proposals rejected,",
		"   and an explicit 'needs human decision' list. If memory is already tight, say so — an empty",
		"   dream is a valid result.",
		"",
		"Budget: keep it under ~15 tool calls; prefer breadth (snapshot/stale/gaps) over reading",
		"everything. End with one line: DREAM_SUMMARY: <counts + the single most important finding>",
		"</dream>",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer<{ forced?: boolean }>("dream", (message, options, theme) => {
		const head =
			`${copper("▎")} ☾ ${theme.fg("text", "dream — memory consolidation pass")}` +
			`${message.details?.forced ? ` ${theme.fg("warning", "(forced)")}` : ""}` +
			`${options.expanded ? "" : ` ${theme.fg("dim", "· ctrl+o brief")}`}`;
		const body = typeof message.content === "string" ? message.content : "";
		return new Text(
			options.expanded ? `${head}\n${heatLine(46)}\n${theme.fg("dim", body)}` : `${head}\n${heatLine(46)}`,
			0,
			0,
		);
	});

	const dreamHandler = async (
		args: string,
		ctx: Pick<ExtensionCommandContext, "cwd"> & {
			ui: { notify: (t: string, l: "info" | "warning" | "error") => void };
		},
	) => {
		const sub = (args ?? "").trim().toLowerCase();
		const last = lastRun();
		const ago = last ? Math.round((Date.now() - last) / 3_600_000) : undefined;
		if (sub === "status") {
			ctx.ui.notify(last ? `last dream: ${ago}h ago` : "no dream has run yet — /dream to start one", "info");
			return;
		}
		if (sub !== "force" && last && Date.now() - last < THROTTLE_MS) {
			ctx.ui.notify(
				`dreamt ${ago}h ago — memory consolidation is throttled to ~${Math.round(THROTTLE_MS / 3_600_000)}h. /dream force to run anyway`,
				"info",
			);
			return;
		}
		recordRun();
		pi.sendMessage(
			{
				customType: "dream",
				content: dreamPrompt(ctx.cwd),
				display: true,
				details: { forced: sub === "force" },
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("dream", {
		description:
			"Reflective memory consolidation: /dream [force|status] — merge dupes, flag contradictions, prune proposals",
		handler: dreamHandler,
	});
	// Schedulable: /every 1d /dream force
	registerSlashSeam("dream", dreamHandler);
}
