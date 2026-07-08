/**
 * context-cmd.ts — /context: live context-window breakdown (like Claude Code's).
 *
 * HONEST about what's real vs estimated:
 *   ◆ MEASURED (from the provider's usage report — the only source of truth):
 *       total context / window / %, and the CACHE split (cacheRead vs fresh input
 *       vs cacheWrite). The provider returns ONE aggregate input number + the
 *       cache split — it does NOT break the prompt down per-tool or per-section,
 *       so nothing below can be "from the provider" at that granularity.
 *     Also MEASURED: the cold-start prefix — the FIRST turn's fresh input (before
 *       the cache warms) is the real full-prefix token count; we capture + show it.
 *   ◆ ESTIMATED (chars/4 — pi's own estimateTokens uses the same): the per-category
 *       breakdown of where the prefix goes. Labeled as an estimate, and scaled so
 *       the parts sum to the measured cold prefix (calibrated proportions, not
 *       provider data). Use it directionally (which subsystem is heavy), not as
 *       exact token counts — the provider simply doesn't expose that.
 *
 * Pure read-only. Config: KP_CONTEXT_CMD_ENABLED=0 disable.
 */

const ENABLED = process.env.KP_CONTEXT_CMD_ENABLED !== "0";

const est = (s: string) => Math.ceil((s || "").length / 4);
function fmt(n: number | null | undefined): string {
	if (n == null) return "?";
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function _bar(pct: number, width = 24): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}
// A gradient bar — green under 60%, amber to 85%, red beyond. A glance tells you headroom.
function heatBar(pct: number, width = 28): string {
	const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
	const glyph = pct >= 85 ? "█" : pct >= 60 ? "▓" : "▒";
	return glyph.repeat(filled) + "░".repeat(width - filled);
}
// Card representation (omp-inspired): a titled box so each section reads as a unit, not a wall
// of lines. Width auto-fits the content; a right-aligned value column keeps numbers scannable.
function card(title: string, rows: Array<[string, string] | string>): string {
	const body = rows.map((r) => (Array.isArray(r) ? r : ([r, ""] as [string, string])));
	const labelW = Math.max(0, ...body.map(([l]) => l.length));
	const lines = body.map(([l, v]) => (v ? `  ${l.padEnd(labelW)}  ${v}` : `  ${l}`));
	// inner width = widest content line (measured after padding) or the title header, +padding.
	const inner = Math.max(`─ ${title} ─`.length, ...lines.map((l) => l.length + 1), 30);
	const top = `╭─ ${title} ${"─".repeat(Math.max(1, inner - title.length - 3))}╮`;
	const bottom = `╰${"─".repeat(inner)}╯`;
	return [top, ...lines, bottom].join("\n");
}

export default function (pi: any) {
	if (!ENABLED) return;

	// Latest per-turn usage (input/output/cacheRead/cacheWrite) from the provider.
	let last: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | null = null;
	// The REAL cold-start prefix: the first turn's total prompt (input+cacheRead)
	// when the cache was cold (cacheRead≈0). This is a genuine measured full-prefix
	// token count from the provider — the anchor we calibrate the breakdown to.
	let coldPrefix = 0;
	pi.on("message_end", async (event: any) => {
		try {
			const u = event?.message?.usage;
			if (u && (u.input || u.cacheRead || u.totalTokens)) {
				last = {
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheRead: u.cacheRead ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
					total: u.totalTokens ?? 0,
				};
				const prompt = (u.input ?? 0) + (u.cacheRead ?? 0);
				// capture the biggest cold (uncached) prompt we see as the true prefix size
				if ((u.cacheRead ?? 0) === 0 && prompt > coldPrefix) coldPrefix = prompt;
			}
		} catch {}
	});

	pi.registerCommand("context", {
		description:
			"Show the live context-window breakdown: usage, cache hit, tool-schema costs (like Claude Code /context)",
		handler: async (_args: string, ctx: any) => {
			const lines: string[] = [];

			// ═══ CARD 1 — MEASURED context usage (from the provider) ═══
			const usage = ctx.getContextUsage?.();
			let measuredPrompt = 0;
			if (usage) {
				const pct = usage.percent ?? 0;
				const headroom = 100 - pct;
				lines.push(
					card("CONTEXT · measured (provider)", [
						["window", `${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tok  (${pct.toFixed(1)}%)`],
						[heatBar(pct), `${headroom.toFixed(0)}% headroom`],
					]),
				);
			} else {
				lines.push(card("CONTEXT · measured (provider)", ["usage unavailable — ask something, then /context"]));
			}

			// ═══ CARD 2 — CACHE split from the last turn (real provider numbers) ═══
			if (last) {
				const fresh = last.input ?? 0;
				const cached = last.cacheRead ?? 0;
				const written = last.cacheWrite ?? 0;
				const promptTotal = fresh + cached;
				measuredPrompt = promptTotal;
				const hitPct = promptTotal ? Math.round((cached / promptTotal) * 100) : 0;
				const rows: Array<[string, string] | string> = [
					["prompt in", `${fmt(promptTotal)} tok  (the REAL number)`],
					["cache HIT ~10¢", `${fmt(cached)}  (${hitPct}%)  ${heatBar(hitPct, 14)}`],
					["fresh / uncached", `${fmt(fresh)}  (${100 - hitPct}%)`],
				];
				if (written) rows.push(["cache WRITE 1.25×", `${fmt(written)}  (first-time warm)`]);
				rows.push(["output", `${fmt(last.output)} tok`]);
				if (coldPrefix) rows.push(["cold prefix", `${fmt(coldPrefix)} tok  ← real, uncached`]);
				lines.push(card("LAST TURN · cache (measured)", rows));
			} else {
				lines.push(card("LAST TURN · cache", ["no turn recorded yet — ask something, then /context"]));
			}

			// --- WHERE THE PREFIX GOES: categorized breakdown (like Claude Code) ---
			try {
				const all: any[] = ctx.getAllTools?.() ?? pi.getAllTools?.() ?? [];
				const active: string[] = ctx.getActiveTools?.() ?? pi.getActiveTools?.() ?? [];
				const activeSet = new Set(active);
				const toolTok = (t: any) =>
					est(t?.name) +
					est(t?.description) +
					est(JSON.stringify(t?.parameters ?? {})) +
					est((t?.promptGuidelines ?? []).join(" ")) +
					4;

				// Attribute each ACTIVE tool to a category via its sourceInfo (which file
				// registered it) — builtin vs the harness subsystem.
				const cat = (t: any): string => {
					const src = String(t?.sourceInfo?.source ?? t?.sourceInfo?.path ?? t?.sourceInfo?.name ?? "");
					if (/builtin/i.test(src)) return "pi builtins";
					const m = src.match(/extensions\/([a-z-]+)\.ts/i);
					const f = m ? m[1] : "";
					if (/knowledge|codemap|scope|session-search/.test(f)) return "retrieval (knowledge/codemap/scope)";
					if (/delegate|a2a|dlc-context|model-router/.test(f)) return "delegation + shared context";
					if (/verify|review|edit-lint|diagnostics/.test(f)) return "verification + review";
					if (/hashline|debug|sandbox|repohost/.test(f)) return "edit/run/debug";
					if (/memory/.test(f)) return "memory";
					if (/capabilities|task-profile/.test(f)) return "capability map + routing";
					return f ? `other (${f})` : "other extensions";
				};

				const buckets = new Map<string, { tok: number; n: number }>();
				let activeTok = 0,
					coldTok = 0,
					coldN = 0;
				for (const t of all) {
					const tok = toolTok(t);
					if (activeSet.has(t?.name)) {
						activeTok += tok;
						const c = cat(t);
						const b = buckets.get(c) ?? { tok: 0, n: 0 };
						b.tok += tok;
						b.n++;
						buckets.set(c, b);
					} else {
						coldTok += tok;
						coldN++;
					}
				}
				const sp = est(ctx.getSystemPrompt?.() ?? "");
				const rawTotal = sp + activeTok; // our chars/4 estimate of the whole prefix

				// CALIBRATE to the real cold-prefix (measured, uncached) if we have it —
				// else the current turn's prompt total. Scale chars/4 categories so the
				// parts sum to the real measured prefix (calibrated proportions).
				const anchor = coldPrefix || measuredPrompt;
				const scale = anchor > 0 && rawTotal > 0 ? anchor / rawTotal : 1;
				const cal = (n: number) => Math.round(n * scale);
				const note =
					anchor > 0
						? `shares of the ${fmt(anchor)} measured prefix; per-item = ESTIMATE (chars/4), the provider gives no per-tool data`
						: `ESTIMATED (chars/4; no measured prefix yet — ask something, then /context)`;

				// Card 3 — prefix breakdown. A mini in-row bar per category shows relative weight visually.
				const anchorTot = anchor || rawTotal || 1;
				const miniBar = (tok: number) => {
					const w = Math.max(0, Math.min(10, Math.round((tok / anchorTot) * 10)));
					return "▪".repeat(w) + " ".repeat(10 - w);
				};
				const rows: Array<[string, string] | string> = [["system prompt", `${miniBar(cal(sp))} ~${fmt(cal(sp))}`]];
				for (const [name, b] of [...buckets.entries()].sort((a, c) => c[1].tok - a[1].tok)) {
					rows.push([name, `${miniBar(cal(b.tok))} ~${fmt(cal(b.tok))}  (${b.n})`]);
				}
				rows.push(["— deactivated (cold)", `~${fmt(coldTok)} saved  (${coldN})`]);
				const top = all
					.filter((t) => activeSet.has(t?.name))
					.map((t) => ({ n: t?.name, tok: cal(toolTok(t)) }))
					.sort((a, b) => b.tok - a.tok)
					.slice(0, 5);
				if (top.length) {
					rows.push("");
					rows.push(`heaviest: ${top.map((t) => `${t.n} ~${t.tok}`).join(" · ")}`);
				}
				lines.push(card("PREFIX · where it goes (estimated)", rows));
				lines.push(`  ⓘ ${note}`);

				// --- SYSTEM PROMPT breakdown: crack the opaque ~Nk "system prompt" bucket into its real
				// constituents so 19k isn't a mystery. The assembled prompt is a concatenation of blocks
				// with stable headers (base pi prompt + each extension's POLICY + AWARENESS + CLAUDE.md
				// hierarchy). We split on those markers; CLAUDE.md is itemized per file. Same chars/4
				// estimate, same `cal()` scale as the prefix card so the parts stay comparable. ---
				const spText = String(ctx.getSystemPrompt?.() ?? "");
				if (spText) {
					// Ordered markers → labels. Anything before the FIRST marker = pi's base prompt +
					// early extension policies (knowledge/hashline/delegate append before AWARENESS).
					const MARKERS: Array<[string, string]> = [
						["## This harness — behaviors your tools don't announce", "harness AWARENESS block"],
						["## Project & user instructions (CLAUDE.md)", "CLAUDE.md (project/user)"],
						["## Standing memory", "standing memory (digest)"],
					];
					// find each marker's index (─1 if absent), in text order
					const hits = MARKERS.map(([m, label]) => ({ label, at: spText.indexOf(m) }))
						.filter((h) => h.at >= 0)
						.sort((a, b) => a.at - b.at);
					const spRows: Array<[string, string] | string> = [];
					const firstAt = hits.length ? hits[0].at : spText.length;
					// base = everything before the first harness/CLAUDE marker (pi base + policy appends)
					spRows.push([
						"base prompt + tool policies",
						`${miniBar(cal(est(spText.slice(0, firstAt))))} ~${fmt(cal(est(spText.slice(0, firstAt))))}`,
					]);
					for (let i = 0; i < hits.length; i++) {
						const seg = spText.slice(hits[i].at, i + 1 < hits.length ? hits[i + 1].at : spText.length);
						if (hits[i].label.startsWith("CLAUDE.md")) {
							// itemize each CLAUDE.md file inside this segment (### <label> chunks)
							const chunks = seg.split(/\n### /).slice(1); // drop the header preamble
							spRows.push([
								hits[i].label,
								`${miniBar(cal(est(seg)))} ~${fmt(cal(est(seg)))}  (${chunks.length} file${chunks.length === 1 ? "" : "s"})`,
							]);
							for (const c of chunks) {
								const nm = (c.split("\n")[0] || "").trim().slice(0, 46);
								spRows.push([`  · ${nm}`, `~${fmt(cal(est(c)))}`]);
							}
						} else {
							spRows.push([hits[i].label, `${miniBar(cal(est(seg)))} ~${fmt(cal(est(seg)))}`]);
						}
					}
					// SELF-DIAGNOSING: if a known block is present in the raw text but its marker didn't split
					// (e.g. wrapped/renamed header), it'd be silently swallowed into a neighbor segment. So we
					// also probe the raw text for each block independently and flag any that the split MISSED,
					// and reconcile total classified vs whole. This is why a CLAUDE.md that IS loaded but not
					// shown becomes visible as a "present but unsplit" note instead of vanishing.
					const claudeInText = /## Project & user instructions \(CLAUDE\.md\)/.test(spText);
					const claudeSplit = hits.some((h) => h.label.startsWith("CLAUDE.md"));
					if (claudeInText && !claudeSplit) spRows.push([`⚠ CLAUDE.md present but unsplit`, `see raw`]);
					if (!claudeInText)
						spRows.push([`  (no CLAUDE.md in prompt — cwd has none, or session predates it)`, ``]);
					lines.push(card("SYSTEM PROMPT · what's inside (estimated)", spRows));
				}
			} catch {}

			// Card 4 — conversation history (grows during the session).
			try {
				const msgs: any[] = (ctx.sessionManager?.messages ?? pi.messages ?? []) as any[];
				if (Array.isArray(msgs) && msgs.length) {
					const histTok = msgs.reduce((a, m) => a + est(JSON.stringify(m?.content ?? m ?? "")), 0);
					lines.push(
						card("HISTORY · conversation", [
							["messages", String(msgs.length)],
							["est. tokens", `~${fmt(histTok)}  (grows each turn; LCM compacts when large)`],
						]),
					);
				}
			} catch {}

			const out = lines.join("\n\n");
			ctx.ui.notify(out, "info");
			return out;
		},
	});
}
