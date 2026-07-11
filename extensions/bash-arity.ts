/**
 * bash-arity.ts — per-subcommand bash permissioning (arity-based).
 *
 * Coarse allow/deny keyed on the opaque command string can't tell `git status`
 * from `git push`. This layer keys policy on the ARITY-NORMALIZED operation
 * prefix (see lib/arity.ts), so you can allow `git status` while asking on
 * `git push` — per-subcommand, not per-string. Longest-prefix-wins.
 *
 * OPT-IN: does nothing unless `.pi/bash-arity.json` exists. It LAYERS UNDER the
 * semantic guardrails/gates (secrets, destructive flags like `rm -rf`) — those
 * still apply; this adds subcommand-level policy on top. Flag-level matching is
 * intentionally out of scope here (arity drops flags); guardrails covers that.
 *
 *   .pi/bash-arity.json:
 *   {
 *     "allow": ["git status", "git log", "npm test", "npm run build"],
 *     "ask":   ["git push", "npm publish", "docker push"],
 *     "deny":  ["git push --force"]        // matched by prefix; see note above
 *   }
 *
 * A command's segment prefixes are matched against each list; deny wins, then
 * ask (unless confirm:true), then allow short-circuits. Commands with no listed
 * match fall through untouched (this layer never gates the unlisted).
 * Config env: KP_BASH_ARITY=0 disable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandPrefix } from "./lib/arity.ts";

const ENABLED = process.env.KP_BASH_ARITY !== "0";

interface Policy {
	allow: string[];
	ask: string[];
	deny: string[];
}

function loadPolicy(cwd: string): Policy | null {
	try {
		const raw = JSON.parse(readFileSync(join(cwd, ".pi", "bash-arity.json"), "utf-8"));
		const arr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s) => typeof s === "string") : []);
		const p: Policy = { allow: arr(raw.allow), ask: arr(raw.ask), deny: arr(raw.deny) };
		if (!p.allow.length && !p.ask.length && !p.deny.length) return null;
		return p;
	} catch {
		return null;
	}
}

/** Segment prefixes of a compound command (`a && b` -> ["a-op","b-op"]). */
function segmentPrefixes(cmd: string): string[] {
	return cmd
		.split(/\s*(?:&&|\|\||;|\|)\s*/)
		.map((s) => commandPrefix(s))
		.filter(Boolean);
}

/** True if `rule` matches `prefix` on a token boundary (rule is a prefix of prefix). */
function prefixMatch(prefix: string, rule: string): boolean {
	return prefix === rule || prefix.startsWith(`${rule} `);
}

/** The longest matching rule from a list, or "" if none match. */
function longestMatch(prefixes: string[], rules: string[]): string {
	let best = "";
	for (const rule of rules) {
		for (const prefix of prefixes) {
			if (prefixMatch(prefix, rule) && rule.length > best.length) best = rule;
		}
	}
	return best;
}

export default function (pi: ExtensionAPI): void {
	if (!ENABLED) return;

	let policy = loadPolicy(process.cwd());
	const metrics = { denied: 0, asked: 0 };

	pi.on("session_start", async () => {
		policy = loadPolicy(process.cwd());
	});

	pi.on("tool_call", async (event) => {
		if (!policy || event.toolName !== "bash") return {};
		const cmd = String((event.input as { command?: unknown; confirm?: unknown })?.command ?? "");
		if (!cmd.trim()) return {};
		const prefixes = segmentPrefixes(cmd);
		if (!prefixes.length) return {};

		const denyRule = longestMatch(prefixes, policy.deny);
		if (denyRule) {
			metrics.denied++;
			return { block: true, reason: `bash-arity DENY '${denyRule}' — this operation is not allowed here.` };
		}
		const confirmed = (event.input as { confirm?: unknown })?.confirm === true;
		const askRule = longestMatch(prefixes, policy.ask);
		if (askRule && !confirmed) {
			metrics.asked++;
			return {
				block: true,
				reason: `bash-arity ASK '${askRule}'. Show the user what this does; on approval retry with confirm:true.`,
			};
		}
		return {};
	});

	pi.registerCommand("arity", {
		description: "bash-arity: show policy + normalized op prefix of a command (/arity <command>)",
		handler: async (args, ctx) => {
			const probe = (args || "").trim();
			if (probe) {
				ctx.ui.notify(`arity prefixes: ${segmentPrefixes(probe).join(" ; ") || "(none)"}`, "info");
				return;
			}
			if (!policy) {
				ctx.ui.notify(
					"bash-arity: no .pi/bash-arity.json (inactive). /arity <command> to preview normalization.",
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`bash-arity policy: allow=${policy.allow.length} ask=${policy.ask.length} deny=${policy.deny.length}\n` +
					`this session: ${metrics.denied} denied, ${metrics.asked} asked`,
				"info",
			);
		},
	});
}
