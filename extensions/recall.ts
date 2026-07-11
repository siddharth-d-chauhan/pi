/**
 * Recall — ONE retrieval surface over every memory store, fixing the
 * "we have memory everywhere but finding it is hard" problem.
 *
 *   /recall <query>      rich panel for the human
 *   recall tool          the model can search the same surface mid-task
 *
 * Sources, merged and labeled:
 *   kp        knowledge platform semantic memory_search (facts, episodes,
 *             lessons, procedures — the durable store)
 *   pref      standing preferences (learned from your corrections)
 *   loop      cross-loop standing lessons + recent loop guardrails
 *   intent    pending prospective-memory intents
 *
 * Local stores are filtered by salient-word overlap with the query; KP does
 * its own semantic ranking. Every KP fact returned is registered in the
 * delivered-facts registry so other channels don't re-inject it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { copper, heatLine } from "./lib/card.ts";
import { jaccard, keywords } from "./lib/correction-optimizer.ts";
import { callKp, markDelivered } from "./lib/kp-bridge.ts";

const KP_SEARCH_TIMEOUT_MS = Number(process.env.PI_KP_RECALL_TIMEOUT_MS ?? 6_000);

interface RecallHit {
	source: "kp" | "pref" | "loop" | "intent";
	kind: string;
	text: string;
	score: number;
	factId?: string;
}

function localScore(query: string, text: string): number {
	const q = keywords(query);
	const t = keywords(text);
	if (q.size === 0 || t.size === 0) return 0;
	let shared = 0;
	for (const w of q) if (t.has(w)) shared += 1;
	// shared salient words dominate; jaccard breaks ties
	return shared + jaccard(q, t);
}

function searchPreferences(query: string): RecallHit[] {
	try {
		const parsed = JSON.parse(readFileSync(join(getAgentDir(), "self", "standing-instructions.json"), "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((s) => s && typeof s.text === "string")
			.map((s) => ({
				source: "pref" as const,
				kind: "Preference",
				text: s.text as string,
				score: localScore(query, s.text),
			}))
			.filter((h) => h.score >= 1);
	} catch {
		return [];
	}
}

function searchLoops(query: string, cwd: string): RecallHit[] {
	const hits: RecallHit[] = [];
	const loopsDir = join(cwd, ".pi", "loops");
	try {
		const baseline = JSON.parse(readFileSync(join(loopsDir, "_optimizer", "baseline-steps.json"), "utf-8"));
		if (Array.isArray(baseline)) {
			for (const b of baseline) {
				if (b?.text) {
					hits.push({ source: "loop", kind: "StandingLesson", text: b.text, score: localScore(query, b.text) });
				}
			}
		}
	} catch {
		// none
	}
	try {
		for (const dir of readdirSync(loopsDir)) {
			const g = join(loopsDir, dir, "GUARDRAILS.md");
			if (dir.startsWith("_") || !existsSync(g)) continue;
			for (const line of readFileSync(g, "utf-8").split("\n")) {
				if (!line.startsWith("- ")) continue;
				const text = line.slice(2).trim();
				const score = localScore(query, text);
				if (score >= 1) hits.push({ source: "loop", kind: `Guardrail(${dir})`, text, score });
			}
		}
	} catch {
		// none
	}
	return hits.filter((h) => h.score >= 1);
}

function searchIntents(query: string, cwd: string): RecallHit[] {
	const list = (globalThis as Record<string, unknown>).__pi_intents__ as
		| ((cwd: string) => Array<{ trigger: string; remind: string }>)
		| undefined;
	if (!list) return [];
	try {
		return list(cwd)
			.map((i) => ({
				source: "intent" as const,
				kind: "Intent",
				text: `when '${i.trigger}' → ${i.remind}`,
				score: localScore(query, `${i.trigger} ${i.remind}`),
			}))
			.filter((h) => h.score >= 1);
	} catch {
		return [];
	}
}

async function searchKp(query: string, limit: number): Promise<RecallHit[]> {
	// knowledge.search (NOT memory_search): it has the hot-tier read-through,
	// so facts written this session — before graph reconciliation — are found.
	// Verified live: a hot-only writeback ranked first here and was absent
	// from the graph-backed memory_search.
	const parsed = await callKp<unknown>("knowledge.search", { query, limit }, KP_SEARCH_TIMEOUT_MS);
	if (!parsed) return [];
	// tolerate several result shapes: bare array, {hits}, {results}, {memories}
	const obj = parsed as Record<string, unknown>;
	const rows = (
		Array.isArray(parsed) ? parsed : (obj.hits ?? obj.results ?? obj.memories ?? obj.items ?? [])
	) as Array<Record<string, unknown>>;
	if (!Array.isArray(rows)) return [];
	return rows
		.map((r) => ({
			source: "kp" as const,
			kind: String(r.kind ?? r.type ?? "Fact"),
			text: String(r.text ?? r.summary ?? r.fact ?? ""),
			score: Number(r.score ?? 0.5),
			factId: typeof r.fact_id === "string" ? r.fact_id : typeof r.id === "string" ? r.id : undefined,
		}))
		.filter((h) => h.text.length > 0);
}

async function recall(query: string, cwd: string, limit: number): Promise<{ hits: RecallHit[]; kpUp: boolean }> {
	const kpHits = await searchKp(query, limit);
	markDelivered(kpHits.map((h) => h.factId));
	const local = [...searchPreferences(query), ...searchLoops(query, cwd), ...searchIntents(query, cwd)].sort(
		(a, b) => b.score - a.score,
	);
	// KP is semantically ranked; locals are word-overlap ranked. Interleave with
	// locals first when they scored a direct hit (>=2 shared words), else KP first.
	const strongLocal = local.filter((h) => h.score >= 2);
	const weakLocal = local.filter((h) => h.score < 2);
	const merged = [...strongLocal, ...kpHits, ...weakLocal].slice(0, limit);
	return { hits: merged, kpUp: kpHits.length > 0 };
}

const recallSchema = Type.Object({
	query: Type.String({ description: "what to look for (task, topic, file, decision...)" }),
	limit: Type.Optional(Type.Number({ description: "max results (default 8)" })),
});
type RecallInput = Static<typeof recallSchema>;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "recall",
		label: "recall",
		description:
			"Search ALL memory stores in one call: knowledge platform (facts/lessons/episodes/procedures), " +
			"learned user preferences, loop lessons/guardrails, and pending intents. Use when past context, " +
			"decisions, pitfalls, or 'have we seen this before' would change your approach.",
		parameters: recallSchema,
		async execute(_id: string, input: RecallInput) {
			const { hits } = await recall(input.query, process.cwd(), Math.max(1, input.limit ?? 8));
			if (hits.length === 0) {
				return { content: [{ type: "text" as const, text: "no memory hits" }], details: undefined };
			}
			const text = hits.map((h) => `[${h.source}:${h.kind}] ${h.text}`).join("\n");
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	});

	pi.registerMessageRenderer<{ query?: string; kpUp?: boolean; hits?: RecallHit[] }>(
		"recall-results",
		(message, _options, theme) => {
			const d = message.details ?? {};
			const lines: string[] = [];
			lines.push(
				`${copper("▎")} ⌕ ${theme.fg("text", `recall: ${d.query ?? ""}`)} · ${theme.fg("muted", `${d.hits?.length ?? 0} hit(s)${d.kpUp ? "" : " · KP unreachable — local stores only"}`)}`,
			);
			lines.push(heatLine(46));
			const tag: Record<string, string> = { kp: "accent", pref: "success", loop: "warning", intent: "error" };
			for (const h of d.hits ?? []) {
				lines.push(
					`  ${theme.fg((tag[h.source] ?? "dim") as never, h.source.padEnd(6))} ${theme.fg("muted", h.kind.padEnd(18).slice(0, 18))} ${theme.fg("text", h.text.slice(0, 82))}`,
				);
			}
			if ((d.hits ?? []).length === 0)
				lines.push(theme.fg("dim", "  nothing found across kp/pref/loop/intent stores"));
			return new Text(lines.join("\n"), 0, 0);
		},
	);

	pi.registerCommand("recall", {
		description: "Search all memory stores at once: /recall <query>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const query = (args ?? "").trim();
			if (!query) {
				ctx.ui.notify("Usage: /recall <query>", "error");
				return;
			}
			const { hits, kpUp } = await recall(query, ctx.cwd, 12);
			pi.sendMessage(
				{
					customType: "recall-results",
					content: `recall: ${query}`,
					display: true,
					details: { query, kpUp, hits },
				},
				{ triggerTurn: false },
			);
		},
	});
}
