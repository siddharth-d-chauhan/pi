/**
 * claude-md.ts — load CLAUDE.md project/user instructions into pi's context (Claude Code parity).
 *
 * THE GAP (code-verified): pi has NO native CLAUDE.md loader, and neither did the extensions.
 * rules.ts *reads* CLAUDE.md — but only to SUPPRESS rules whose text already lives in it
 * ("don't double-inject standing constraints the base prompt already carries"). That comment
 * is wrong: nothing ever put CLAUDE.md in the base prompt. So today CLAUDE.md is a dead file in
 * pi — never sent to the model, yet silently muting matching /omfg rules. This extension closes
 * the gap: it actually LOADS CLAUDE.md the way Claude Code does, so the assumption becomes true.
 *
 * WHAT IT LOADS (merged, in precedence order — nearest-wins reading order, all concatenated):
 *   1. Global   ~/.claude/CLAUDE.md         (user-level, applies across projects)
 *   2. Ancestors …/CLAUDE.md up the tree    (monorepo root → subpackage; parent-dir walk)
 *   3. Project  ./CLAUDE.md                  (cwd — the most specific)
 * De-duped by resolved path (a file found twice in the walk is injected once). No @import
 * expansion (out of scope) — @path lines are left as literal text.
 *
 * HOW (KV-cache-safe): injected into the SYSTEM PROMPT via before_agent_start, read ONCE at
 * session start and cached as a constant — exactly like Claude Code, and it rides the permanent
 * prefix without per-turn churn. The block is wrapped in the kp-sentinel provenance badge
 * (⸢kp:claude-md⸣…) because it's FOUND CONTENT (files on disk that could carry a forged marker);
 * wrapInjection strips any inner sentinel before badging.
 *
 * Config: KP_CLAUDEMD=0 disables. KP_CLAUDEMD_MAXKB caps total injected size (default 64KB) so a
 * runaway file can't blow the prefix. Load order: AFTER kp-sentinel (imports wrapInjection).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { wrapInjection } from "./kp-sentinel.ts";

const ENABLED = process.env.KP_CLAUDEMD !== "0";
const MAX_BYTES = Math.max(1, parseInt(process.env.KP_CLAUDEMD_MAXKB || "64", 10)) * 1024;

/** Ancestor CLAUDE.md paths from the filesystem root DOWN to cwd (root-first, so the most
 * specific file is read last and reads as the final word). Stops at the home dir or FS root. */
function ancestorClaudeMds(cwd: string): string[] {
	const stop = homedir();
	const chain: string[] = [];
	let dir = resolve(cwd);
	// Walk UP collecting dirs, then reverse so we emit root→cwd (least→most specific).
	const dirs: string[] = [];
	for (;;) {
		dirs.push(dir);
		if (dir === stop) break; // don't walk above the home dir
		const parent = dirname(dir);
		if (parent === dir) break; // hit FS root
		dir = parent;
	}
	for (const d of dirs.reverse()) {
		const p = join(d, "CLAUDE.md");
		if (existsSync(p)) chain.push(p);
	}
	return chain;
}

/** All CLAUDE.md source paths in injection order: global first, then root→cwd ancestors
 * (which includes the project ./CLAUDE.md as the last, most-specific entry). De-duped. */
function claudeMdPaths(cwd: string): string[] {
	const paths: string[] = [];
	const global = join(homedir(), ".claude", "CLAUDE.md");
	if (existsSync(global)) paths.push(global);
	for (const p of ancestorClaudeMds(cwd)) paths.push(p);
	// de-dupe by resolved path, preserve first occurrence
	const seen = new Set<string>();
	return paths.filter((p) => {
		const r = resolve(p);
		if (seen.has(r)) return false;
		seen.add(r);
		return true;
	});
}

// Per-file byte cap. A hierarchy total-cap that truncated the LAST (deepest) entries would make
// the block change shape as you cd (the cwd portion appears/vanishes) — a cache-buster. Instead
// cap EACH file independently, so a given file renders to the SAME bytes no matter what else is
// loaded. MAX_BYTES stays a safety backstop on the grand total.
const PER_FILE_BYTES = Math.max(1024, Math.floor(MAX_BYTES / 2));

/** Render ONE CLAUDE.md file to its chunk — identical bytes regardless of cwd (label is
 * ~-relative so it's machine- and cwd-independent; body is per-file capped, not total-capped). */
function renderChunk(p: string): { chunk: string; label: string } | null {
	let body = "";
	try {
		const raw = readFileSync(p, "utf-8");
		body = raw.length > PER_FILE_BYTES ? `${raw.slice(0, PER_FILE_BYTES)}\n…[truncated]` : raw;
	} catch {
		return null;
	}
	body = body.trim();
	if (!body) return null;
	const home = homedir();
	const label = p.startsWith(join(home, ".claude")) ? "~/.claude/CLAUDE.md (global)" : p.replace(home, "~");
	return { chunk: `### ${label}\n${body}`, label };
}

/** Concatenate all CLAUDE.md sources in GLOBAL → dir → subdir order (least→most specific).
 *
 * KV-CACHE INVARIANT: this fixed ordering means descending into a subdir only APPENDS the
 * subdir's chunk to the end — the global + ancestor chunks (the long prefix) are byte-identical
 * to what a shallower cwd produced, so that whole prefix stays cached. Each chunk is rendered
 * cwd-independently (renderChunk), and truncation is per-file, so no chunk's bytes shift because
 * of where you are. Only the newly-appended deepest chunk is "new" to the cache. */
function buildClaudeMd(cwd: string): { text: string; sources: string[] } {
	const parts: string[] = [];
	const sources: string[] = [];
	let total = 0;
	for (const p of claudeMdPaths(cwd)) {
		// already global→root→…→cwd (see claudeMdPaths)
		const r = renderChunk(p);
		if (!r) continue;
		if (total + r.chunk.length > MAX_BYTES) break; // grand-total backstop (drops deepest first)
		parts.push(r.chunk);
		sources.push(r.label);
		total += r.chunk.length;
	}
	if (!parts.length) return { text: "", sources: [] };
	const header =
		"## Project & user instructions (CLAUDE.md)\n" +
		"Standing instructions for this project/user, in GLOBAL → project → subdirectory order " +
		"(more-specific overrides less-specific). Treat as authoritative unless the user overrides " +
		"them in this session.\n\n";
	return { text: header + parts.join("\n\n"), sources };
}

// ── WRITE half (Claude Code's `#` add) — CLAUDE.md as the common editable place ──────────
// Two levels, both auto-injected: repo ./CLAUDE.md and system ~/.claude/CLAUDE.md. An add goes
// to one of them; the read half already merges both, so a written line is live next turn.

const REPO_PATH = () => join(process.cwd(), "CLAUDE.md");
const SYSTEM_PATH = () => join(homedir(), ".claude", "CLAUDE.md");

// Section that user-added memories land under (Claude Code appends under a memory heading).
const ADD_HEADING = "## Added memories";

/** Append a bullet to the repo or system CLAUDE.md, under the ADD_HEADING section (created if
 * absent). Returns the path written. Creates the file (and ~/.claude dir) if missing. */
function appendMemory(text: string, level: "repo" | "system"): string {
	const path = level === "system" ? SYSTEM_PATH() : REPO_PATH();
	const bullet = `- ${text.trim()}`;
	let body = "";
	try {
		body = existsSync(path) ? readFileSync(path, "utf-8") : "";
	} catch {
		body = "";
	}
	if (body.includes(ADD_HEADING)) {
		// insert the bullet right after the heading line
		body = body.replace(ADD_HEADING, `${ADD_HEADING}\n${bullet}`);
	} else {
		body = `${body.trimEnd()}\n\n${ADD_HEADING}\n${bullet}\n`.trimStart();
	}
	if (level === "system") mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, "utf-8");
	return path;
}

/** Split a CLAUDE.md body into normalized instruction bullets (for conflict scanning). */
function bullets(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.replace(/^[-*]\s+/, "").trim())
		.filter((l) => l.length > 12 && !l.startsWith("#"));
}

// A cheap lexical conflict signal: two bullets share several salient keywords but one carries a
// negation/opposite the other doesn't. Not a semantic judge — a heuristic FLAG, so the user (or
// the model) can look. False positives are fine; the point is to never SILENTLY let repo and
// system instructions contradict.
const OPPOSITES: Array<[RegExp, RegExp]> = [
	[/\balways\b/i, /\bnever\b/i],
	[/\benable\b|\benabled\b|\bon\b/i, /\bdisable\b|\bdisabled\b|\boff\b/i],
	[/\bprefer\b|\buse\b/i, /\bavoid\b|\bdon'?t use\b|\bdo not use\b/i],
	[/\brequire\b|\bmust\b/i, /\boptional\b|\bmay\b|\bdon'?t\b/i],
	[/\btabs?\b/i, /\bspaces?\b/i],
	[/\bglobal\b/i, /\btenant-?scoped\b|\bper-?tenant\b/i],
];
function keywords(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter(
				(w) =>
					w.length > 3 &&
					![
						"with",
						"this",
						"that",
						"from",
						"must",
						"should",
						"have",
						"when",
						"then",
						"will",
						"your",
						"using",
					].includes(w),
			),
	);
}
function overlap(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const w of a) if (b.has(w)) n++;
	return n;
}

/** Find repo↔system bullet pairs that share topic keywords but carry an opposite polarity. */
function findConflicts(repoText: string, sysText: string): Array<{ repo: string; system: string }> {
	const R = bullets(repoText),
		S = bullets(sysText);
	const out: Array<{ repo: string; system: string }> = [];
	for (const r of R) {
		const rk = keywords(r);
		for (const s of S) {
			if (overlap(rk, keywords(s)) < 2) continue; // must be about the same thing
			const opposed = OPPOSITES.some(([x, y]) => (x.test(r) && y.test(s)) || (y.test(r) && x.test(s)));
			if (opposed) out.push({ repo: r, system: s });
		}
	}
	return out;
}

/** Read repo + system CLAUDE.md (raw) for conflict scanning. */
function rawLevels(): { repo: string; system: string } {
	const read = (p: string) => {
		try {
			return existsSync(p) ? readFileSync(p, "utf-8") : "";
		} catch {
			return "";
		}
	};
	return { repo: read(REPO_PATH()), system: read(SYSTEM_PATH()) };
}

export default function (pi: any) {
	if (!ENABLED) return;

	// Read once at session start; inject as a cache-stable system-prompt constant (Claude Code
	// parity). before_agent_start may fire per turn, so compute lazily+cache to keep the prefix
	// byte-identical across turns (KV-cache safe).
	// KV-CACHE DISCIPLINE: the injected block rides the PERMANENT system-prompt prefix. It MUST be
	// byte-identical across every turn or the whole prefix cache misses. So we build it exactly
	// ONCE (first before_agent_start), memoize the finished string, and thereafter append that same
	// string verbatim — no per-turn file reads, no per-turn recomputation. The ONLY things that
	// change it are an explicit invalidate() (a `#`/add/init write), which is a deliberate,
	// user-caused prefix change (like editing CLAUDE.md in Claude Code) — a one-time re-stabilize,
	// not per-turn thrash.
	let cached: string | null = null; // the finished wrapped block (append verbatim)
	let notified = false; // fire the load/conflict notice ONCE, not per turn

	const build = () => {
		const built = buildClaudeMd(process.cwd());
		cached = built.text ? wrapInjection("claude-md", built.text) : "";
		if (!notified && cached) {
			// conflict scan + notify: ONCE at first build (side-effect only — never touches the bytes).
			const { repo, system } = rawLevels();
			const conflicts = repo && system ? findConflicts(repo, system) : [];
			const note = conflicts.length
				? `  ⚠ ${conflicts.length} repo↔system conflict${conflicts.length === 1 ? "" : "s"} — /claude-md conflicts`
				: "";
			pi.ctx?.ui?.notify?.(
				`CLAUDE.md loaded: ${built.sources.length} source(s) (${built.sources.join(", ")})${note}`,
				conflicts.length ? "warn" : "info",
			);
			notified = true;
		}
	};
	// ONGOING-SESSION CACHE SAFETY: the prefix (system prompt) is FROZEN for the session — built
	// once, NEVER invalidated mid-session. A mid-session write mutating the prefix would bust the
	// KV cache for everything below the CLAUDE.md block (position ~7 of the system prompt) — i.e.
	// the whole conversation history — a full re-encode that turn. So a `#`-add does NOT touch the
	// prefix. It only (a) writes the file (durable → folds into the prefix on the NEXT session,
	// rebuilt fresh), and (b) leaves your `# …` line in the turn as normal input — which is already
	// in the cached conversation, so the model sees the instruction this session with ZERO extra
	// injection and ZERO cache churn. No tail re-inject (that would duplicate your own message).
	pi.on("before_agent_start", async (event: any) => {
		if (cached === null) build(); // built ONCE per session; never invalidated after
		return { systemPrompt: (event.systemPrompt ?? "") + (cached || "") };
	});

	// The ONLY way to re-inject CLAUDE.md mid-session: an EXPLICIT /claude-md reload. This
	// deliberately rebuilds the prefix from disk (a one-time cache re-warm) — never automatic.
	const reload = () => {
		cached = null;
		notified = false;
	};

	// `#`-prefix add (Claude Code parity): `# <text>` (or `## ` for system level) writes the rest
	// as a standing CLAUDE.md memory to the FILE, then strips the leading `#` and lets the text
	// continue as your normal message — so it stays in the (cached) conversation and the model
	// reads it this session, while the file carries it durably into next session's prefix. No
	// prefix invalidation, no tail duplication.
	pi.on("input", (event: any) => {
		const text = String(event?.text ?? "");
		const m = text.match(/^(#{1,2})\s+(.+)$/s);
		if (!m) return;
		const level: "repo" | "system" = m[1] === "##" ? "system" : "repo";
		const path = appendMemory(m[2], level);
		pi.ctx?.ui?.notify?.(
			`Saved to ${level} CLAUDE.md (${path.replace(homedir(), "~")}) — in this turn now, in the cached prefix next session.`,
			"info",
		);
		// Keep the instruction in the turn (minus the `#` marker) → it's naturally in cached history;
		// no separate injection, so the prefix cache is untouched.
		return { action: "transform", text: m[2] };
	});

	// /claude-md [add <text> | add --global <text> | conflicts] — show, add, or audit.
	pi.registerCommand?.("claude-md", {
		description: "CLAUDE.md: show what's loaded · add <text> (repo) · add --global <text> · reload · conflicts",
		handler: async (args: string) => {
			const a = (args || "").trim();
			if (a.startsWith("add")) {
				const rest = a.replace(/^add\s*/, "");
				const global = /^--global\b/.test(rest);
				const body = rest.replace(/^--global\s*/, "").trim();
				if (!body) return "Usage: /claude-md add <text>   (or: add --global <text> for ~/.claude/CLAUDE.md)";
				const path = appendMemory(body, global ? "system" : "repo");
				// Written to the file, NOT re-injected — CLAUDE.md loads once per session. It applies
				// next session automatically, or now if you run `/claude-md reload` (a deliberate cache
				// re-warm). This keeps the prefix cache intact for the rest of this session.
				return (
					`Added to ${global ? "system" : "repo"} CLAUDE.md → ${path.replace(homedir(), "~")}\n` +
					`Loads on the next session (prefix is injected once per session, cache-stable). ` +
					`Run \`/claude-md reload\` to apply it now.`
				);
			}
			if (a === "reload") {
				reload();
				return "CLAUDE.md will be re-read and re-injected on the next turn (one-time prefix cache re-warm).";
			}
			if (a === "conflicts") {
				const { repo, system } = rawLevels();
				if (!repo || !system) return "Need both a repo ./CLAUDE.md and system ~/.claude/CLAUDE.md to compare.";
				const c = findConflicts(repo, system);
				if (!c.length) return "No repo↔system conflicts detected.";
				return (
					`⚠ ${c.length} possible repo↔system conflict(s):\n` +
					c.map((x, i) => `\n${i + 1}. repo:   ${x.repo}\n   system: ${x.system}`).join("")
				);
			}
			const built = buildClaudeMd(process.cwd());
			if (!built.text) return "No CLAUDE.md found (checked ~/.claude/CLAUDE.md and cwd + ancestors).";
			const { repo, system } = rawLevels();
			const c = repo && system ? findConflicts(repo, system) : [];
			const warn = c.length ? `\n\n⚠ ${c.length} repo↔system conflict(s) — /claude-md conflicts\n` : "";
			return `Loaded ${built.sources.length} source(s):\n- ${built.sources.join("\n- ")}${warn}\n\n${built.text}`;
		},
	});

	// /init — generate (or refresh) the repo CLAUDE.md by having the MODEL analyze the codebase
	// (Claude Code parity: /init is an agent action, not a scripted scan). It doesn't write the
	// file directly — it primes THIS turn with an instruction so pi produces CLAUDE.md using its
	// own tools + the brain. Guards an existing file unless --force. Kept intentionally bounded:
	// CLAUDE.md is the cold-start layer, not a dumping ground.
	pi.registerCommand?.("init", {
		description: "Generate ./CLAUDE.md by analyzing this repo (Claude Code /init parity). --force to overwrite.",
		handler: async (args: string, ctx: any) => {
			const force = /(^|\s)--force(\s|$)/.test(args || "");
			const path = REPO_PATH();
			if (existsSync(path) && !force) {
				return (
					`./CLAUDE.md already exists (${statSync(path).size} bytes). ` +
					`Re-run \`/init --force\` to regenerate it, or edit it directly / use \`/claude-md add\`.`
				);
			}
			// The instruction the model executes THIS turn. Bounded, section-scoped, evidence-first.
			const instruction =
				"Generate a CLAUDE.md for THIS repository and write it to ./CLAUDE.md" +
				(force ? " (overwrite the existing one)" : "") +
				".\n\n" +
				"Analyze the codebase first (structure, build/test/lint commands, the tech stack, key " +
				"directories, architecture, and any conventions you can infer from existing code). Use " +
				"your retrieval tools and the knowledge brain where useful — cite what you actually find, " +
				"don't guess.\n\n" +
				"Write CLAUDE.md as CONCISE standing instructions a fresh session needs to be productive " +
				"immediately — the cold-start layer, not documentation. Cover, only where real:\n" +
				"- One-paragraph project overview (what it is, the planes/packages)\n" +
				"- Build / test / lint / run commands (exact, copy-pasteable)\n" +
				"- Architecture & key directories (where things live, how they connect)\n" +
				"- Conventions the code actually follows (style, patterns, gotchas)\n" +
				"- Any hard rules / gates (things never to do)\n\n" +
				"Keep it tight (aim for well under ~200 lines) — it rides the permanent prompt prefix, so " +
				"every line costs tokens every turn. Prefer specifics over prose. If a good CLAUDE.md " +
				"already exists, improve it rather than bloating it. After writing, tell me what you put in it.";
			if (typeof ctx?.sendUserMessage === "function") {
				await ctx.sendUserMessage(instruction);
				return; // model now runs the analysis turn
			}
			return instruction; // fallback: surface the instruction to run manually
		},
	});
}
