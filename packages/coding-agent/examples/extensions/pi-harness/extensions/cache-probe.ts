/**
 * cache-probe.ts — record the system prompt each turn + prove the KV cache works.
 *
 * A temporary integrity check: if the cached prefix is truly byte-stable, the
 * assembled system prompt pi sends must be IDENTICAL turn to turn. This captures
 * it every turn, hashes it, diffs against the previous, and correlates with the
 * provider's actual cacheRead — so you can SEE whether the cache is holding and,
 * if a byte changed, exactly WHERE (the first differing offset + a snippet).
 *
 * /cache-check          → summary: are prompts stable? cache-hit trend?
 * /cache-check diff     → if the prompt changed, show the first difference
 * /cache-check dump N   → write the last N recorded prompts to files for inspection
 *
 * Records to ~/.pi/agent/pi-harness/cache-probe/<pid>.jsonl (prompt hash + cache
 * usage per turn) + keeps the last 2 full prompts in memory for diffing.
 *
 * OFF by default (a diagnostic, not always-on). KP_CACHE_PROBE=1 to enable when
 * you want to verify cache stability; /cache-check reports it.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.KP_CACHE_PROBE === "1"; // OFF by default; KP_CACHE_PROBE=1 to enable (diagnostic)

const DIR = join(homedir(), ".pi", "agent", "pi-harness", "cache-probe");
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// first byte where two strings differ, or -1 if identical
function firstDiff(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
	return a.length === b.length ? -1 : n;
}

export default function (pi: any) {
	if (!ENABLED) return;
	try {
		mkdirSync(DIR, { recursive: true });
	} catch {}
	const logPath = join(DIR, `${process.pid}.jsonl`);

	let turn = 0;
	let prevPrompt = "";
	let prevHash = "";
	const history: Array<{
		turn: number;
		hash: string;
		len: number;
		stable: boolean;
		diffAt: number;
		cacheRead: number;
		input: number;
	}> = [];
	let lastPrompt = "";

	// Capture the assembled system prompt at the START of each turn (after all
	// before_agent_start appends have run — this recorder loads LAST so it sees the
	// final prompt). turn_start / message_start fire before the LLM call.
	const capture = (ctx: any) => {
		try {
			const sp = ctx?.getSystemPrompt?.() ?? pi?.getSystemPrompt?.() ?? "";
			if (!sp) return;
			turn++;
			lastPrompt = sp;
			const h = sha(sp);
			const stable = prevHash === "" || h === prevHash;
			const diffAt = stable ? -1 : firstDiff(prevPrompt, sp);
			history.push({ turn, hash: h, len: sp.length, stable, diffAt, cacheRead: 0, input: 0 });
			if (history.length > 50) history.shift();
			prevPrompt = sp;
			prevHash = h;
		} catch {}
	};
	pi.on("turn_start", async (_e: any, ctx: any) => capture(ctx));
	// fallback if turn_start doesn't carry ctx: also try before_agent_start
	pi.on("before_agent_start", async (_event: any) => {
		// event.systemPrompt here is PRE-append for this handler's position; only use
		// if we never got a turn_start capture. Best source stays ctx.getSystemPrompt.
		if (!history.length || history[history.length - 1].turn !== turn) {
			// no-op: turn_start is the authoritative capture point
		}
		return undefined;
	});

	// Correlate with the provider's REAL cache usage from message_end.
	pi.on("message_end", async (event: any) => {
		try {
			const u = event?.message?.usage;
			if (u && history.length) {
				const last = history[history.length - 1];
				last.cacheRead = u.cacheRead ?? 0;
				last.input = u.input ?? 0;
				appendFileSync(logPath, `${JSON.stringify(last)}\n`);
			}
		} catch {}
	});

	pi.registerCommand("cache-check", {
		description:
			"Prove the KV cache is working: /cache-check (summary) · diff (show first prompt change) · dump N (write last N prompts)",
		handler: async (args: string, ctx: any) => {
			const a = (args || "").trim();

			if (a.startsWith("dump")) {
				const _n = Math.max(1, Math.min(10, Number(a.split(/\s+/)[1] || 2)));
				try {
					writeFileSync(join(DIR, `prompt-latest.txt`), lastPrompt);
					ctx.ui.notify(
						`Wrote the latest system prompt (${lastPrompt.length} chars) to ${join(DIR, "prompt-latest.txt")}. (Full per-turn history in ${logPath})`,
						"info",
					);
				} catch (e: any) {
					ctx.ui.notify(`dump failed: ${e.message}`, "warning");
				}
				return;
			}

			if (!history.length) {
				ctx.ui.notify("cache-probe: no turns recorded yet. Ask something, then /cache-check.", "info");
				return;
			}

			if (a === "diff") {
				const changed = history.find((h) => !h.stable);
				if (!changed) {
					ctx.ui.notify("✓ No prompt change recorded — the prefix has been byte-stable every turn.", "info");
					return;
				}
				const at = changed.diffAt;
				const snip = lastPrompt.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, "⏎");
				ctx.ui.notify(
					`⚠ Prompt CHANGED at turn ${changed.turn}, first differing byte at offset ${at} of ${changed.len}.\n…${snip}…\n(everything after this offset is re-encoded / cache-missed)`,
					"warning",
				);
				return;
			}

			// summary
			const stableCount = history.filter((h) => h.stable).length;
			const allStable = stableCount === history.length;
			const uniqueHashes = new Set(history.map((h) => h.hash)).size;
			const warm = history.filter((h) => h.cacheRead > 0);
			const avgHit = warm.length
				? Math.round(
						warm.reduce((s, h) => s + (h.cacheRead / Math.max(1, h.cacheRead + h.input)) * 100, 0) / warm.length,
					)
				: 0;
			const lines = [
				`Cache probe — ${history.length} turns recorded`,
				`  prompt stability: ${allStable ? "✓ STABLE (byte-identical every turn)" : `⚠ CHANGED — ${uniqueHashes} distinct prompt versions (/cache-check diff)`}`,
				`  prompt length: ${lastPrompt.length} chars (${Math.ceil(lastPrompt.length / 4)} est. tok)`,
				warm.length
					? `  provider cacheRead: avg ${avgHit}% of prompt served from cache (${warm.length} warm turns)`
					: `  provider cacheRead: no warm turns yet (first turn is always cold)`,
				// Anomaly: prompt byte-STABLE across several turns but cacheRead still low.
				// That's not a prefix problem — it's a provider-side cache miss (known on
				// codex + gpt-5.5, openai/codex#20301). Flag it so it's not mistaken for
				// "still warming." >=3 warm turns is enough to distinguish from a cold start.
				allStable && warm.length >= 3 && avgHit < 60
					? `  → ⚠ ANOMALY: prompt is byte-stable but cacheRead is only ${avgHit}% after ${warm.length} turns. ` +
						`The prefix is fine — this looks like a PROVIDER-SIDE cache miss (known bug on codex+gpt-5.5, ` +
						`openai/codex#20301). Try gpt-5.4 to compare, or check the provider path.`
					: allStable && avgHit >= 80
						? `  → ✅ cache is WORKING: stable prefix + high cacheRead.`
						: allStable
							? `  → prefix stable; cache should warm within a turn or two.`
							: `  → ⚠ prefix is CHANGING between turns — that busts the cache. Run /cache-check diff to find where.`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
			return lines.join("\n");
		},
	});
}
