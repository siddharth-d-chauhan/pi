/**
 * guardrails.ts — safety rails for destructive commands and protected files.
 *
 * Inspired by @aliou/pi-guardrails (MIT), rebuilt dependency-free and leaner:
 * - File policies: glob patterns with protection levels (noAccess blocks
 *   read/write/edit/grep/find/ls AND appearing in bash; readOnly blocks
 *   mutation), allowedPatterns exceptions, onlyIfExists.
 * - Dangerous bash: structural matchers (flag-order/grouping proof) for
 *   recursive force deletes, privilege escalation, disk destruction, broad
 *   chmod/chown, find -delete, git clean, fork bombs — plus pipe-to-shell
 *   detection (curl|sh), which upstream lacks.
 * - Interactive: allow once / allow for session / deny via ctx.ui.select when
 *   a UI exists; headless (RPC/print) blocks with an instructive reason.
 * - Audit trail (upstream lacks): every decision appended to
 *   ~/.pi/agent/pi-harness/guardrails-audit.jsonl; /guardrails shows state.
 *
 * Division of labor: gates.ts = workflow gates (draft→confirm for git/gh/deps/
 * brain writes + content-level secret scan); guardrails.ts = safety rails
 * (destructive ops, protected paths). Config: .pi/guardrails.json (project)
 * deep-merged over ~/.pi/agent/pi-harness/guardrails.json (user).
 *
 * Three capabilities adopted from oh-my-pi (all in the same bash tool_call hook
 * + a before_provider_request hook), each independently toggleable by env var:
 *   1. BASH ENV-HARDENING (KP_BASH_HARDEN, default ON) — inject non-interactive
 *      env (PAGER=cat, GIT_PAGER=cat, GIT_EDITOR=true, GIT_TERMINAL_PROMPT=0,
 *      TERM=dumb, CI=1) + conservative non-interactive flags (npm/apt) so a bash
 *      command can never deadlock waiting on a pager or a y/n prompt.
 *   2. BASH INTERCEPTOR (KP_BASH_INTERCEPT, default OFF) — when our dedicated
 *      read/edit tools are loaded, block raw single-file cat/head/tail/sed -i/
 *      grep/find-reads and point at hread/scope/grep. Conservative: only clear
 *      single-file reads, never pipelines.
 *   3. SECRET REDACTION (KP_REDACT, default ON) — redact secrets in the OUTBOUND
 *      provider payload with deterministic reversible placeholders (#SECRET_ab12#)
 *      from ~/.pi/secrets.yml + <repo>/.pi/secrets.yml (literals + regex) plus
 *      env-var-value scanning. Precompiled once; runs on every request.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config

type Protection = "noAccess" | "readOnly";
type Policy = {
	id: string;
	protection: Protection;
	patterns: string[];
	allowedPatterns?: string[];
	onlyIfExists?: boolean;
	message?: string;
	enabled?: boolean;
};
type Config = {
	policies: Policy[];
	dangerousCommands: { enabled: boolean; custom: { pattern: string; description?: string }[] };
	autoDeny: string[]; // regexes over the whole bash command — never prompted, always blocked
	writeOutsideAllow: string[]; // globs where out-of-workspace writes are fine (tmp dirs etc.)
};

const DEFAULT_CONFIG: Config = {
	policies: [
		{
			id: "secrets",
			protection: "noAccess",
			patterns: [
				"**/.env*",
				"**/*.pem",
				"**/*.key",
				"**/id_rsa*",
				"**/id_ed25519*",
				"**/.ssh/**",
				"**/.aws/**",
				"**/credentials*",
				"**/auth.json",
				"**/.netrc",
				"**/*.keystore",
				"**/*.p12",
			],
			allowedPatterns: ["**/.env.example", "**/.env.sample", "**/.env.template", "**/*.pub"],
			onlyIfExists: true,
		},
		{
			// Places where a bad write EXECUTES later. onlyIfExists:false — creating
			// a new hook/agent file is exactly the attack shape.
			id: "persistence",
			protection: "readOnly",
			patterns: [
				"~/.zshrc",
				"~/.zshenv",
				"~/.zprofile",
				"~/.bashrc",
				"~/.bash_profile",
				"~/.profile",
				"~/.config/fish/**",
				"**/.git/hooks/**",
				"~/Library/LaunchAgents/**",
				"/etc/**",
			],
			onlyIfExists: false,
			message:
				"{file} is a persistence vector (executes on login/commit/boot). Writing it needs explicit user approval.",
		},
		{
			// The guardrail protects itself: rails can't be edited off by the agent.
			id: "self-protect",
			protection: "readOnly",
			patterns: ["~/.pi/**", "**/.pi/guardrails.json", "**/pi-harness/extensions/**"],
			onlyIfExists: false,
			message: "{file} is harness/guardrails configuration. Changing it needs explicit user approval.",
		},
	],
	dangerousCommands: { enabled: true, custom: [] },
	autoDeny: [
		"rm\\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])[a-zA-Z]*\\s+(/|~|\\$HOME)(\\s|$)",
		":\\(\\)\\s*\\{.*\\}\\s*;?\\s*:",
	],
	writeOutsideAllow: ["/tmp/**", "/private/tmp/**", "/var/folders/**", "~/.pi/agent/sessions/**"],
};

const STATE_DIR = join(homedir(), ".pi", "agent", "pi-harness");
const AUDIT_LOG = join(STATE_DIR, "guardrails-audit.jsonl");

function loadConfig(cwd: string): Config {
	const merged: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	for (const path of [join(STATE_DIR, "guardrails.json"), join(cwd, ".pi", "guardrails.json")]) {
		try {
			const user = JSON.parse(readFileSync(path, "utf-8"));
			if (Array.isArray(user.policies)) {
				for (const p of user.policies) {
					const i = merged.policies.findIndex((m) => m.id === p.id);
					if (i >= 0)
						merged.policies[i] = p; // same id overrides (set protection off by omitting patterns)
					else merged.policies.push(p);
				}
			}
			if (user.dangerousCommands) Object.assign(merged.dangerousCommands, user.dangerousCommands);
			if (Array.isArray(user.autoDeny)) merged.autoDeny.push(...user.autoDeny);
			if (Array.isArray(user.writeOutsideAllow)) merged.writeOutsideAllow.push(...user.writeOutsideAllow);
		} catch {}
	}
	merged.policies = merged.policies.filter((p) => p.patterns?.length && p.enabled !== false);
	return merged;
}

// ---------------------------------------------------------------------------
// Glob → RegExp (dependency-free micromatch subset: **, *, ?)

function globToRegExp(pattern: string): RegExp {
	// ~/foo patterns match against absolute home paths
	const glob = pattern === "~" || pattern.startsWith("~/") ? join(homedir(), pattern.slice(1)) : pattern;
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// '**/' matches zero or more path segments (incl. a leading '/' so the
				// pattern also matches absolute paths); trailing '**' matches rest
				if (glob[i + 2] === "/") {
					re += i === 0 ? "/?(?:[^/]+/)*" : "(?:[^/]+/)*";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else re += "[^/]*";
		} else if (ch === "?") re += "[^/]";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

function normalizeTarget(p: string, cwd: string): string {
	let expanded = p;
	if (p === "~" || p.startsWith("~/")) expanded = join(homedir(), p.slice(1));
	const abs = resolve(cwd, expanded);
	const rel = relative(cwd, abs);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	return abs;
}

type CompiledPolicy = Policy & { res: RegExp[]; allowedRes: RegExp[] };

function compile(policies: Policy[]): CompiledPolicy[] {
	return policies.map((p) => ({
		...p,
		res: p.patterns.map(globToRegExp),
		allowedRes: (p.allowedPatterns ?? []).map(globToRegExp),
	}));
}

function matchPolicy(policies: CompiledPolicy[], target: string, cwd: string): CompiledPolicy | null {
	const norm = normalizeTarget(target, cwd);
	// match against both the normalized path and its basename-inclusive absolute form
	for (const p of policies) {
		if (!p.res.some((re) => re.test(norm))) continue;
		if (p.allowedRes.some((re) => re.test(norm))) continue;
		if ((p.onlyIfExists ?? true) && !existsSync(resolve(cwd, norm))) continue;
		return p;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Bash analysis (dependency-free): segment on separators, tokenize with quotes

export function segments(command: string): string[][] {
	return command
		.split(/;|&&|\|\|(?!\|)|\||\n/)
		.map((seg) => {
			const words: string[] = [];
			for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
			return words.filter(Boolean);
		})
		.filter((w) => w.length);
}

const hasShortFlag = (words: string[], f: string) =>
	words.some((w) => w.startsWith("-") && !w.startsWith("--") && w.includes(f));
const hasLong = (words: string[], o: string) => words.includes(`--${o}`);

type Matcher = (words: string[]) => string | undefined;

export const MATCHERS: Matcher[] = [
	(w) =>
		w[0] === "rm" &&
		(hasShortFlag(w, "r") || hasShortFlag(w, "R") || hasLong(w, "recursive")) &&
		(hasShortFlag(w, "f") || hasLong(w, "force"))
			? "recursive force delete"
			: undefined,
	(w) => (["sudo", "doas", "pkexec"].includes(w[0]) ? "privilege escalation" : undefined),
	(w) => (w[0] === "dd" && w.some((x) => x.startsWith("of=/dev/")) ? "raw disk write" : undefined),
	(w) =>
		w[0]?.startsWith("mkfs") || ["fdisk", "parted", "wipefs", "blkdiscard", "shred", "diskutil"].includes(w[0])
			? "disk/format operation"
			: undefined,
	(w) =>
		w[0] === "chmod" &&
		(hasShortFlag(w, "R") || hasLong(w, "recursive")) &&
		w.some((x) => /^(777|a\+rwx|-R)$/.test(x) || x === "777")
			? "broad recursive chmod"
			: undefined,
	(w) =>
		w[0] === "chown" &&
		(hasShortFlag(w, "R") || hasLong(w, "recursive")) &&
		w.some((x) => x === "/" || x === "~" || x.startsWith("/System") || x.startsWith("/usr"))
			? "recursive chown on system path"
			: undefined,
	(w) => (w[0] === "find" && w.includes("-delete") ? "bulk find -delete" : undefined),
	(w) =>
		w[0] === "git" &&
		w[1] === "clean" &&
		w.some((x) => /^-[a-z]*f/.test(x)) &&
		w.some((x) => /^-[a-z]*[dx]/.test(x) || /^-f?[dx]/.test(x))
			? "git clean -fd/-fx (deletes untracked)"
			: undefined,
	(w) =>
		["mkswap", "swapoff", "launchctl"].includes(w[0]) && w.includes("unload") ? "system service change" : undefined,
	(w) => (w[0] === "kill" && w.includes("-9") && w.includes("-1") ? "kill all processes" : undefined),
	// data exfiltration shapes
	(w) =>
		["curl", "wget"].includes(w[0]) &&
		w.some((x) => ["-d", "--data", "--data-binary", "--data-raw", "-F", "--form", "-T", "--upload-file"].includes(x))
			? "HTTP data upload"
			: undefined,
	(w) =>
		["scp", "rsync", "sftp"].includes(w[0]) && w.some((x) => /^[^/@\s]+@[^/\s]+:|^\w[\w.-]*:(?!\/\/)/.test(x))
			? "file transfer to remote host"
			: undefined,
	(w) => (w[0] === "git" && w[1] === "remote" && ["add", "set-url"].includes(w[2]) ? "git remote change" : undefined),
	// git history/branch destruction beyond gates.ts's push/reset coverage
	(w) =>
		w[0] === "git" &&
		(["filter-branch", "filter-repo"].includes(w[1]) ||
			(w[1] === "branch" && w.includes("-D")) ||
			(w[1] === "reflog" && w.includes("expire")) ||
			(w[1] === "update-ref" && w.includes("-d")) ||
			(w[1] === "push" && (w.includes("--force") || w.includes("-f") || w.includes("--delete"))))
			? "git history/branch destruction"
			: undefined,
	(w) => (w[0] === "crontab" && !w.includes("-l") ? "crontab modification" : undefined),
	// ANY file deletion prompts (user policy: deletions always ask) — listed after
	// the rm -rf matcher so recursive-force gets its stronger label first.
	(w) => (["rm", "rmdir", "unlink", "trash"].includes(w[0]) ? "file deletion" : undefined),
	(w) => (w[0] === "git" && w[1] === "rm" ? "file deletion (git rm)" : undefined),
];

export function checkDangerous(command: string, cfg: Config): string | undefined {
	// pipe-to-shell: fetch piped into an interpreter (upstream doesn't catch this)
	if (/\b(curl|wget)\b[^|;&]*\|[^|;&]*\b(sudo\s+)?(ba|z|da|fi)?sh\b/.test(command)) return "pipe-to-shell (curl | sh)";
	// inline interpreter code with destructive APIs — checked whole-command because
	// quoted code can contain separators; python -c "print(2+2)" stays free
	if (
		/\b(python3?|node|perl|ruby|bun|deno)\b[^|;&]{0,80}\s(-c|-e|--eval)\s/.test(command) &&
		/rmtree|unlink|rimraf|child_process|os\.system|subprocess|Deno\.remove|os\.remove|rm(Sync|dirSync)?\s*\(|sh(util|util\.rmtree)/.test(
			command,
		)
	)
		return "destructive API in inline interpreter code";
	// destructive SQL / datastore ops — whole-command because SQL rides inside
	// quoted -c/-e strings (psql -c "DROP TABLE x", mysql -e, sqlite3 db "...")
	if (/\bdrop\s+(table|database|schema|index|graph)\b|\btruncate\s+(table\s+)?\w|\bdelete\s+from\s+\w/i.test(command))
		return "destructive SQL (drop/truncate/delete)";
	if (/\b(flushall|flushdb|graph\.delete)\b/i.test(command)) return "datastore purge (redis/falkor)";
	for (const words of segments(command)) {
		for (const m of MATCHERS) {
			const hit = m(words);
			if (hit) return hit;
		}
	}
	for (const c of cfg.dangerousCommands.custom) {
		try {
			if (new RegExp(c.pattern).test(command)) return c.description ?? `custom rule: ${c.pattern}`;
		} catch {}
	}
	return undefined;
}

/** Targets of shell output redirection (writes) only. */
export function redirectTargets(command: string): string[] {
	const out: string[] = [];
	for (const m of command.matchAll(/(?:^|\s)>{1,2}\s*(\S+)/g))
		if (m[1] !== "/dev/null" && !m[1].startsWith("&")) out.push(m[1].replace(/^["']|["']$/g, ""));
	return out;
}

/** Path-like tokens a bash command touches (args + redirect targets). */
export function bashTargets(command: string): string[] {
	const out = new Set<string>();
	for (const m of command.matchAll(/(?:^|\s)>{1,2}\s*(\S+)/g)) out.add(m[1]);
	for (const words of segments(command))
		for (const w of words.slice(1)) if (!w.startsWith("-") && /[/.~]/.test(w)) out.add(w.replace(/^["']|["']$/g, ""));
	return [...out];
}

// ---------------------------------------------------------------------------

function audit(entry: Record<string, unknown>) {
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		appendFileSync(AUDIT_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	} catch {}
}

const FILE_TOOLS_READ = new Set(["read", "grep", "find", "ls"]);
const FILE_TOOLS_WRITE = new Set(["write", "edit"]);

// ===========================================================================
// Capability 1 — BASH ENV-HARDENING (oh-my-pi rank 1)
//
// The bash tool schema is {command, timeout} — no env field (pi runs commands
// through a shell with getShellEnv()). So we harden by rewriting the command
// string: prepend `export VAR=val;` for each var not already set by the caller.
// Using `export …;` (not `VAR=val cmd`) makes it apply to the WHOLE compound
// command — pipelines, && chains, subshells — so `git log | cat`-free hangs and
// `npm install` y/n prompts can't deadlock.

const HARDEN_ENV: Record<string, string> = {
	PAGER: "cat",
	GIT_PAGER: "cat",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	TERM: "dumb",
	CI: "1",
};

/** Does the command already assign this env var (export FOO=, FOO=, --env FOO=)? */
function alreadySetsEnv(command: string, name: string): boolean {
	// FOO=...  or  export FOO=...  anywhere a shell assignment can appear
	return new RegExp(`(^|[;&|(){}\\s])(export\\s+)?${name}=`).test(command);
}

/** Prepend safe non-interactive env; return rewritten command or null if unchanged. */
function hardenEnv(command: string): string | null {
	const missing = Object.entries(HARDEN_ENV).filter(([k]) => !alreadySetsEnv(command, k));
	if (!missing.length) return null;
	const prefix = missing.map(([k, v]) => `export ${k}=${v};`).join(" ");
	return `${prefix} ${command}`;
}

/**
 * Conservatively add non-interactive flags for obvious package managers.
 * Only touches a command whose FIRST word is the manager and where the flag is
 * unambiguously safe & idempotent. Returns rewritten command or null.
 */
function hardenPkgFlags(command: string): string | null {
	const segs = segments(command);
	let changed = false;
	const rewrites: { from: string; to: string }[] = [];
	for (const words of segs) {
		// apt / apt-get install|remove|upgrade … → add -y if no -y/--yes/--assume*
		if (
			(words[0] === "apt" || words[0] === "apt-get") &&
			["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove"].includes(words[1]) &&
			!words.some((w) => w === "-y" || w === "--yes" || w === "--assume-yes" || w === "--assume-no")
		) {
			rewrites.push({ from: words.join(" "), to: `${words[0]} ${words[1]} -y ${words.slice(2).join(" ")}`.trim() });
			changed = true;
		}
		// npm install/ci/etc → add --no-fund --no-audit (quiet, side-effect-free) if absent
		else if (
			words[0] === "npm" &&
			["install", "i", "ci", "add", "update", "uninstall", "remove", "rm"].includes(words[1]) &&
			!words.includes("--fund") &&
			!words.includes("--no-fund")
		) {
			const extra = [
				"--no-fund",
				...(words.includes("--audit") || words.includes("--no-audit") ? [] : ["--no-audit"]),
			];
			rewrites.push({ from: words.join(" "), to: `${words.join(" ")} ${extra.join(" ")}` });
			changed = true;
		}
	}
	if (!changed) return null;
	// Apply each rewrite to EVERY matching occurrence, not just the first — otherwise
	// `npm install a && npm install b` only hardens the first clause and the second can
	// still hang on a prompt. Flags are idempotent, so a global segment replace is safe.
	let out = command;
	for (const r of rewrites) out = out.split(r.from).join(r.to);
	return out === command ? null : out;
}

// ===========================================================================
// Capability 2 — BASH INTERCEPTOR (oh-my-pi rank 11)
//
// When our dedicated read/edit tools are loaded this session, a raw single-file
// cat/head/tail/sed -i/grep-into-a-file/find-that-reads is a worse path than
// hread/scope/grep (no hash anchors, no read-cache, no stale-read guard). Block
// only the CLEAR single-file cases — never pipelines/redirects/globs — so we
// don't false-block legitimate shell work. Default OFF (opt-in) since it's the
// riskiest for false positives.

const READ_CMDS = new Set(["cat", "head", "tail", "less", "more", "bat"]);

/** Return a block reason if this bash command is clearly a raw file read/edit we should redirect. */
function interceptReason(command: string): string | undefined {
	const trimmed = command.trim();
	// Bail on anything with shell plumbing — we only judge simple single commands.
	if (/[|><]|&&|\|\||;|\$\(|`|\bxargs\b/.test(trimmed)) return undefined;
	const words = segments(trimmed);
	if (words.length !== 1) return undefined; // multiple segments → not simple
	const w = words[0];
	const bin = w[0];
	const args = w.slice(1);
	const files = args.filter((a) => !a.startsWith("-"));
	const hasGlob = files.some((f) => /[*?[\]]/.test(f));

	// cat/head/tail/less/more/bat FILE  (single concrete file, no glob)
	if (READ_CMDS.has(bin) && files.length === 1 && !hasGlob) {
		return `raw '${bin}' file read → use hread (hash-anchored, cache-aware) or scope for the relevant slice`;
	}
	// sed -i FILE  (in-place edit of a concrete file)
	if (bin === "sed" && (args.includes("-i") || args.some((a) => /^-i/.test(a))) && files.length && !hasGlob) {
		return `raw 'sed -i' file edit → use hedit (hash-anchored, edit-lint checked)`;
	}
	// grep/rg PATTERN FILE  — reading one concrete file (not a dir/glob search)
	if ((bin === "grep" || bin === "rg") && files.length >= 2 && !hasGlob) {
		const target = files[files.length - 1];
		// only if the last arg looks like a concrete file (has an extension / path sep, not a dir)
		if (/[/.]/.test(target) && !target.endsWith("/") && existsSync(target) && !isDir(target)) {
			return `raw '${bin}' on a single file → use grep tool or hread the slice`;
		}
	}
	// find PATH -name X  used purely to locate a file → our scope/grep tools are better,
	// but find is very general; only redirect the trivial "find <file> -print"/"-type f -name" listing
	return undefined;
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// ===========================================================================
// Capability 3 — SECRET REDACTION (oh-my-pi rank 5)
//
// before_provider_request fires before each LLM call with an opaque payload.
// We deterministically replace secret substrings with #SECRET_xxxx# tokens
// (same secret → same token, so the model reasons coherently) and keep a local
// reverse map for display only. Sources: literal strings + regex from
// ~/.pi/secrets.yml and <repo>/.pi/secrets.yml, plus env-var VALUES whose NAME
// matches /KEY|SECRET|TOKEN|PASSWORD/ and whose value is ≥8 chars.
// Compiled ONCE at load — this runs on every request, so it must stay cheap.

type RedactSpec = { literals: string[]; patterns: RegExp[] };

/** Minimal YAML-ish reader: `literals:` / `regex:` (or `patterns:`) list sections. */
function parseSecretsYml(text: string): { literals: string[]; regex: string[] } {
	const out = { literals: [] as string[], regex: [] as string[] };
	let section: "literals" | "regex" | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*$/, "").replace(/\s+$/, "");
		if (!line.trim()) continue;
		const head = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
		if (head && !line.startsWith("-") && !/^\s/.test(line)) {
			const key = head[1].toLowerCase();
			section =
				key === "literals" || key === "strings"
					? "literals"
					: key === "regex" || key === "patterns"
						? "regex"
						: null;
			// inline `literals: [a, b]` form
			const inline = head[2].trim();
			if (section && inline.startsWith("[")) {
				for (const it of inline.replace(/^\[|\]$/g, "").split(",")) {
					const v = it.trim().replace(/^["']|["']$/g, "");
					if (v) out[section].push(v);
				}
				section = null;
			}
			continue;
		}
		const item = line.match(/^\s*-\s*(.*)$/);
		if (item && section) {
			const v = item[1].trim().replace(/^["']|["']$/g, "");
			if (v) out[section].push(v);
		}
	}
	return out;
}

function buildRedactSpec(cwd: string): RedactSpec {
	const literals = new Set<string>();
	const patternStrs = new Set<string>();
	for (const path of [join(homedir(), ".pi", "secrets.yml"), join(cwd, ".pi", "secrets.yml")]) {
		try {
			const parsed = parseSecretsYml(readFileSync(path, "utf-8"));
			for (const l of parsed.literals) literals.add(l);
			for (const r of parsed.regex) patternStrs.add(r);
		} catch {}
	}
	// env-var-value detection: names matching KEY|SECRET|TOKEN|PASSWORD, value ≥8 chars
	for (const [name, val] of Object.entries(process.env)) {
		if (!val || val.length < 8) continue;
		if (/KEY|SECRET|TOKEN|PASSWORD/i.test(name)) literals.add(val);
	}
	const patterns: RegExp[] = [];
	for (const p of patternStrs) {
		try {
			patterns.push(new RegExp(p, "g"));
		} catch {}
	}
	// Longest-first so overlapping literals redact the biggest match first.
	return { literals: [...literals].filter(Boolean).sort((a, b) => b.length - a.length), patterns };
}

/** Deterministic stable token for a secret value (same input → same token). */
function secretToken(value: string, map: Map<string, string>): string {
	const existing = map.get(value);
	if (existing) return existing;
	const h = createHash("sha256").update(value).digest("hex").slice(0, 4);
	const token = `#SECRET_${h}#`;
	map.set(value, token);
	return token;
}

/** Redact one string; returns [newString, hitCount]. */
function redactString(s: string, spec: RedactSpec, map: Map<string, string>): [string, number] {
	let out = s;
	let hits = 0;
	for (const lit of spec.literals) {
		if (lit && out.includes(lit)) {
			const tok = secretToken(lit, map);
			// count then replace all occurrences
			let idx = out.indexOf(lit);
			while (idx !== -1) {
				hits++;
				idx = out.indexOf(lit, idx + lit.length);
			}
			out = out.split(lit).join(tok);
		}
	}
	for (const re of spec.patterns) {
		re.lastIndex = 0;
		out = out.replace(re, (m) => {
			hits++;
			return secretToken(m, map);
		});
	}
	return [out, hits];
}

/** Walk an opaque payload, redacting only string fields in place-ish (returns redacted clone). */
function redactPayload(node: any, spec: RedactSpec, map: Map<string, string>, counter: { n: number }, depth = 0): any {
	if (depth > 12 || node == null) return node;
	if (typeof node === "string") {
		const [out, hits] = redactString(node, spec, map);
		counter.n += hits;
		return out;
	}
	if (Array.isArray(node)) return node.map((v) => redactPayload(v, spec, map, counter, depth + 1));
	if (typeof node === "object") {
		// avoid choking on non-plain objects (Buffers, typed arrays, etc.)
		if (Buffer.isBuffer(node) || ArrayBuffer.isView(node)) return node;
		const out: any = {};
		for (const k of Object.keys(node)) out[k] = redactPayload(node[k], spec, map, counter, depth + 1);
		return out;
	}
	return node;
}

export default function (pi: any) {
	const cwd = process.cwd();
	let cfg = loadConfig(cwd);
	let policies = compile(cfg.policies);
	let outsideAllow = cfg.writeOutsideAllow.map(globToRegExp);
	const sessionGrants = new Set<string>();
	const decisions = { blocked: 0, allowed: 0 };

	// --- env toggles (read once; cheap on the hot path)
	const HARDEN_ON = process.env.KP_BASH_HARDEN !== "0"; // default ON
	const INTERCEPT_ON = process.env.KP_BASH_INTERCEPT === "1"; // default OFF (false-positive risk)
	const REDACT_ON = process.env.KP_REDACT !== "0"; // default ON

	// --- capability 3 state: compiled redaction spec + stable reverse map (local display only)
	let redactSpec: RedactSpec = REDACT_ON ? buildRedactSpec(cwd) : { literals: [], patterns: [] };
	const secretMap = new Map<string, string>(); // value → token
	let redactCount = 0;

	// --- capability 2 state: which dedicated tools are loaded this session
	const dedicatedTools = new Set<string>();
	const DEDICATED = ["hread", "hedit", "hedit_block", "scope"];
	function refreshDedicated() {
		dedicatedTools.clear();
		// pi.getTools()/pi.tools may expose registered tool names; be defensive about shape.
		let names: string[] = [];
		try {
			const t = typeof pi.getTools === "function" ? pi.getTools() : (pi.tools ?? []);
			names = (Array.isArray(t) ? t : Object.keys(t ?? {}))
				.map((x: any) => (typeof x === "string" ? x : x?.name))
				.filter(Boolean);
		} catch {}
		// If we can't enumerate, assume the harness loaded them (this extension ships alongside hashline/scope).
		const source = names.length ? names : DEDICATED;
		for (const d of DEDICATED) if (source.includes(d)) dedicatedTools.add(d);
	}
	refreshDedicated();

	function isOutsideWorkspace(target: string): boolean {
		const norm = normalizeTarget(target, cwd);
		if (!isAbsolute(norm)) return false; // normalizeTarget keeps in-workspace paths relative
		return !outsideAllow.some((re) => re.test(norm));
	}

	pi.on("session_start", async () => {
		cfg = loadConfig(cwd);
		policies = compile(cfg.policies);
		outsideAllow = cfg.writeOutsideAllow.map(globToRegExp);
		if (REDACT_ON) redactSpec = buildRedactSpec(cwd); // pick up new .pi/secrets.yml / env
		refreshDedicated();
	});

	async function confirmOrBlock(ctx: any, kind: string, detail: string, grantKey: string) {
		if (sessionGrants.has(grantKey)) {
			audit({ kind, detail, decision: "session-grant" });
			return undefined; // allowed
		}
		if (ctx?.hasUI && ctx.ui?.select) {
			const choice = await ctx.ui.select(`Guardrails: ${kind} — ${detail}`, [
				"Deny",
				"Allow once",
				"Allow for session",
			]);
			if (choice === "Allow once" || choice === "Allow for session") {
				if (choice === "Allow for session") sessionGrants.add(grantKey);
				decisions.allowed++;
				audit({ kind, detail, decision: choice });
				return undefined;
			}
		}
		decisions.blocked++;
		audit({ kind, detail, decision: "blocked" });
		return {
			block: true,
			reason:
				`Guardrails blocked this (${kind}: ${detail}). Do NOT retry it verbatim. ` +
				`Explain to the user what you wanted to do and why; they can allow it interactively ` +
				`or adjust .pi/guardrails.json.`,
		};
	}

	pi.on("tool_call", async (event: any, ctx: any) => {
		const { toolName, input } = event;

		// --- file policy checks on path tools
		if (FILE_TOOLS_READ.has(toolName) || FILE_TOOLS_WRITE.has(toolName)) {
			const target = String(input?.path ?? input?.file_path ?? "").trim();
			if (target) {
				const p = matchPolicy(policies, target, cwd);
				if (p && p.protection === "noAccess") {
					// secrets: hard block, never prompted
					decisions.blocked++;
					audit({ kind: "file-policy", policy: p.id, tool: toolName, target, decision: "blocked" });
					return {
						block: true,
						reason: (
							p.message ?? `{file} is protected (${p.id}): no access. Ask the user if it's genuinely needed.`
						).replace("{file}", target),
					};
				}
				if (FILE_TOOLS_WRITE.has(toolName)) {
					if (p && p.protection === "readOnly") {
						// persistence vectors / self-protection: prompt-able
						const res = await confirmOrBlock(
							ctx,
							"protected write",
							`${target} (${p.id})`,
							`write:${p.id}:${target}`,
						);
						if (res)
							return {
								...res,
								reason: p.message ? `${p.message.replace("{file}", target)} ${res.reason}` : res.reason,
							};
					} else if (!p && isOutsideWorkspace(target)) {
						const res = await confirmOrBlock(ctx, "write outside workspace", target, `outside:${target}`);
						if (res) return res;
					}
				}
			}
		}

		if (toolName !== "bash") return;
		const command = String(input?.command ?? "");

		// --- capability 2: BASH INTERCEPTOR (opt-in) — redirect raw single-file
		// read/edit to our dedicated tools. Runs before mutation so the reason
		// reflects the command the model actually wrote.
		if (INTERCEPT_ON && dedicatedTools.size) {
			const reason = interceptReason(command);
			if (reason) {
				decisions.blocked++;
				audit({ kind: "bash-intercept", command: command.slice(0, 200), decision: "blocked", reason });
				return {
					block: true,
					reason:
						`Guardrails redirected this (${reason}). Dedicated tools are loaded this session — ` +
						`prefer them over raw shell file access. Set KP_BASH_INTERCEPT=0 to disable.`,
				};
			}
		}

		// --- capability 1: BASH ENV-HARDENING (default ON) — inject non-interactive
		// env + safe package-manager flags UNLESS the caller already set them, so a
		// pager or y/n prompt can never deadlock the session. Mutate input IN PLACE.
		if (HARDEN_ON) {
			let cmd = command;
			const flagged = hardenPkgFlags(cmd);
			if (flagged) cmd = flagged;
			const hardened = hardenEnv(cmd);
			if (hardened) cmd = hardened;
			if (cmd !== command) {
				input.command = cmd; // in-place mutation; later handlers + executor see it
				audit({ kind: "bash-harden", decision: "mutated", command: command.slice(0, 120) });
			}
		}

		// --- auto-deny: never prompted
		for (const re of cfg.autoDeny) {
			try {
				if (new RegExp(re).test(command)) {
					decisions.blocked++;
					audit({ kind: "auto-deny", pattern: re, command: command.slice(0, 200), decision: "blocked" });
					return { block: true, reason: `Guardrails auto-deny (${re}). This command is never allowed here.` };
				}
			} catch {}
		}

		// --- protected paths referenced by the command
		for (const target of bashTargets(command)) {
			const p = matchPolicy(policies, target, cwd);
			if (p) {
				const res = await confirmOrBlock(
					ctx,
					"protected path in bash",
					`${target} (${p.id})`,
					`path:${p.id}:${target}`,
				);
				if (res) return res;
			}
		}

		// --- shell redirects writing outside the workspace
		for (const target of redirectTargets(command)) {
			if (!matchPolicy(policies, target, cwd) && isOutsideWorkspace(target)) {
				const res = await confirmOrBlock(ctx, "redirect outside workspace", target, `outside:${target}`);
				if (res) return res;
			}
		}

		// --- dangerous command matchers
		if (cfg.dangerousCommands.enabled) {
			const danger = checkDangerous(command, cfg);
			if (danger) return confirmOrBlock(ctx, "dangerous command", danger, `cmd:${danger}`);
		}
	});

	// -------------------------------------------------------------------------
	// Capability 3 — SECRET REDACTION (default ON). Redact secrets in the OUTBOUND
	// provider payload before it reaches the model. Deterministic reversible
	// #SECRET_xxxx# tokens (same secret → same token) keep the model coherent;
	// the reverse map (secretMap) stays local. Return the modified payload.
	if (REDACT_ON) {
		pi.on("before_provider_request", async (event: any) => {
			if (!redactSpec.literals.length && !redactSpec.patterns.length) return; // nothing to do
			try {
				const counter = { n: 0 };
				const redacted = redactPayload(event.payload, redactSpec, secretMap, counter);
				if (counter.n > 0) {
					redactCount += counter.n;
					audit({ kind: "redact", decision: "redacted", hits: counter.n, tokens: secretMap.size });
					event.payload = redacted; // in-place for later handlers
					return redacted; // and returned as the replacement payload
				}
				return undefined; // walked clean, no secrets present
			} catch (_err: any) {
				// FAIL SAFE, not open. A spec is active, so the payload MAY contain a secret and
				// the structured walk failed mid-way — returning undefined would ship the ORIGINAL
				// plaintext. Instead do a blunt, can't-partially-fail literal scrub over the
				// JSON-serialized payload; if even that throws, BLOCK the request rather than leak.
				audit({ kind: "redact", decision: "walk-error-failsafe", hits: 0, tokens: secretMap.size });
				try {
					let s = JSON.stringify(event.payload);
					for (const lit of redactSpec.literals) {
						if (!lit) continue;
						const tok = secretToken(lit, secretMap);
						s = s.split(lit).join(tok);
					}
					const scrubbed = JSON.parse(s);
					event.payload = scrubbed;
					return scrubbed;
				} catch {
					// Cannot guarantee redaction — refuse to transmit. Replace the payload with a
					// safe sentinel so a redaction fault can never leak plaintext to the provider.
					audit({ kind: "redact", decision: "blocked-unredactable", hits: 0, tokens: secretMap.size });
					try {
						pi.ui?.notify?.(
							"Secret redaction failed on this request — payload withheld (KP_REDACT=0 to disable).",
							"error",
						);
					} catch {}
					return { __redaction_error: "payload withheld: secret redaction could not be verified" };
				}
			}
		});
	}

	// -------------------------------------------------------------------------
	// Interactive settings UI (/guardrails) — everything editable from the TUI.

	let lastScope: "project" | "user" = "project";

	function scopePath(scope: "project" | "user"): string {
		return scope === "project" ? join(cwd, ".pi", "guardrails.json") : join(STATE_DIR, "guardrails.json");
	}

	async function pickScope(ctx: any): Promise<"project" | "user" | undefined> {
		const c = await ctx.ui.select("Save to which scope?", [
			`project (.pi/guardrails.json)${lastScope === "project" ? " ←" : ""}`,
			`user (~/.pi/agent/pi-harness/guardrails.json)${lastScope === "user" ? " ←" : ""}`,
		]);
		if (!c) return undefined;
		lastScope = c.startsWith("project") ? "project" : "user";
		return lastScope;
	}

	/** Read raw scope file, mutate, write, re-apply live. */
	async function save(ctx: any, mutate: (raw: any) => void): Promise<boolean> {
		const scope = await pickScope(ctx);
		if (!scope) return false;
		const path = scopePath(scope);
		let raw: any = {};
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch {}
		mutate(raw);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
		cfg = loadConfig(cwd);
		policies = compile(cfg.policies);
		outsideAllow = cfg.writeOutsideAllow.map(globToRegExp);
		ctx.ui.notify(`Saved to ${scope} scope — live now`, "info");
		return true;
	}

	function upsertPolicy(raw: any, policy: Policy) {
		raw.policies ??= [];
		const i = raw.policies.findIndex((p: any) => p.id === policy.id);
		if (i >= 0) raw.policies[i] = policy;
		else raw.policies.push(policy);
	}

	async function editPolicy(ctx: any, policy: Policy) {
		for (;;) {
			const p = cfg.policies.find((x) => x.id === policy.id) ?? policy;
			const choice = await ctx.ui.select(
				`${p.id} — ${p.protection}, ${p.patterns.length} patterns, ${(p.allowedPatterns ?? []).length} exceptions`,
				[
					`Protection: ${p.protection} (switch)`,
					"Add pattern",
					`Remove pattern (${p.patterns.length})`,
					"Add exception (allowedPattern)",
					`Remove exception (${(p.allowedPatterns ?? []).length})`,
					`onlyIfExists: ${p.onlyIfExists ?? true} (toggle)`,
					"Disable this policy",
					"← Back",
				],
			);
			if (!choice || choice === "← Back") return;
			const next: Policy = JSON.parse(JSON.stringify(p));
			if (choice.startsWith("Protection")) {
				next.protection = p.protection === "noAccess" ? "readOnly" : "noAccess";
			} else if (choice === "Add pattern") {
				const v = await ctx.ui.input("Glob pattern (e.g. **/*.secret, ~/foo/**)", "**/");
				if (!v?.trim()) continue;
				next.patterns = [...p.patterns, v.trim()];
			} else if (choice.startsWith("Remove pattern")) {
				const v = await ctx.ui.select("Remove which pattern?", [...p.patterns, "← Cancel"]);
				if (!v || v === "← Cancel") continue;
				next.patterns = p.patterns.filter((x) => x !== v);
			} else if (choice === "Add exception (allowedPattern)") {
				const v = await ctx.ui.input("Exception glob (never blocked)", "**/");
				if (!v?.trim()) continue;
				next.allowedPatterns = [...(p.allowedPatterns ?? []), v.trim()];
			} else if (choice.startsWith("Remove exception")) {
				const v = await ctx.ui.select("Remove which exception?", [...(p.allowedPatterns ?? []), "← Cancel"]);
				if (!v || v === "← Cancel") continue;
				next.allowedPatterns = (p.allowedPatterns ?? []).filter((x) => x !== v);
			} else if (choice.startsWith("onlyIfExists")) {
				next.onlyIfExists = !(p.onlyIfExists ?? true);
			} else if (choice === "Disable this policy") {
				if (!(await ctx.ui.confirm("Disable policy", `Turn off '${p.id}' entirely?`))) continue;
				next.enabled = false;
			}
			await save(ctx, (raw) => upsertPolicy(raw, next));
		}
	}

	async function policiesMenu(ctx: any) {
		for (;;) {
			const labels = cfg.policies.map((p) => `${p.id} — ${p.protection}, ${p.patterns.length} patterns`);
			const choice = await ctx.ui.select("File policies", [...labels, "＋ New policy", "← Back"]);
			if (!choice || choice === "← Back") return;
			if (choice === "＋ New policy") {
				const id = await ctx.ui.input("Policy id (short slug)", "my-policy");
				if (!id?.trim()) continue;
				const prot = await ctx.ui.select("Protection level", [
					"noAccess — block read AND write (secrets)",
					"readOnly — writes need approval",
				]);
				if (!prot) continue;
				const pattern = await ctx.ui.input("First glob pattern", "**/");
				if (!pattern?.trim()) continue;
				const policy: Policy = {
					id: id.trim(),
					protection: prot.startsWith("noAccess") ? "noAccess" : "readOnly",
					patterns: [pattern.trim()],
					onlyIfExists: false,
				};
				await save(ctx, (raw) => upsertPolicy(raw, policy));
			} else {
				const p = cfg.policies[labels.indexOf(choice)];
				if (p) await editPolicy(ctx, p);
			}
		}
	}

	async function listEditorMenu(ctx: any, title: string, key: "autoDeny" | "writeOutsideAllow", hint: string) {
		for (;;) {
			const items = cfg[key];
			const choice = await ctx.ui.select(`${title} (${items.length})`, [
				...items.map((x) => `✕ ${x}`),
				"＋ Add",
				"← Back",
			]);
			if (!choice || choice === "← Back") return;
			if (choice === "＋ Add") {
				const v = await ctx.ui.input(hint);
				if (!v?.trim()) continue;
				if (key === "autoDeny") {
					try {
						new RegExp(v);
					} catch {
						ctx.ui.notify("Invalid regex", "error");
						continue;
					}
				}
				await save(ctx, (raw) => {
					raw[key] = [...(raw[key] ?? []), v.trim()];
				});
			} else {
				const value = choice.slice(2);
				if (!(await ctx.ui.confirm("Remove entry", value))) continue;
				// removal works on scope files; builtin defaults can't be removed, only scoped additions
				await save(ctx, (raw) => {
					raw[key] = (raw[key] ?? []).filter((x: string) => x !== value);
				});
			}
		}
	}

	async function dangerousMenu(ctx: any) {
		for (;;) {
			const d = cfg.dangerousCommands;
			const choice = await ctx.ui.select(
				`Dangerous commands — ${MATCHERS.length} builtin matchers, ${d.custom.length} custom`,
				[
					`Builtin matchers: ${d.enabled ? "ON" : "OFF"} (toggle)`,
					"＋ Add custom pattern (regex)",
					...d.custom.map((c) => `✕ ${c.pattern}${c.description ? ` — ${c.description}` : ""}`),
					"← Back",
				],
			);
			if (!choice || choice === "← Back") return;
			if (choice.startsWith("Builtin matchers")) {
				await save(ctx, (raw) => {
					raw.dangerousCommands = {
						...(raw.dangerousCommands ?? {}),
						enabled: !d.enabled,
						custom: raw.dangerousCommands?.custom ?? [],
					};
				});
			} else if (choice === "＋ Add custom pattern (regex)") {
				const pattern = await ctx.ui.input("Regex matched against the whole command");
				if (!pattern?.trim()) continue;
				try {
					new RegExp(pattern);
				} catch {
					ctx.ui.notify("Invalid regex", "error");
					continue;
				}
				const description = (await ctx.ui.input("Short description (shown on block)")) ?? "";
				await save(ctx, (raw) => {
					raw.dangerousCommands ??= { enabled: true, custom: [] };
					raw.dangerousCommands.custom = [
						...(raw.dangerousCommands.custom ?? []),
						{ pattern: pattern.trim(), description },
					];
				});
			} else {
				const pattern = choice.slice(2).split(" — ")[0];
				if (!(await ctx.ui.confirm("Remove custom pattern", pattern))) continue;
				await save(ctx, (raw) => {
					if (raw.dangerousCommands?.custom)
						raw.dangerousCommands.custom = raw.dangerousCommands.custom.filter((c: any) => c.pattern !== pattern);
				});
			}
		}
	}

	function auditTail(n: number): string {
		try {
			return readFileSync(AUDIT_LOG, "utf-8")
				.trim()
				.split("\n")
				.slice(-n)
				.map((l) => {
					const e = JSON.parse(l);
					return `${e.ts.slice(5, 16)} ${e.decision}: ${e.kind} ${e.detail ?? e.target ?? e.pattern ?? ""}`;
				})
				.join("\n");
		} catch {
			return "no decisions logged yet";
		}
	}

	pi.registerCommand("guardrails", {
		description: "Guardrails settings UI: policies, matchers, auto-deny, allowlists, audit, grants",
		handler: async (_args: string, ctx: any) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Guardrails: ${cfg.policies.length} policies, ${MATCHERS.length} matchers | harden:${HARDEN_ON ? "on" : "off"} intercept:${INTERCEPT_ON ? "on" : "off"} redact:${REDACT_ON ? "on" : "off"} | edit .pi/guardrails.json\n${auditTail(5)}`,
					"info",
				);
				return;
			}
			for (;;) {
				const oh = `harden:${HARDEN_ON ? "on" : "off"} intercept:${INTERCEPT_ON ? "on" : "off"} redact:${REDACT_ON ? `on(${redactSpec.literals.length}+${redactSpec.patterns.length}, ${redactCount} hits)` : "off"}`;
				const choice = await ctx.ui.select(
					`Guardrails — ${decisions.blocked} blocked / ${decisions.allowed} allowed this session | ${oh}`,
					[
						`File policies (${cfg.policies.length})`,
						`Dangerous commands (${MATCHERS.length} builtin + ${cfg.dangerousCommands.custom.length} custom)`,
						`Auto-deny patterns (${cfg.autoDeny.length})`,
						`Write-outside allowlist (${cfg.writeOutsideAllow.length})`,
						`Session grants (${sessionGrants.size})`,
						"Recent decisions",
						"Done",
					],
				);
				if (!choice || choice === "Done") return;
				if (choice.startsWith("File policies")) await policiesMenu(ctx);
				else if (choice.startsWith("Dangerous commands")) await dangerousMenu(ctx);
				else if (choice.startsWith("Auto-deny"))
					await listEditorMenu(
						ctx,
						"Auto-deny (never prompted, always blocked)",
						"autoDeny",
						"Regex over the whole bash command",
					);
				else if (choice.startsWith("Write-outside"))
					await listEditorMenu(
						ctx,
						"Write-outside allowlist",
						"writeOutsideAllow",
						"Glob for allowed out-of-workspace writes (e.g. /tmp/**)",
					);
				else if (choice.startsWith("Session grants")) {
					if (!sessionGrants.size) {
						ctx.ui.notify("No session grants", "info");
						continue;
					}
					const g = await ctx.ui.select("Session grants (select to revoke)", [...sessionGrants, "← Back"]);
					if (g && g !== "← Back") {
						sessionGrants.delete(g);
						ctx.ui.notify(`Revoked: ${g}`, "info");
					}
				} else if (choice === "Recent decisions") ctx.ui.notify(auditTail(10), "info");
			}
		},
	});
}
