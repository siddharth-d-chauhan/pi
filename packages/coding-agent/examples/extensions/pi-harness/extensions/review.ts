/**
 * review.ts — /review the working diff via a focused reviewer subagent, and
 * /verify to run devbrain's contract engine when a repo defines contracts.
 *
 * Closes the code-review gap (opencode subagent, oh-my-pi /review P0-P3, Claude
 * Code /code-review). Two tiers:
 *
 *  /review [target]  — LIGHT, high-frequency: takes the git diff (working tree,
 *    staged, or vs a ref) and runs a reviewer in an ISOLATED pi subprocess that
 *    returns findings ranked by severity (P0 blocker → P3 nit). Thin parent: the
 *    reviewer burns its own context on the diff; only ranked findings come back.
 *
 *  /verify  — HEAVY, on-demand: if the repo has devbrain/contracts (harness-core's
 *    verification engine), shell to it for deterministic contract validation. Not
 *    forced — only meaningful where contracts exist.
 *
 * Config: KP_REVIEW_MODEL (reviewer model, default a capable one) ·
 *   KP_DEVBRAIN_PYTHON (py3.11+ for the contract engine).
 */

import { type ChildProcessByStdio, execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

const REVIEW_MODEL = process.env.KP_REVIEW_MODEL || ""; // "" = inherit session model
const DEVBRAIN_PY = process.env.KP_DEVBRAIN_PYTHON || "python3.11";
const PI_BIN = process.env.KP_CHAIN_PI || "pi";
const DEFAULT_PROVIDER = process.env.KP_CHAIN_DEFAULT_PROVIDER || "openai-codex";
function qualifyModel(m: string): string {
	if (!m) return "";
	if (m.includes("/")) return m;
	if (/^claude-/.test(m)) return `harness-sdk/${m}`;
	return `${DEFAULT_PROVIDER}/${m}`;
}

function getDiff(target: string, cwd: string): string {
	const t = (target || "").trim();
	const cmd = t === "staged" ? "git diff --cached" : t && t !== "working" ? `git diff ${t}` : "git diff HEAD"; // working = uncommitted vs last commit
	try {
		return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
	} catch {
		return "";
	}
}

const REVIEW_PROMPT = (diff: string) =>
	`You are a senior code reviewer. Review ONLY this diff. Work in two phases:\n` +
	`PHASE 1 — find candidate issues ranked by severity: P0 (blocker: bug/data-loss/security), ` +
	`P1 (should-fix: correctness/edge case), P2 (quality), P3 (nit).\n` +
	`PHASE 2 — ADVERSARIAL VALIDATION: for EACH candidate, actively try to DISPROVE it (is it actually reachable? ` +
	`does the surrounding code already handle it? am I misreading?). Drop findings you can't defend. This kills false positives.\n` +
	`Report only SURVIVING findings: severity, file:line, one-line issue, the fix — cite the code. If clean, say so.\n` +
	`End with a one-line verdict: SHIP / FIX-FIRST / NEEDS-WORK.\n\n### DIFF\n${clipReviewDiff(diff)}`;

// Large diff budget so the reviewer sees the whole change; warn loudly if it must
// truncate (a partial-diff review can miss issues in the unseen part).
const REVIEW_DIFF_MAX = Number(process.env.KP_REVIEW_DIFF_MAX || 180_000);
function clipReviewDiff(diff: string): string {
	if (diff.length <= REVIEW_DIFF_MAX) return diff;
	return (
		diff.slice(0, REVIEW_DIFF_MAX) +
		`\n\n⚠ DIFF TRUNCATED (${diff.length} chars total) — you're reviewing only PART of the change. ` +
		`Flag the unreviewed remainder explicitly; don't verdict SHIP on a partial view.`
	);
}

function runReviewer(diff: string, cwd: string): Promise<string> {
	return new Promise((res) => {
		const args = ["-p", "--mode", "json", "--no-session"];
		const m = qualifyModel(REVIEW_MODEL);
		if (m) args.push("--model", m);
		args.push(REVIEW_PROMPT(diff));
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(PI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return res("[reviewer failed to spawn]");
		}
		let text = "",
			buf = "";
		const timer = setTimeout(() => proc.kill(), 300_000);
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant") {
						const t = (e.message.content || [])
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n");
						if (t.trim()) text = t;
					}
				} catch {}
			}
		});
		proc.stderr.on("data", () => {});
		proc.on("close", () => {
			clearTimeout(timer);
			res(text || "[no review output]");
		});
		proc.on("error", () => {
			clearTimeout(timer);
			res("[reviewer error]");
		});
	});
}

export default function (pi: any) {
	async function review(target: string, cwd: string): Promise<string> {
		const diff = getDiff(target, cwd);
		if (!diff.trim()) return "No changes to review (empty diff).";
		return runReviewer(diff, cwd);
	}

	pi.registerCommand("review", {
		description: "Review the working diff via a reviewer subagent: /review [working|staged|<ref>]",
		handler: async (args: string, ctx: any) => {
			ctx.ui.notify("Reviewing diff (isolated reviewer)…", "info");
			const out = await review(args, process.cwd());
			ctx.ui.notify(out, "info");
			return out; // surface to the conversation so the agent can act on findings
		},
	});

	pi.registerTool({
		name: "review_diff",
		label: "review",
		description:
			"Review the current git diff via an isolated reviewer subagent — returns findings ranked P0-P3 with a " +
			"SHIP/FIX-FIRST verdict. target: 'working' (default), 'staged', or a git ref. Use before committing/PRing.",
		promptSnippet:
			"review_diff(target?) — isolated reviewer ranks the diff P0-P3 with a SHIP/FIX verdict (before commit/PR)",
		parameters: { type: "object", properties: { target: { type: "string" } } },
		async execute(_id: string, params: any) {
			return { content: [{ type: "text", text: await review(params.target ?? "working", process.cwd()) }] };
		},
	});

	// Heavy path: devbrain contract verification, only if the repo has contracts.
	pi.registerCommand("verify", {
		description: "Run devbrain contract verification (if the repo defines devbrain/contracts)",
		handler: async (args: string, ctx: any) => {
			const cwd = process.cwd();
			const contracts = join(cwd, "devbrain", "contracts");
			if (!existsSync(contracts)) {
				ctx.ui.notify(
					"No devbrain/contracts in this repo — /verify runs the contract engine only where contracts are defined. Use /review for a diff review.",
					"info",
				);
				return;
			}
			const cliPath = resolve(process.env.HOME || "", "project/harness/harness-core/verification/cli.py");
			if (!existsSync(cliPath)) {
				ctx.ui.notify("devbrain verification engine not found (harness-core/verification).", "warning");
				return;
			}
			ctx.ui.notify("Running devbrain contract verification…", "info");
			try {
				const out = execSync(`${DEVBRAIN_PY} ${cliPath} --repo-path ${cwd} ${(args || "").trim()}`, {
					cwd,
					encoding: "utf-8",
					maxBuffer: 8 * 1024 * 1024,
					timeout: 600_000,
				});
				ctx.ui.notify(out.slice(-3000), "info");
				return out;
			} catch (e: any) {
				ctx.ui.notify(`Verification: ${(e.stdout || e.message || "").slice(-2000)}`, "warning");
			}
		},
	});
}
