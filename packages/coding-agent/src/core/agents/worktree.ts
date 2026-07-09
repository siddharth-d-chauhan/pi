/**
 * Git-worktree isolation for write-capable subagents.
 *
 * A worktree agent gets its own checkout under the OS temp dir on a dedicated
 * `pi-agent/<id8>` branch. After the child run, `finalizeAgentWorktree`
 * applies Claude Code semantics: if the checkout is byte-identical to the
 * base commit (no dirty files, no new commits), the worktree and branch are
 * removed; otherwise both are preserved so the user can inspect/merge.
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execCommand } from "../exec.ts";

export interface AgentWorktree {
	/** The worktree checkout the child uses as cwd. */
	path: string;
	/** Dedicated branch, e.g. "pi-agent/<id8>". */
	branch: string;
	/** The commit the worktree was created from. */
	baseSha: string;
}

export interface WorktreeOutcome {
	/** True when changes exist (worktree + branch preserved). */
	kept: boolean;
	/** Present when kept. */
	path?: string;
	branch?: string;
	changedFiles: number;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await execCommand("git", args, cwd);
	return { stdout: result.stdout, stderr: result.stderr, code: result.code };
}

/** True when `cwd` is inside a git repository work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
	if (!existsSync(cwd)) return false;
	const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return result.code === 0;
}

/**
 * Create an isolated worktree for agent `id` off the current HEAD of the
 * repository containing `repoCwd`. Throws with a clear message when
 * `repoCwd` is not a git repository or any git call fails.
 */
export async function createAgentWorktree(repoCwd: string, id: string): Promise<AgentWorktree> {
	const toplevel = await git(repoCwd, ["rev-parse", "--show-toplevel"]);
	if (toplevel.code !== 0) {
		throw new Error(
			`Cannot create agent worktree: "${repoCwd}" is not inside a git repository (${toplevel.stderr.trim() || "git rev-parse failed"}).`,
		);
	}
	const repoRoot = toplevel.stdout.trim();

	const head = await git(repoCwd, ["rev-parse", "HEAD"]);
	if (head.code !== 0) {
		throw new Error(
			`Cannot create agent worktree: failed to resolve HEAD in "${repoRoot}" (${head.stderr.trim() || "does the repository have any commits?"}).`,
		);
	}
	const baseSha = head.stdout.trim();

	const id8 = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || Math.random().toString(36).slice(2, 10);
	const branch = `pi-agent/${id8}`;
	const worktreesRoot = join(tmpdir(), "pi-worktrees");
	mkdirSync(worktreesRoot, { recursive: true });
	const worktreePath = join(worktreesRoot, `${basename(repoRoot)}-${id8}`);

	const add = await git(repoCwd, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.code !== 0) {
		throw new Error(
			`Cannot create agent worktree at "${worktreePath}": ${add.stderr.trim() || "git worktree add failed"}.`,
		);
	}

	return { path: worktreePath, branch, baseSha };
}

/**
 * Finalize a worktree after the child run. Unchanged (clean status AND HEAD
 * still at baseSha) → remove worktree + delete branch, `kept: false`.
 * Otherwise everything is left in place and `kept: true` is returned with
 * the changed-file count. Idempotent: a second call after removal returns
 * `kept: false` without throwing.
 */
export async function finalizeAgentWorktree(repoCwd: string, worktree: AgentWorktree): Promise<WorktreeOutcome> {
	// Already removed (double-finalize, manual cleanup): nothing to do.
	if (!existsSync(worktree.path)) {
		return { kept: false, changedFiles: 0 };
	}

	const status = await git(repoCwd, ["-C", worktree.path, "status", "--porcelain"]);
	if (status.code !== 0) {
		throw new Error(
			`Cannot finalize agent worktree "${worktree.path}": ${status.stderr.trim() || "git status failed"}.`,
		);
	}
	const dirtyFiles = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;

	const head = await git(repoCwd, ["-C", worktree.path, "rev-parse", "HEAD"]);
	if (head.code !== 0) {
		throw new Error(
			`Cannot finalize agent worktree "${worktree.path}": ${head.stderr.trim() || "git rev-parse failed"}.`,
		);
	}
	const headSha = head.stdout.trim();

	if (dirtyFiles === 0 && headSha === worktree.baseSha) {
		const remove = await git(repoCwd, ["worktree", "remove", "--force", worktree.path]);
		if (remove.code !== 0) {
			throw new Error(
				`Failed to remove unchanged agent worktree "${worktree.path}": ${remove.stderr.trim() || "git worktree remove failed"}.`,
			);
		}
		// Best-effort: the branch may already be gone.
		await git(repoCwd, ["branch", "-D", worktree.branch]);
		return { kept: false, changedFiles: 0 };
	}

	let changedFiles = dirtyFiles;
	if (changedFiles === 0) {
		// Committed-only changes: count files touched since the base commit.
		const diff = await git(repoCwd, ["-C", worktree.path, "diff", "--name-only", `${worktree.baseSha}..HEAD`]);
		changedFiles = diff.stdout.split("\n").filter((line) => line.trim().length > 0).length;
	}

	return { kept: true, path: worktree.path, branch: worktree.branch, changedFiles };
}
