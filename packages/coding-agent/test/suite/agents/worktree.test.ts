import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentWorktree,
	createAgentWorktree,
	finalizeAgentWorktree,
	isGitRepo,
} from "../../../src/core/agents/worktree.ts";

describe("agent worktrees", () => {
	const tempDirs: string[] = [];
	const worktrees: Array<{ repo: string; worktree: AgentWorktree }> = [];

	afterEach(() => {
		// Remove kept/leftover worktrees first so the repo dirs can go cleanly.
		while (worktrees.length > 0) {
			const entry = worktrees.pop();
			if (!entry) continue;
			rmSync(entry.worktree.path, { recursive: true, force: true });
			if (existsSync(entry.repo)) {
				gitIgnoreFailure(entry.repo, ["worktree", "prune"]);
				gitIgnoreFailure(entry.repo, ["branch", "-D", entry.worktree.branch]);
			}
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function git(cwd: string, args: string[]): string {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	}

	function gitIgnoreFailure(cwd: string, args: string[]): void {
		try {
			git(cwd, args);
		} catch {
			// cleanup only
		}
	}

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function makeRepo(): string {
		const repo = makeTempDir("pi-worktree-repo-");
		git(repo, ["init", "--initial-branch=main"]);
		git(repo, ["config", "user.email", "test@example.com"]);
		git(repo, ["config", "user.name", "Test"]);
		writeFileSync(join(repo, "README.md"), "hello\n");
		git(repo, ["add", "README.md"]);
		git(repo, ["commit", "-m", "initial"]);
		return repo;
	}

	async function create(repo: string, id: string): Promise<AgentWorktree> {
		const worktree = await createAgentWorktree(repo, id);
		worktrees.push({ repo, worktree });
		return worktree;
	}

	function uniqueId(): string {
		return Math.random().toString(36).slice(2, 10);
	}

	function branchExists(repo: string, branch: string): boolean {
		return git(repo, ["branch", "--list", branch]).trim().length > 0;
	}

	it("creates a worktree on a pi-agent branch at HEAD", async () => {
		const repo = makeRepo();
		const id = uniqueId();
		const worktree = await create(repo, id);

		expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
		expect(worktree.branch).toBe(`pi-agent/${id}`);
		expect(worktree.baseSha).toBe(git(repo, ["rev-parse", "HEAD"]).trim());
		expect(git(worktree.path, ["rev-parse", "HEAD"]).trim()).toBe(worktree.baseSha);
		expect(branchExists(repo, worktree.branch)).toBe(true);
	});

	it("removes worktree and branch when nothing changed", async () => {
		const repo = makeRepo();
		const worktree = await create(repo, uniqueId());

		const outcome = await finalizeAgentWorktree(repo, worktree);

		expect(outcome).toEqual({ kept: false, changedFiles: 0 });
		expect(existsSync(worktree.path)).toBe(false);
		expect(branchExists(repo, worktree.branch)).toBe(false);
	});

	it("keeps the worktree when uncommitted changes exist", async () => {
		const repo = makeRepo();
		const worktree = await create(repo, uniqueId());
		writeFileSync(join(worktree.path, "new-file.txt"), "changed\n");

		const outcome = await finalizeAgentWorktree(repo, worktree);

		expect(outcome.kept).toBe(true);
		expect(outcome.path).toBe(worktree.path);
		expect(outcome.branch).toBe(worktree.branch);
		expect(outcome.changedFiles).toBe(1);
		expect(existsSync(worktree.path)).toBe(true);
		expect(branchExists(repo, worktree.branch)).toBe(true);
	});

	it("keeps the worktree when changes were committed", async () => {
		const repo = makeRepo();
		const worktree = await create(repo, uniqueId());
		writeFileSync(join(worktree.path, "committed.txt"), "done\n");
		git(worktree.path, ["add", "committed.txt"]);
		git(worktree.path, ["commit", "-m", "agent work"]);

		const outcome = await finalizeAgentWorktree(repo, worktree);

		expect(outcome.kept).toBe(true);
		expect(outcome.changedFiles).toBe(1);
		expect(existsSync(worktree.path)).toBe(true);
		expect(branchExists(repo, worktree.branch)).toBe(true);
	});

	it("double-finalize is idempotent after removal", async () => {
		const repo = makeRepo();
		const worktree = await create(repo, uniqueId());

		await finalizeAgentWorktree(repo, worktree);
		const second = await finalizeAgentWorktree(repo, worktree);

		expect(second).toEqual({ kept: false, changedFiles: 0 });
	});

	it("isGitRepo is false on a plain directory", async () => {
		const plain = makeTempDir("pi-worktree-plain-");
		expect(await isGitRepo(plain)).toBe(false);
		expect(await isGitRepo(makeRepo())).toBe(true);
	});

	it("createAgentWorktree throws on a plain directory", async () => {
		const plain = makeTempDir("pi-worktree-plain-");
		await expect(createAgentWorktree(plain, uniqueId())).rejects.toThrow(/not inside a git repository/);
	});

	it("createAgentWorktree throws on a repo without commits", async () => {
		const repo = makeTempDir("pi-worktree-empty-");
		mkdirSync(repo, { recursive: true });
		git(repo, ["init", "--initial-branch=main"]);
		await expect(createAgentWorktree(repo, uniqueId())).rejects.toThrow(/failed to resolve HEAD/);
	});
});
