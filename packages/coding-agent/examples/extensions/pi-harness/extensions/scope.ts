/**
 * scope.ts — the SCOPE phase: task → the relevant slice of the codebase, up front.
 *
 * Gap C in the AI-DLC: the retrieval tools exist (codemap_query, knowledge_*,
 * grep) but nothing SEQUENCES them as a "scope" step before implement — the model
 * has to remember to gather context. This makes scope a first-class, one-call
 * phase: given a task, assemble a compact, connected context bundle (the files /
 * symbols / flow it will touch) so implement starts hydrated, not groping.
 *
 * It's a thin orchestrator over what's already there, best-source-first:
 *   1. codemap_query (if enabled) — connected bundle, budgeted, from the real graph
 *   2. else knowledge_code_search via the KP CLI — cited connected code
 *   3. else a ranked grep fallback — identifier hits grouped by file
 * Returns a short "scope report": the candidate files/symbols + where to start.
 * Never edits; pure retrieval. Pairs with plan-mode (scope → plan → implement).
 *
 * `scope` tool + /scope command. Cache-cheap (one tool schema).
 *
 * Empty-result recheck (rank 25): a ZERO-hit knowledge/grep scan triggers ONE
 * refresh-then-retry (dir mtime moved since a cached scan → the scan is stale)
 * before we report "not found" — the INDEX_STALE recoverable-error discipline.
 * Grep scans are cached with invalidate-on-mutate keyed by DIR-PREFIX (scan-cache),
 * so our own edits drop exactly the affected scans (no TTL).
 *
 * Config: KP_SCOPE_ENABLED=0 disable · KP_SCOPE_BUDGET (bundle token budget, 2500)
 *   · KP_CODEMAP_BIN / KP_SCOPE_GREP_MAX · KP_SCOPE_RECHECK=0 disable the recheck.
 */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachInvalidation, invalidateForPath, get as scanGet, put as scanPut } from "./scan-cache.ts";

const ENABLED = process.env.KP_SCOPE_ENABLED !== "0";
const BUDGET = Number(process.env.KP_SCOPE_BUDGET || 2500);
const CODEMAP_BIN = process.env.KP_CODEMAP_BIN || "codemap";
const GREP_MAX = Number(process.env.KP_SCOPE_GREP_MAX || 40);
const RECHECK = process.env.KP_SCOPE_RECHECK !== "0"; // empty-result refresh-then-retry

function have(cmd: string): boolean {
	try {
		execSync(`command -v ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
function sh(cmd: string, cwd: string, timeout = 60_000): string {
	try {
		return execSync(cmd, {
			cwd,
			encoding: "utf-8",
			timeout,
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (e: any) {
		return (e.stdout || "").toString();
	}
}

// 1) codemap connected bundle (best): only when codemap is enabled + on PATH.
function scopeViaCodemap(task: string, cwd: string): string | null {
	if (process.env.KP_CODEMAP_ENABLED !== "1" || !have(CODEMAP_BIN)) return null;
	const out = sh(
		`${CODEMAP_BIN} query ${JSON.stringify(task)} --root ${JSON.stringify(cwd)} --mode compact --budget ${BUDGET}`,
		cwd,
		90_000,
	);
	return out.trim() ? out.slice(0, 12000) : null;
}

// 2) KP knowledge_code_search via its CLI (cited connected code).
function scopeViaKnowledge(task: string, cwd: string): string | null {
	try {
		const mcp = existsSync(join(cwd, "knowledge-platform", ".mcp.json"))
			? join(cwd, "knowledge-platform", ".mcp.json")
			: join(cwd, ".mcp.json");
		if (!existsSync(mcp)) return null;
		const spec = JSON.parse(sh(`cat ${JSON.stringify(mcp)}`, cwd)).mcpServers?.knowledge;
		if (!spec?.command) return null;
		const bin = join(cwd, "knowledge-platform", spec.command);
		if (!existsSync(bin)) return null;
		const out = sh(
			`${bin} code-search ${JSON.stringify(task)} 2>/dev/null || ${bin} search ${JSON.stringify(task)} 2>/dev/null || true`,
			join(cwd, "knowledge-platform"),
			60_000,
		);
		return out.trim() ? out.slice(0, 10000) : null;
	} catch {
		return null;
	}
}

// 3) ranked grep fallback: identifier-ish tokens from the task → hits by file.
// Cached in scan-cache keyed by the cwd it covers; invalidate-on-mutate (dir-prefix)
// drops it when our own edits touch under cwd — no TTL. Returns "" on zero hits so
// the caller's refresh-then-retry can kick in.
function scopeViaGrep(task: string, cwd: string): string {
	const tokens = [
		...new Set(
			(task.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).filter(
				(w) =>
					!/^(the|this|that|with|from|into|when|make|sure|should|would|could|about|there|their|which|what|does|need|want|only|also|please|files?|code|function|method|class)$/i.test(
						w,
					),
			),
		),
	].slice(0, 6);
	if (!tokens.length) return "(no searchable terms in the task)";
	const cacheKey = `scope:grep:${cwd}:${tokens.join(",")}`;
	const cached = scanGet(cacheKey);
	if (cached !== null) return cached;
	const tool = have("rg") ? "rg" : "grep -rn";
	const byFile: Record<string, number> = {};
	for (const tok of tokens) {
		const out = sh(`${tool} ${have("rg") ? "-n" : ""} ${JSON.stringify(tok)} . 2>/dev/null | head -200`, cwd);
		for (const line of out.split("\n")) {
			const f = line.split(":")[0];
			if (f && !f.includes("node_modules") && !f.startsWith("./.git")) byFile[f] = (byFile[f] || 0) + 1;
		}
	}
	const ranked = Object.entries(byFile)
		.sort((a, b) => b[1] - a[1])
		.slice(0, GREP_MAX);
	const result = ranked.length
		? `Relevant files for [${tokens.join(", ")}] (by hit count):\n` +
			ranked.map(([f, n]) => `  ${f} (${n})`).join("\n")
		: ""; // empty → let the caller refresh-then-retry before declaring "not found"
	scanPut(cacheKey, result, [cwd]); // covered dir = cwd; dropped on edits under it
	return result;
}

// Has anything under cwd changed since `since` (ms epoch)? A cheap stale-ish probe
// for the empty-result recheck: if the tree moved after a scan came back empty, the
// scan may simply be looking at a stale index/cache — worth one refresh+retry.
function treeChangedSince(cwd: string, since: number): boolean {
	try {
		return statSync(cwd).mtimeMs > since;
	} catch {
		return true;
	}
}

// Record the scope result to the shared discovery ledger so plan/implement stages
// don't re-scope (dlc-context.ts's file; same run dir keyed by A2A_RUN).
function recordScope(task: string, report: string): void {
	try {
		const run = process.env.A2A_RUN || `run-${process.pid}`;
		const p = join(homedir(), ".pi", "agent", "pi-harness", "a2a", run, "dlc-ledger.jsonl");
		mkdirSync(join(p, ".."), { recursive: true });
		appendFileSync(
			p,
			`${JSON.stringify({
				kind: "scope",
				key: task.slice(0, 120),
				text: report.slice(0, 4000),
				by: process.env.A2A_ID || "scope",
				ts: new Date().toISOString(),
			})}\n`,
		);
	} catch {}
}

// One refresh pass for the knowledge/codemap indices: reindex this repo through KP
// (best-effort) so a stale index that returned nothing gets a chance to be current.
function refreshIndex(cwd: string): void {
	try {
		const mcp = existsSync(join(cwd, "knowledge-platform", ".mcp.json"))
			? join(cwd, "knowledge-platform", ".mcp.json")
			: join(cwd, ".mcp.json");
		if (!existsSync(mcp)) return;
		const spec = JSON.parse(sh(`cat ${JSON.stringify(mcp)}`, cwd)).mcpServers?.knowledge;
		if (!spec?.command) return;
		const bin = join(cwd, "knowledge-platform", spec.command);
		if (!existsSync(bin)) return;
		sh(
			`${bin} index-repo ${JSON.stringify(cwd)} 2>/dev/null || ${bin} reindex 2>/dev/null || true`,
			join(cwd, "knowledge-platform"),
			90_000,
		);
	} catch {}
}

function scope(task: string, cwd: string): { source: string; report: string } {
	const cm = scopeViaCodemap(task, cwd);
	if (cm) {
		recordScope(task, cm);
		return { source: "codemap (connected bundle)", report: cm };
	}
	let kp = scopeViaKnowledge(task, cwd);
	// Empty-result recheck: knowledge came back nothing — if the tree moved recently
	// (stale-ish index), refresh ONCE and retry before falling through (INDEX_STALE).
	if (!kp && RECHECK && treeChangedSince(cwd, Date.now() - 6 * 3600_000)) {
		refreshIndex(cwd);
		kp = scopeViaKnowledge(task, cwd);
		if (kp) {
			recordScope(task, kp);
			return { source: "knowledge (cited code, after refresh)", report: kp };
		}
	}
	if (kp) {
		recordScope(task, kp);
		return { source: "knowledge (cited code)", report: kp };
	}
	let g = scopeViaGrep(task, cwd);
	// grep returned zero hits — one refresh+retry (a mid-session index/cache may have
	// been stale) before we tell the model "no hits".
	if (!g && RECHECK) {
		refreshIndex(cwd);
		invalidateForPath(join(cwd, "_"));
		g = scopeViaGrep(task, cwd);
	}
	const report = g || `searched the task terms — no hits. Start from the entry points / a broad read.`;
	recordScope(task, report);
	return { source: g ? "grep (fallback)" : "grep (fallback, empty)", report };
}

export default function (pi: any) {
	if (!ENABLED) return;

	// invalidate-on-mutate: our own edits drop the dir-prefixed grep-scan cache.
	attachInvalidation(pi);

	pi.registerTool({
		name: "scope",
		label: "scope",
		description:
			"SCOPE a task before implementing: assemble the relevant slice of the codebase (candidate files/symbols + " +
			"connected code) so you start hydrated instead of groping. Uses the best available source (codemap connected " +
			"bundle → knowledge cited code → ranked grep). Call this FIRST on a non-trivial task, then plan/implement.",
		promptSnippet:
			"scope(task) — gather the relevant files/symbols/context for a task before implementing (retrieve-first)",
		parameters: {
			type: "object",
			properties: { task: { type: "string", description: "what you're about to work on" } },
			required: ["task"],
		},
		async execute(_id: string, p: any) {
			const t = String(p?.task ?? "").trim();
			if (!t) return { content: [{ type: "text", text: "scope needs a task description" }] };
			const { source, report } = scope(t, process.cwd());
			return {
				content: [
					{
						type: "text",
						text: `# Scope [${source}]\nTask: ${t}\n\n${report}\n\n→ Now plan/implement against these; read the specific files you'll change.`,
					},
				],
			};
		},
	});

	pi.registerCommand("scope", {
		description: "Scope a task: /scope <what you're about to work on> — gather the relevant files/context first",
		handler: async (args: string, ctx: any) => {
			const t = (args || "").trim();
			if (!t) {
				ctx.ui.notify("Usage: /scope <task>", "info");
				return;
			}
			ctx.ui.notify(`Scoping: ${t}…`, "info");
			const { source, report } = scope(t, process.cwd());
			ctx.ui.notify(`Scope [${source}]:\n${report}`, "info");
			return `# Scope [${source}]\n${report}`;
		},
	});
}
