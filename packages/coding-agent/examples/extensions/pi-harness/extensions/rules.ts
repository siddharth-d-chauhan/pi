/**
 * rules.ts — /omfg: turn a mistake into a standing course-correction rule.
 *
 * oh-my-pi's "time-traveling stream rules" + /omfg. You type what annoyed you; the
 * system drafts a rule (a trigger pattern + a correction) from the conversation
 * where it went wrong, and registers it. Thereafter, when the model's output
 * matches the trigger, the correction is injected — course-correction without
 * paying context tax on every turn (only fires when relevant).
 *
 * Honest difference from oh-my-pi: they abort the token stream MID-generation on a
 * regex hit and retry. pi's extension seams fire around turns, not during token
 * streaming, so we inject the matched rule on the NEXT turn via the `context` hook
 * (as a trailing system-style reminder). Same outcome — the fix sticks, no
 * per-turn tax — just one turn's latency instead of mid-stream.
 *
 * Rules persist under .pi/rules/*.json (project) + ~/.pi/agent/pi-harness/rules/.
 *
 * ── LANE SPLIT vs memory.ts (they no longer overlap) ─────────────────────────
 * memory.ts and rules.ts both once grew an "always-on standing block". That is
 * memory's job, not this file's: memory captures corrections AUTOMATICALLY, stores
 * them in the governed KP brain (bi-temporal, reversible, semantically deduped), and
 * promotes recurring ones into ONE always-on digest block. So RULES owns only what
 * memory can't do — CONDITIONAL, trigger/glob-matched course-correction that fires on
 * a specific pattern mid-behavior. The sticky always-apply tier is therefore OFF by
 * default (KP_RULES_STICKY=1 to opt in, only for external .cursor/AGENTS.md docs that
 * have no trigger); the standing-correction lane lives in memory. Clean division:
 *   memory  → automatic capture · semantic · always-on digest (unconditional)
 *   rules   → explicit /omfg · trigger+glob-gated · fires on a pattern (conditional)
 *
 * ── TIERED ENGINE (adopted from oh-my-pi's rulebook + TTSR docs) ──────────────
 * The original message-regex trigger is preserved; on top of it a rule may now
 * carry richer firing conditions, all merged into ONE cache-safe context tail:
 *
 *  1. GLOB PATH-GATING     (KP_RULES_GLOBS, default ON): a rule with `globs` only
 *     fires when the file in play (from an hread/hedit tool_call) matches. A rule
 *     scoped to a Java glob (**\/*.java) never fires on a Python turn.
 *  1.5 GLOB-TRIGGERED      (same flag): a rule with `globs` but NO output trigger
 *     fires when a matching file is TOUCHED — the firing condition is the file
 *     itself, not an output pattern. This is the delivery lane for memory.ts
 *     promotions (source:"memory"): a recurring file-scoped correction compiles to
 *     one of these at write time, so it lands the moment the file is in play and
 *     costs zero tokens on every other turn.
 *  2. STICKY ALWAYS-APPLY  (KP_RULES_STICKY, default OFF — memory owns always-on):
 *     external standing docs (.cursor/AGENTS.md) with no trigger, re-injected every
 *     turn (append-only, stable order → KV prefix stays warm). Prefer memory for
 *     always-on corrections; this is only for trigger-less external rule files.
 *  3. MULTI-SOURCE         (KP_RULES_MULTISOURCE): also read AGENTS.md, .cursor/rules
 *     (+ .cursor/rules/*.mdc), and .windsurf rule files; normalize into Rule shape,
 *     dedupe by name (first-wins); skip any rule whose text already lives in CLAUDE.md.
 *  4. @IMPORT EXPANSION    (KP_RULES_IMPORTS): `@import ./path` in rule/context files
 *     is expanded inline (relative/~/absolute, 5-hop cap, cycle-skip, fenced literals
 *     left untouched).
 *  5. BELOW-CWD POINTER    (KP_RULES_POINTERS): when a turn touches a subtree that has
 *     its own rules file, emit a ONE-LINE pointer instead of inlining it.
 *  6. PER-RULE THROTTLE    (default ON): a rule fires at most once, or every-N-turns
 *     (`everyN`, persisted counter) — no repeat spam.
 *
 * Everything is injected via the `context` hook as trailing stable messages; the
 * system prompt is NEVER mutated per turn. Sticky/pointer tails are append-only and
 * emitted in stable order so the cached KV prefix stays warm (see memory.ts
 * activeMemories for the pattern this mirrors).
 *
 * Flow:
 *   /omfg <complaint>   → draft a rule from the recent transcript, verify it would
 *                         have fired, save it (shows the draft).
 *   /rules              → list active rules (all sources)
 *   /rule-remove <id>   → delete (project .pi/rules only)
 *
 * Config: KP_RULES_ENABLED=0 · KP_RULES_MODEL (drafting model, default gpt-5.4-mini)
 *   KP_RULES_GLOBS=0        disable glob path-gating
 *   KP_RULES_STICKY=1       enable always-apply constraints (emitted every turn, cache-safe)
 *   KP_RULES_MULTISOURCE=1  read AGENTS.md/.cursor/.windsurf
 *   KP_RULES_IMPORTS=1      expand @import in rule/context files
 *   KP_RULES_POINTERS=1     emit below-cwd rules-file pointers
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { wrapInjection } from "./kp-sentinel.ts"; // provenance sentinel

const ENABLED = process.env.KP_RULES_ENABLED !== "0";
const MODEL = process.env.KP_RULES_MODEL || "gpt-5.4-mini";
const GLOBS_ON = process.env.KP_RULES_GLOBS !== "0"; // tier 1 (default on)
const STICKY_ON = process.env.KP_RULES_STICKY === "1"; // tier 2
const MULTISOURCE_ON = process.env.KP_RULES_MULTISOURCE === "1"; // tier 3
const IMPORTS_ON = process.env.KP_RULES_IMPORTS === "1"; // tier 4
const POINTERS_ON = process.env.KP_RULES_POINTERS === "1"; // tier 5
const USER_DIR = join(homedir(), ".pi", "agent", "pi-harness", "rules");

type Rule = {
	id: string;
	trigger?: string; // regex/literal matched against assistant OUTPUT (tier 0)
	correction: string; // the imperative fix injected
	from?: string; // the original complaint (provenance)
	name?: string; // dedupe key across sources (tier 3); defaults to id
	globs?: string[]; // tier 1: only fire when a touched file matches one of these
	alwaysApply?: boolean; // tier 2: sticky — re-inject every N turns
	everyN?: number; // tier 6: fire at most once every N turns (0/undef = once-ever guard off → each match)
	once?: boolean; // tier 6: fire at most once per session
	source?: string; // provenance label (omfg | AGENTS.md | .cursor | .windsurf)
};

// ── @import expansion (tier 4) ──────────────────────────────────────────────
// Expand `@import ./path` lines inline. Relative paths resolve against the file's
// dir, ~ against home, absolute as-is. 5-hop cap, cycle-skip via a seen-set, and
// lines inside ``` code fences are treated as literals (never expanded).
function expandImports(text: string, baseDir: string, seen: Set<string>, depth = 0): string {
	if (!IMPORTS_ON || depth > 5) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		const fence = line.trimStart().startsWith("```");
		if (fence) {
			inFence = !inFence;
			out.push(line);
			continue;
		}
		const m = !inFence && line.match(/^\s*@import\s+(.+?)\s*$/);
		if (m) {
			let p = m[1].trim().replace(/^["']|["']$/g, "");
			if (p.startsWith("~")) p = join(homedir(), p.slice(1));
			const abs = isAbsolute(p) ? p : resolve(baseDir, p);
			if (seen.has(abs)) {
				out.push(`<!-- @import cycle skipped: ${p} -->`);
				continue;
			}
			try {
				seen.add(abs);
				const sub = readFileSync(abs, "utf-8");
				out.push(expandImports(sub, dirname(abs), seen, depth + 1));
			} catch {
				out.push(`<!-- @import unresolved: ${p} -->`);
			}
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

function readFileExpanded(path: string): string {
	try {
		const raw = readFileSync(path, "utf-8");
		return expandImports(raw, dirname(path), new Set([resolve(path)]));
	} catch {
		return "";
	}
}

// ── glob matching (tier 1) ──────────────────────────────────────────────────
// Minimal gitignore-ish glob → regex: supports **, *, ?, and comma/space lists.
function globToRe(glob: string): RegExp | null {
	try {
		let g = glob.trim();
		if (!g) return null;
		// normalise separators to /
		g = g.replace(/\\/g, "/");
		let re = "";
		for (let i = 0; i < g.length; i++) {
			const c = g[i];
			if (c === "*") {
				if (g[i + 1] === "*") {
					re += "[^\\0]*";
					i++;
					if (g[i + 1] === "/") i++;
				} else re += "[^/]*";
			} else if (c === "?") re += "[^/]";
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
			else if (".+^${}()|[]\\".includes(c)) re += `\\${c}`;
			else re += c;
		}
		// anchor: allow the pattern to match anywhere in the path tail (so "**/*.java"
		// and "*.java" and "src/**/*.java" all behave intuitively).
		return new RegExp(`(^|/)${re}$`, "i");
	} catch {
		return null;
	}
}
function ruleMatchesPath(rule: Rule, filePath: string): boolean {
	if (!rule.globs || !rule.globs.length) return true; // no glob → path-agnostic
	const norm = filePath.replace(/\\/g, "/");
	for (const g of rule.globs) {
		// allow "a,b" and "a b" lists inside one entry
		for (const part of g.split(/[,\s]+/).filter(Boolean)) {
			const re = globToRe(part);
			if (re && (re.test(norm) || re.test(`/${norm}`))) return true;
		}
	}
	return false;
}

function ruleDirs(cwd: string): string[] {
	return [USER_DIR, join(cwd, ".pi", "rules")];
}

// ── native .pi/rules/*.json loader (tier 0/1/2/6 fields honored) ─────────────
function loadNativeRules(cwd: string): Rule[] {
	const rules: Rule[] = [];
	for (const d of ruleDirs(cwd)) {
		try {
			for (const f of readdirSync(d))
				if (f.endsWith(".json")) {
					try {
						const r = JSON.parse(readFileSync(join(d, f), "utf-8")) as Rule;
						if (!r.name) r.name = r.id;
						if (!r.source) r.source = "omfg";
						rules.push(r);
					} catch {}
				}
		} catch {}
	}
	return rules;
}

// ── multi-source loaders (tier 3) ───────────────────────────────────────────
// Parse an external rules file into Rule shapes. Two shapes are supported:
//  - front-matter blocks (`--- globs: ... alwaysApply: true ---` then body), as
//    Cursor .mdc uses; each block becomes one rule.
//  - a plain markdown/agents file → one rule carrying the whole (import-expanded)
//    body as the correction, keyed by the file's basename.
function parseExternalRulesFile(path: string, label: string): Rule[] {
	const body = readFileExpanded(path);
	if (!body.trim()) return [];
	const out: Rule[] = [];
	// Cursor-style front-matter blocks: split on leading `---` fences.
	const fm = body.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (fm) {
		const meta = fm[1],
			content = fm[2].trim();
		const globs = meta.match(/globs?:\s*(.+)/i)?.[1]?.trim();
		const always = /alwaysApply:\s*true/i.test(meta);
		const desc = meta.match(/description:\s*(.+)/i)?.[1]?.trim();
		if (content) {
			out.push({
				id: `${label}:${basenameNoExt(path)}`,
				name: `${label}:${basenameNoExt(path)}`,
				correction: content,
				globs: globs ? globs.split(/[,\s]+/).filter(Boolean) : undefined,
				alwaysApply: always || undefined,
				from: desc,
				source: label,
			});
		}
		return out;
	}
	// plain file → single always-consulted rule (only surfaced sticky/pointer).
	out.push({
		id: `${label}:${basenameNoExt(path)}`,
		name: `${label}:${basenameNoExt(path)}`,
		correction: body.trim().slice(0, 4000),
		alwaysApply: true, // external standing docs behave as sticky constraints
		source: label,
	});
	return out;
}
function basenameNoExt(p: string): string {
	const b = p.split(/[\\/]/).pop() || p;
	return b.replace(/\.[^.]+$/, "");
}

function loadMultiSource(cwd: string): Rule[] {
	if (!MULTISOURCE_ON) return [];
	const found: Rule[] = [];
	const candidates: Array<[string, string]> = [
		[join(cwd, "AGENTS.md"), "AGENTS.md"],
		[join(cwd, ".windsurfrules"), ".windsurf"],
		[join(cwd, ".windsurf", "rules"), ".windsurf"],
	];
	// .cursor/rules can be a file or a directory of *.mdc
	const cursorDir = join(cwd, ".cursor", "rules");
	try {
		if (existsSync(cursorDir) && statSync(cursorDir).isDirectory()) {
			for (const f of readdirSync(cursorDir))
				if (/\.(mdc|md|txt)$/i.test(f)) candidates.push([join(cursorDir, f), ".cursor"]);
		} else if (existsSync(cursorDir)) candidates.push([cursorDir, ".cursor"]);
	} catch {}
	const legacyCursor = join(cwd, ".cursorrules");
	if (existsSync(legacyCursor)) candidates.push([legacyCursor, ".cursor"]);
	// .windsurf directory of rule files
	try {
		const wdir = join(cwd, ".windsurf", "rules");
		if (existsSync(wdir) && statSync(wdir).isDirectory()) {
			for (const f of readdirSync(wdir)) if (/\.(md|txt)$/i.test(f)) candidates.push([join(wdir, f), ".windsurf"]);
		}
	} catch {}

	for (const [p, label] of candidates) {
		try {
			if (existsSync(p) && statSync(p).isFile()) found.push(...parseExternalRulesFile(p, label));
		} catch {}
	}
	return found;
}

// Skip any rule whose text is already substantially present in CLAUDE.md.
// This is now genuinely true: claude-md.ts injects CLAUDE.md into the system prompt, so a rule
// duplicating it would double-inject the same standing constraint. (Before claude-md.ts existed
// nothing loaded CLAUDE.md and this suppression muted rules for no reason — see claude-md.ts.)
function claudeMdText(cwd: string): string {
	for (const p of [join(cwd, "CLAUDE.md"), join(homedir(), ".claude", "CLAUDE.md")]) {
		try {
			if (existsSync(p)) return readFileSync(p, "utf-8");
		} catch {}
	}
	return "";
}
function alreadyInClaudeMd(rule: Rule, claudeText: string): boolean {
	if (!claudeText) return false;
	const probe = rule.correction.trim().slice(0, 120).replace(/\s+/g, " ");
	if (probe.length < 24) return false;
	return claudeText.replace(/\s+/g, " ").includes(probe);
}

// ── merged loader: native + multi-source, dedup by name (first-wins) ─────────
function loadRules(cwd: string): Rule[] {
	const claudeText = claudeMdText(cwd);
	const seen = new Set<string>();
	const merged: Rule[] = [];
	for (const r of [...loadNativeRules(cwd), ...loadMultiSource(cwd)]) {
		const key = (r.name || r.id).toLowerCase();
		if (seen.has(key)) continue; // dedupe by name, first-wins
		if (alreadyInClaudeMd(r, claudeText)) continue; // already in base prompt
		seen.add(key);
		merged.push(r);
	}
	return merged;
}

// pull recent assistant text from the current session transcript (where the
// mistake happened) — the "time-travel" source.
function recentTranscript(ctx: any): string {
	try {
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		const texts: string[] = [];
		for (const e of entries.slice(-12)) {
			const c = e?.message?.content;
			if (Array.isArray(c)) for (const b of c) if (b.type === "text") texts.push(`[${e.message.role}] ${b.text}`);
		}
		return texts.join("\n").slice(-6000);
	} catch {
		return "";
	}
}

function draftRule(complaint: string, transcript: string): Promise<{ trigger: string; correction: string } | null> {
	return new Promise((res) => {
		const { execFileSync } = require("node:child_process");
		const { readFileSync: rf, rmSync: rm } = require("node:fs");
		const { tmpdir } = require("node:os");
		const out = join(tmpdir(), `rule-${process.pid}-${Date.now()}.txt`);
		const prompt =
			`The user is annoyed: "${complaint}"\n\nHere is the recent conversation where it went wrong:\n${transcript}\n\n` +
			`Draft a standing correction rule. Output EXACTLY two lines:\n` +
			`TRIGGER: <a short regex or literal phrase that matches the mistaken pattern in the assistant's OUTPUT>\n` +
			`CORRECTION: <one imperative sentence telling the assistant what to do instead>`;
		try {
			execFileSync("codex", ["exec", "-m", MODEL, "--skip-git-repo-check", "--output-last-message", out, prompt], {
				encoding: "utf-8",
				timeout: 60_000,
				cwd: tmpdir(),
			});
			const text = rf(out, "utf-8");
			rm(out, { force: true });
			const trig = text.match(/TRIGGER:\s*(.+)/i)?.[1]?.trim();
			const corr = text.match(/CORRECTION:\s*(.+)/i)?.[1]?.trim();
			if (trig && corr) return res({ trigger: trig, correction: corr });
			res(null);
		} catch {
			res(null);
		}
	});
}

function safeRe(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern, "i");
	} catch {
		try {
			return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
		} catch {
			return null;
		}
	}
}

// Is `child` at or below `cwd`? (tier 5 below-cwd detection)
function isBelow(cwd: string, child: string): boolean {
	const rel = relative(cwd, child);
	return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
// Nearest rules file in `dir` or an ancestor up to (but excluding) cwd — for pointer emission.
function nearestSubtreeRulesFile(cwd: string, filePath: string): string | null {
	let dir = dirname(resolve(filePath));
	const stop = resolve(cwd);
	for (let i = 0; i < 20 && dir !== stop && isBelow(stop, dir); i++) {
		for (const name of ["AGENTS.md", "CLAUDE.md", ".cursorrules", ".windsurfrules", ".pi/rules"]) {
			const p = join(dir, name);
			try {
				if (existsSync(p)) return p;
			} catch {}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

export default function (pi: any) {
	if (!ENABLED) return;

	let rules: Rule[] = loadRules(process.cwd());
	const pendingReminders: string[] = []; // tier 0/1: matched corrections for next turn

	// ── firing state ──
	let turnCount = 0;
	const stickyEmitted = new Set<string>(); // sticky rules already in the tail (append-only)
	const stickyTail: string[] = []; // append-only, stable order (tier 2)
	const lastFiredTurn = new Map<string, number>(); // rule.id → last turn it fired (tier 6)
	const firedOnce = new Set<string>(); // tier 6 `once`
	const touchedPaths: string[] = []; // files touched this turn (tier 1/5), reset each context
	const pointerEmitted = new Set<string>(); // tier 5: pointer path already surfaced

	pi.on("session_start", async () => {
		rules = loadRules(process.cwd());
		turnCount = 0;
		stickyEmitted.clear();
		stickyTail.length = 0;
		lastFiredTurn.clear();
		firedOnce.clear();
		pointerEmitted.clear();
	});

	// Mid-session reload: a rule can be created while the session runs (memory.ts promotes a
	// recurring steer to .pi/rules/mem-*.json; /omfg already reloads explicitly). A cheap
	// per-turn mtime probe on the two rule dirs picks that up without a restart.
	let ruleDirsMtime = "";
	function maybeReloadRules(): void {
		let sig = "";
		for (const d of ruleDirs(process.cwd())) {
			try {
				sig += `${statSync(d).mtimeMs}:`;
			} catch {
				sig += "0:";
			}
		}
		if (sig !== ruleDirsMtime) {
			ruleDirsMtime = sig;
			rules = loadRules(process.cwd());
		}
	}

	// Record which files the model is touching this turn (tier 1 glob-gating + tier 5
	// pointer). Reuses the hread/hedit tool_call path signal.
	const EDIT_READ_TOOLS = /^(hread|hedit|hedit_block|edit|write|read|apply_patch|str_replace)$/i;
	pi.on("tool_call", async (event: any) => {
		try {
			if (!EDIT_READ_TOOLS.test(String(event.toolName || ""))) return;
			const inp = event.input || {};
			const p = String(inp.file_path ?? inp.path ?? inp.file ?? inp.filename ?? "");
			if (p) touchedPaths.push(p);
		} catch {}
	});

	// When the model's output matches a rule trigger, queue the correction for the
	// next turn (via context). Checked on message_end (assistant output finalized).
	// Tier 1: gate by glob against the files touched this turn. Tier 6: throttle.
	pi.on("message_end", async (event: any) => {
		const m = event?.message;
		if (m?.role !== "assistant") return;
		const text = (m.content || [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");
		if (!text) return;
		for (const r of rules) {
			if (!r.trigger) continue; // sticky-only / doc rules don't match output
			const re = safeRe(r.trigger);
			if (!re?.test(text)) continue;
			// tier 1: path-gate. If the rule has globs, require a touched file to match.
			if (GLOBS_ON && r.globs && r.globs.length) {
				const anyMatch = touchedPaths.some((p) => ruleMatchesPath(r, p));
				if (!anyMatch) continue;
			}
			// tier 6: throttle
			if (!allowFire(r)) continue;
			pendingReminders.push(`⟲ Rule (${r.id}): ${r.correction}`);
		}
	});

	// tier 6 throttle: `once` fires a single time per session; `everyN` at most once
	// per N turns; default fires each match.
	function allowFire(r: Rule): boolean {
		if (r.once) {
			if (firedOnce.has(r.id)) return false;
			firedOnce.add(r.id);
			return true;
		}
		if (r.everyN && r.everyN > 1) {
			const last = lastFiredTurn.get(r.id) ?? -Infinity;
			if (turnCount - last < r.everyN) return false;
			lastFiredTurn.set(r.id, turnCount);
			return true;
		}
		return true;
	}

	// Inject queued corrections + sticky tail + below-cwd pointers on the next turn.
	// ALL cache-safe: appended as trailing messages; sticky/pointer tails are
	// append-only in stable order so the KV prefix stays warm.
	pi.on("context", async (event: any) => {
		turnCount++;
		maybeReloadRules(); // pick up rules created mid-session (memory promotions)
		const messages = event?.messages;
		if (!Array.isArray(messages)) {
			touchedPaths.length = 0;
			return;
		}

		const extra: any[] = [];

		// ── tier 1.5: glob-TRIGGERED rules — no output trigger; the touched file IS the
		// firing condition. Lands on the very next model request after a matching file
		// is read/edited (touchedPaths accumulates during the turn), throttled like any
		// other rule. This is how memory-promoted file-scoped corrections arrive on time.
		if (GLOBS_ON && touchedPaths.length) {
			for (const r of rules) {
				if (r.trigger || r.alwaysApply) continue; // output-triggered / sticky lanes
				if (!r.globs || !r.globs.length) continue;
				if (!touchedPaths.some((p) => ruleMatchesPath(r, p))) continue;
				if (!allowFire(r)) continue;
				pendingReminders.push(`⟲ Rule (${r.id}): ${r.correction}`);
			}
		}

		// ── tier 2: sticky always-apply, re-injected every N turns ──
		if (STICKY_ON) {
			// (re)build the append-only sticky tail: add any newly-seen alwaysApply rules.
			for (const r of rules) {
				if (!r.alwaysApply) continue;
				if (stickyEmitted.has(r.id)) continue;
				stickyEmitted.add(r.id);
				stickyTail.push(`- ${r.correction}${r.source && r.source !== "omfg" ? `  (${r.source})` : ""}`);
			}
			// Emit EVERY turn while stickyTail is non-empty. KV-cache discipline: transformContext
			// runs on a throwaway clone, so an intermittently-present block (turn 1, then turn 8,
			// gone on turn 9) changes the tail bytes on turns where nothing relevant happened —
			// the cache-busting anti-pattern. stickyTail is append-only, so re-emitting the whole
			// block unconditionally is byte-identical while unchanged (mirrors memory.ts); it stays
			// salient by NEVER leaving the tail, not by periodic re-surfacing.
			if (stickyTail.length) {
				extra.push({
					role: "user",
					content: [
						{
							type: "text",
							text: wrapInjection("rules", `## Standing constraints (always apply):\n${stickyTail.join("\n")}`),
						},
					],
				});
			}
		}

		// ── tier 5: below-cwd rules-file pointers ──
		if (POINTERS_ON && touchedPaths.length) {
			const cwd = process.cwd();
			const newPointers: string[] = [];
			for (const p of touchedPaths) {
				try {
					if (!isBelow(cwd, resolve(p))) continue;
					const rf = nearestSubtreeRulesFile(cwd, p);
					if (rf && !pointerEmitted.has(rf)) {
						pointerEmitted.add(rf);
						newPointers.push(`- read \`${rf}\` before editing under \`${dirname(rf)}${sep}\``);
					}
				} catch {}
			}
			if (newPointers.length) {
				extra.push({
					role: "user",
					content: [
						{
							type: "text",
							text: wrapInjection("rules", `## Subtree rules apply here:\n${newPointers.join("\n")}`),
						},
					],
				});
			}
		}

		// ── tier 0/1: matched corrections (one-shot per match, already throttled) ──
		if (pendingReminders.length) {
			const remind = [...new Set(pendingReminders)].join("\n");
			pendingReminders.length = 0;
			extra.push({
				role: "user",
				content: [
					{
						type: "text",
						text: wrapInjection("rules", `## Standing rules triggered — correct course:\n${remind}`),
					},
				],
			});
		}

		touchedPaths.length = 0; // reset per-turn touch set
		if (!extra.length) return;
		return { messages: [...messages, ...extra] };
	});

	pi.registerCommand("omfg", {
		description: "Turn a mistake into a standing rule: /omfg <what annoyed you>",
		handler: async (args: string, ctx: any) => {
			const complaint = (args || "").trim();
			if (!complaint) {
				ctx.ui.notify("Usage: /omfg <what the assistant did that annoyed you>", "warning");
				return;
			}
			ctx.ui.notify("Drafting a rule from where it went wrong…", "info");
			const transcript = recentTranscript(ctx);
			const draft = await draftRule(complaint, transcript);
			if (!draft) {
				ctx.ui.notify("Couldn't draft a rule (model/transcript unavailable).", "warning");
				return;
			}
			// verify it would have fired against the transcript
			const re = safeRe(draft.trigger);
			const wouldFire = re ? re.test(transcript) : false;
			const id = `r${Date.now().toString(36).slice(-5)}`;
			const rule: Rule = {
				id,
				name: id,
				trigger: draft.trigger,
				correction: draft.correction,
				from: complaint,
				source: "omfg",
			};
			const dir = join(process.cwd(), ".pi", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(rule, null, 2)}\n`);
			rules = loadRules(process.cwd());
			ctx.ui.notify(
				`Rule ${id} saved${wouldFire ? " ✓ (verified: would have fired on this conversation)" : ` ⚠ (didn't match the transcript — trigger may be too narrow; /rule-remove ${id} if wrong)`}:\n` +
					`  trigger: ${draft.trigger}\n  correction: ${draft.correction}\n` +
					`  (edit .pi/rules/${id}.json to add globs / alwaysApply / everyN)`,
				"info",
			);
		},
	});

	pi.registerCommand("rules", {
		description: "List standing course-correction rules (all sources)",
		handler: async (_a: string, ctx: any) => {
			rules = loadRules(process.cwd());
			if (!rules.length) {
				ctx.ui.notify("No rules. /omfg <complaint> to make one.", "info");
				return;
			}
			const fmt = (r: Rule) => {
				const tags: string[] = [];
				if (r.trigger) tags.push(`/${r.trigger}/`);
				if (r.globs?.length) tags.push(`globs:${r.globs.join(",")}`);
				if (r.alwaysApply) tags.push("alwaysApply");
				if (r.everyN) tags.push(`everyN:${r.everyN}`);
				if (r.once) tags.push("once");
				const tag = tags.length ? ` [${tags.join(" ")}]` : "";
				return `  ${r.id}${r.source && r.source !== "omfg" ? ` (${r.source})` : ""}${tag} → ${r.correction.slice(0, 80)}`;
			};
			ctx.ui.notify(`Rules:\n${rules.map(fmt).join("\n")}`, "info");
		},
	});

	pi.registerCommand("rule-remove", {
		description: "Remove a rule: /rule-remove <id>",
		handler: async (args: string, ctx: any) => {
			const id = (args || "").trim();
			let removed = false;
			for (const d of ruleDirs(process.cwd())) {
				const p = join(d, `${id}.json`);
				if (existsSync(p)) {
					rmSync(p);
					removed = true;
				}
			}
			rules = loadRules(process.cwd());
			ctx.ui.notify(
				removed ? `Removed rule ${id}.` : `No rule ${id} (external-source rules live in their own files).`,
				removed ? "info" : "warning",
			);
		},
	});
}
