/**
 * repohost.ts — GitHub/Bitbucket PRs & issues as readable paths. One interface.
 *
 * oh-my-pi's "GitHub is just another filesystem": instead of N bespoke tools
 * (gh_pr_view, gh_issue_view, bb_pr_view … each with its own params), one `repo`
 * tool resolves a path to the content. You use Bitbucket primarily, so both are
 * wired.
 *
 * Paths:
 *   github://owner/repo/pr/123          PR: title, body, diff, comments (via gh)
 *   github://owner/repo/issue/45        issue: title, body, comments
 *   bitbucket://workspace/repo/pr/12    PR: title, description, diff, comments (REST)
 *   bitbucket://workspace/repo/issue/9  issue
 *
 * Auth: GitHub via the `gh` CLI (already logged in). Bitbucket via REST with
 * BITBUCKET_TOKEN (an app password or access token) + optional BITBUCKET_EMAIL for
 * basic auth — never inline; read from env.
 *
 * Config: KP_REPOHOST_ENABLED=0 · BITBUCKET_TOKEN · BITBUCKET_EMAIL.
 */

import { execFileSync } from "node:child_process";

const ENABLED = process.env.KP_REPOHOST_ENABLED !== "0";
const BB_TOKEN = process.env.BITBUCKET_TOKEN || "";
const BB_EMAIL = process.env.BITBUCKET_EMAIL || "";

function gh(args: string[]): string {
	try {
		return execFileSync("gh", args, { encoding: "utf-8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	} catch (e: any) {
		return `gh error: ${(e.stderr || e.message || "").slice(0, 300)}`;
	}
}

function bbGet(path: string): any {
	if (!BB_TOKEN) throw new Error("Bitbucket needs BITBUCKET_TOKEN (app password / access token) in env");
	const auth = BB_EMAIL ? `-u ${BB_EMAIL}:${BB_TOKEN}` : `-H "Authorization: Bearer ${BB_TOKEN}"`;
	const out = execFileSync("bash", ["-c", `curl -s ${auth} "https://api.bitbucket.org/2.0/${path}"`], {
		encoding: "utf-8",
		timeout: 60_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	return JSON.parse(out);
}
function bbGetRaw(path: string): string {
	const auth = BB_EMAIL ? `-u ${BB_EMAIL}:${BB_TOKEN}` : `-H "Authorization: Bearer ${BB_TOKEN}"`;
	return execFileSync("bash", ["-c", `curl -s ${auth} "https://api.bitbucket.org/2.0/${path}"`], {
		encoding: "utf-8",
		timeout: 60_000,
		maxBuffer: 8 * 1024 * 1024,
	});
}

function resolveGitHub(owner: string, repo: string, kind: string, n: string): string {
	const r = `${owner}/${repo}`;
	if (kind === "pr") {
		const meta = gh([
			"pr",
			"view",
			n,
			"-R",
			r,
			"--json",
			"title,body,state,author,comments",
			"-q",
			'.title + "\\n" + .state + " by " + .author.login + "\\n\\n" + .body',
		]);
		const diff = gh(["pr", "diff", n, "-R", r]);
		return `# PR #${n} (${r})\n${meta}\n\n## Diff\n${diff.slice(0, 40000)}`;
	}
	if (kind === "issue") {
		return `# Issue #${n} (${r})\n${gh(["issue", "view", n, "-R", r, "--comments"])}`;
	}
	return `unknown github kind: ${kind}`;
}

function resolveBitbucket(ws: string, repo: string, kind: string, n: string): string {
	const slug = `${ws}/${repo}`;
	try {
		if (kind === "pr") {
			const pr = bbGet(`repositories/${slug}/pullrequests/${n}`);
			const diff = bbGetRaw(`repositories/${slug}/pullrequests/${n}/diff`);
			let comments = "";
			try {
				const cs = bbGet(`repositories/${slug}/pullrequests/${n}/comments?pagelen=50`);
				comments = (cs.values || [])
					.map((c: any) => `- ${c.user?.display_name}: ${c.content?.raw ?? ""}`)
					.join("\n");
			} catch {}
			return `# PR #${n} (${slug})\n${pr.title}\n${pr.state} by ${pr.author?.display_name}\n\n${pr.description ?? ""}\n\n## Comments\n${comments}\n\n## Diff\n${diff.slice(0, 40000)}`;
		}
		if (kind === "issue") {
			const iss = bbGet(`repositories/${slug}/issues/${n}`);
			return `# Issue #${n} (${slug})\n${iss.title}\n${iss.state}\n\n${iss.content?.raw ?? ""}`;
		}
		return `unknown bitbucket kind: ${kind}`;
	} catch (e: any) {
		return `Bitbucket error: ${e.message}`;
	}
}

// parse "github://owner/repo/pr/123" or "bitbucket://ws/repo/issue/9"
function parsePath(path: string): { host: string; a: string; b: string; kind: string; n: string } | null {
	const m = path.match(/^(github|bitbucket):\/\/([^/]+)\/([^/]+)\/(pr|pull|issue|pullrequest)s?\/(\d+)/i);
	if (!m) return null;
	const kind = /^(pr|pull)/i.test(m[4]) ? "pr" : "issue";
	return { host: m[1].toLowerCase(), a: m[2], b: m[3], kind, n: m[5] };
}

export default function (pi: any) {
	if (!ENABLED) return;

	pi.registerTool({
		name: "repo",
		label: "repo",
		description:
			"Read a PR or issue from GitHub or Bitbucket by path — one interface for both. " +
			"path: github://owner/repo/pr/123 · github://owner/repo/issue/45 · bitbucket://workspace/repo/pr/12 · " +
			"bitbucket://workspace/repo/issue/9. Returns title/body/diff/comments. Use before implementing from a PR/ticket.",
		promptSnippet: "repo(path) — read a GitHub/Bitbucket PR or issue by path (github://…/pr/N, bitbucket://…/pr/N)",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "github:// or bitbucket:// PR/issue path" } },
			required: ["path"],
		},
		async execute(_id: string, params: any) {
			const p = parsePath(String(params.path ?? ""));
			if (!p)
				return {
					content: [
						{
							type: "text",
							text: "bad path. Use github://owner/repo/pr/N or bitbucket://workspace/repo/pr/N (or /issue/N).",
						},
					],
					isError: true,
				};
			const text =
				p.host === "github" ? resolveGitHub(p.a, p.b, p.kind, p.n) : resolveBitbucket(p.a, p.b, p.kind, p.n);
			return { content: [{ type: "text", text }] };
		},
	});
}
