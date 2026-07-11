/**
 * arity.ts — extract the human-meaningful prefix of a shell command.
 *
 * A permission or thrash check keyed on the raw command string is useless:
 * `git commit -m "a"` and `git commit -m "b"` look different but are the same
 * operation, while `git status` and `git push` look similar but are worlds
 * apart. Arity extraction collapses the variable tail (paths, messages, values)
 * and keeps the operation: tool + the subcommand tokens that actually name what
 * it does. Longest-meaningful-prefix wins.
 *
 * Used by:
 *  - doom-loop.ts — normalize signatures so thrash detection sees operations,
 *    not argument noise (`git commit -m x` ×N reads as one repeated op).
 *  - bash arity-permissioning — allow/deny by subcommand (`git push`) instead
 *    of an opaque full-string match.
 */

/** How many leading tokens name the operation for a given base tool. */
const ARITY: Record<string, number> = {
	git: 2,
	docker: 2,
	podman: 2,
	kubectl: 2,
	helm: 2,
	terraform: 2,
	cargo: 2,
	go: 2,
	npm: 2,
	pnpm: 2,
	yarn: 2,
	bun: 2,
	deno: 2,
	pip: 2,
	pip3: 2,
	poetry: 2,
	brew: 2,
	apt: 2,
	"apt-get": 2,
	dnf: 2,
	pacman: 2,
	systemctl: 2,
	service: 2,
	gh: 2,
	glab: 2,
	make: 2,
	just: 2,
	rake: 2,
	gradle: 2,
	mvn: 2,
	dotnet: 2,
	aws: 2,
	gcloud: 2,
	az: 2,
	tsc: 1,
};

/** Tokens after which one MORE token is meaningful (e.g. `npm run <script>`). */
const DEEPER: Record<string, Set<string>> = {
	npm: new Set(["run"]),
	pnpm: new Set(["run"]),
	yarn: new Set(["run"]),
	bun: new Set(["run"]),
	docker: new Set(["compose"]),
	git: new Set(["remote", "submodule", "stash", "bisect", "worktree"]),
	kubectl: new Set(["config"]),
	cargo: new Set(["install"]),
};

/** Split a command line into tokens, respecting single/double quotes. */
function tokenize(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let q = "";
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (q) {
			if (ch === q) q = "";
			else cur += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (cur) {
				out.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) out.push(cur);
	return out;
}

const basename = (t: string) => t.slice(t.lastIndexOf("/") + 1);

/**
 * The operation prefix of a SINGLE command segment: base tool + the subcommand
 * tokens that name what it does, with the variable tail dropped. Leading
 * `FOO=bar` env assignments and `sudo` are stripped so they don't hide the op.
 */
export function commandPrefix(segment: string): string {
	let toks = tokenize(segment.trim());
	// strip leading env assignments and sudo/command wrappers
	while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || toks[0] === "sudo" || toks[0] === "command")) {
		toks = toks.slice(1);
	}
	if (!toks.length) return "";
	const base = basename(toks[0]);
	let depth = ARITY[base] ?? 1;
	// meaningful subcommand tokens = first `depth` NON-flag tokens after the base
	const kept: string[] = [base];
	let seen = 1;
	for (let i = 1; i < toks.length && seen < depth; i++) {
		if (toks[i].startsWith("-")) continue; // flags aren't the subcommand
		kept.push(toks[i]);
		seen++;
		// a "deeper" subcommand (npm run, docker compose, git remote) earns +1
		if (seen === depth && DEEPER[base]?.has(toks[i])) depth++;
	}
	return kept.join(" ");
}

/**
 * Normalize a full command line (possibly compound: `a && b | c`) into a stable
 * operation signature — each segment reduced to its prefix, joined in order. Two
 * commands with the same operations but different arguments normalize identically.
 */
export function normalizeCommand(cmd: string): string {
	const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
	const prefixes = segments.map(commandPrefix).filter(Boolean);
	return prefixes.join(" ; ");
}
