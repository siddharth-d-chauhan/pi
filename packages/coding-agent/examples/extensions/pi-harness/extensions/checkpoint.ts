/**
 * checkpoint.ts — auto-snapshot files before edits; /rewind to restore.
 *
 * The safety net all three competitors ship (Claude Code /rewind, opencode /undo,
 * oh-my-pi checkpoint+rewind). Before a mutating tool runs, snapshot the file(s)
 * it will touch; /rewind restores to a prior checkpoint. Undo the agent's edits
 * without relying on git being clean.
 *
 * Mechanism (no git dependency, works anywhere): each checkpoint copies the
 * pre-edit content of touched files into a session snapshot store under
 * ~/.pi/agent/pi-harness/checkpoints/<session>/<n>/. /rewind <n> restores those
 * files. Cheap (only touched files, only their pre-state), and independent of
 * git so it survives dirty trees / non-repos.
 *
 * Caveat (same as Claude Code's): only tracks files mutated through the edit/
 * write/hedit tools — bash-modified files aren't snapshotted (we can't know what
 * a shell command will touch ahead of time). Documented, not silent.
 *
 * Flow:  (automatic) checkpoint before each edit/write/hedit
 *        /checkpoints        list checkpoints this session
 *        /rewind [n]          restore to checkpoint n (default: last)
 *        /checkpoint [label]  manual checkpoint of the whole cwd tree (light)
 *
 * Config: KP_CHECKPOINT_ENABLED=0 disable.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, type Stats, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ENABLED = process.env.KP_CHECKPOINT_ENABLED !== "0";
const ROOT = join(homedir(), ".pi", "agent", "pi-harness", "checkpoints");
const EDIT_TOOLS = /^(edit|write|hedit|multiedit|apply_patch|str_replace)$/;

export default function (pi: any) {
	if (!ENABLED) return;

	let session = "s";
	let counter = 0;
	const checkpoints: {
		n: number;
		label: string;
		files: { rel: string; snap: string; existed: boolean }[];
		when: string;
	}[] = [];

	pi.on("session_start", async (event: any) => {
		session = (event?.sessionId || "s").slice(0, 24);
	});

	function sessionDir(): string {
		return join(ROOT, session);
	}

	// Snapshot a file's current content before it's mutated.
	function snapshotFile(absPath: string, cpDir: string): { rel: string; snap: string; existed: boolean } | null {
		const rel = relative(process.cwd(), absPath) || absPath;
		const existed = existsSync(absPath);
		const snap = join(cpDir, rel.replace(/[/\\]/g, "__"));
		try {
			mkdirSync(dirname(snap), { recursive: true });
			if (existed) copyFileSync(absPath, snap);
			else writeFileSync(`${snap}.ABSENT`, ""); // marker: file didn't exist → rewind deletes it
			return { rel, snap: existed ? snap : `${snap}.ABSENT`, existed };
		} catch {
			return null;
		}
	}

	// Before an edit tool runs, checkpoint the file it targets.
	pi.on("tool_call", async (event: any) => {
		if (!EDIT_TOOLS.test(event.toolName)) return;
		const target = String(event.input?.path ?? event.input?.file_path ?? "").trim();
		if (!target) return;
		const abs = resolve(process.cwd(), target);
		const n = ++counter;
		const cpDir = join(sessionDir(), String(n));
		mkdirSync(cpDir, { recursive: true });
		const snap = snapshotFile(abs, cpDir);
		if (snap) checkpoints.push({ n, label: `before ${event.toolName} ${snap.rel}`, files: [snap], when: nowStr() });
		// never block — checkpointing is transparent
	});

	function nowStr(): string {
		try {
			return new Date().toISOString().slice(11, 19);
		} catch {
			return "?";
		}
	}

	function restore(cp: (typeof checkpoints)[number]): string[] {
		const restored: string[] = [];
		for (const f of cp.files) {
			const abs = resolve(process.cwd(), f.rel);
			try {
				if (f.existed) {
					copyFileSync(f.snap, abs);
					restored.push(f.rel);
				} else if (existsSync(abs)) {
					require("node:fs").rmSync(abs);
					restored.push(`${f.rel} (removed)`);
				}
			} catch {}
		}
		return restored;
	}

	pi.registerCommand("checkpoints", {
		description: "List file checkpoints taken this session",
		handler: async (_a: string, ctx: any) => {
			if (!checkpoints.length) {
				ctx.ui.notify("No checkpoints yet (auto-taken before each edit/write/hedit).", "info");
				return;
			}
			ctx.ui.notify(
				"Checkpoints (newest last):\n" +
					checkpoints
						.slice(-15)
						.map((c) => `  ${c.n} [${c.when}] ${c.label}`)
						.join("\n") +
					"\n/rewind [n] to restore (default: last).",
				"info",
			);
		},
	});

	pi.registerCommand("rewind", {
		description: "Restore files to a checkpoint: /rewind [n] (default last). Undoes the agent's edits.",
		handler: async (args: string, ctx: any) => {
			if (!checkpoints.length) {
				ctx.ui.notify("Nothing to rewind.", "info");
				return;
			}
			const n = (args || "").trim() ? Number(args.trim()) : checkpoints[checkpoints.length - 1].n;
			const cp = checkpoints.find((c) => c.n === n);
			if (!cp) {
				ctx.ui.notify(`No checkpoint ${n}. /checkpoints to list.`, "warning");
				return;
			}
			const restored = restore(cp);
			ctx.ui.notify(
				restored.length
					? `⏪ Rewound to checkpoint ${n} (${cp.label}). Restored: ${restored.join(", ")}.\n(Note: bash-modified files are not tracked.)`
					: `Checkpoint ${n} had nothing to restore.`,
				"info",
			);
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Manually snapshot the current working tree: /checkpoint [label]",
		handler: async (args: string, ctx: any) => {
			const label = (args || "").trim() || "manual";
			const n = ++counter;
			const cpDir = join(sessionDir(), String(n));
			mkdirSync(cpDir, { recursive: true });
			const files: { rel: string; snap: string; existed: boolean }[] = [];
			// snapshot tracked-ish files in cwd (skip heavy/ignored dirs)
			const skip = /(^|\/)(node_modules|\.git|\.venv|dist|build|__pycache__|\.pi)(\/|$)/;
			const walk = (dir: string, depth: number) => {
				if (depth > 6) return;
				let entries: string[];
				try {
					entries = readdirSync(dir);
				} catch {
					return;
				}
				for (const e of entries) {
					const p = join(dir, e);
					const rel = relative(process.cwd(), p);
					if (skip.test(`/${rel}`)) continue;
					let st: Stats;
					try {
						st = statSync(p);
					} catch {
						continue;
					}
					if (st.isDirectory()) walk(p, depth + 1);
					else if (st.size < 1_000_000) {
						const s = snapshotFile(p, cpDir);
						if (s) files.push(s);
					}
				}
			};
			walk(process.cwd(), 0);
			checkpoints.push({ n, label, files, when: nowStr() });
			ctx.ui.notify(`📌 Checkpoint ${n} '${label}' — ${files.length} files. /rewind ${n} to restore.`, "info");
		},
	});
}
