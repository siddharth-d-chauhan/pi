/**
 * Edit-Lock Extension — file-ownership discipline for parallel agents
 * (next-fix #7). Two agents editing one working tree eventually produce a
 * subtle merge bug; this makes ownership explicit and cheap:
 *
 * - the first edit/write to a file auto-acquires a lock (owner = this pi
 *   session, TTL 30min, refreshed on every touch)
 * - an edit to a file locked by ANOTHER live owner is blocked with a
 *   takeover hint
 * - /locks           list live locks
 * - /lock <path>     acquire explicitly
 * - /unlock <path>   release (or `/unlock all` for everything you own)
 * - /unlock steal <path>  explicit takeover
 *
 * Locks live in <agentDir>/edit-locks.json — shared by every pi session on
 * this machine. Best-effort advisory locking: it protects cooperating
 * agents, it is not an OS-level guarantee.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const TTL_MS = 30 * 60 * 1000;

interface LockEntry {
	owner: string;
	expiresAt: number;
}

function lockFile(): string {
	return join(getAgentDir(), "edit-locks.json");
}

function loadLocks(): Record<string, LockEntry> {
	try {
		const locks = JSON.parse(readFileSync(lockFile(), "utf8")) as Record<string, LockEntry>;
		const now = Date.now();
		for (const [path, entry] of Object.entries(locks)) {
			if (entry.expiresAt < now) delete locks[path];
		}
		return locks;
	} catch {
		return {};
	}
}

function saveLocks(locks: Record<string, LockEntry>): void {
	try {
		writeFileSync(lockFile(), `${JSON.stringify(locks, null, "\t")}\n`);
	} catch {
		// advisory locking is best-effort
	}
}

function normalize(path: string, cwd: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export default function (pi: ExtensionAPI) {
	let owner = `pi-${process.pid}`;

	pi.on("session_start", async (_event, ctx) => {
		owner = `pi-${ctx.sessionManager.getSessionId?.() ?? process.pid}`;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const input = (event as { input?: Record<string, unknown> }).input ?? {};
		const raw = typeof input.file_path === "string" ? input.file_path : undefined;
		if (!raw) return;
		const path = normalize(raw, ctx.cwd);
		const locks = loadLocks();
		const existing = locks[path];
		if (existing && existing.owner !== owner) {
			return {
				block: true,
				reason:
					`${path} is locked by ${existing.owner} (expires ${new Date(existing.expiresAt).toLocaleTimeString()}). ` +
					`Coordinate, wait, or take over explicitly with /unlock steal ${raw}`,
			};
		}
		// Acquire/refresh — every touch extends ownership.
		locks[path] = { owner, expiresAt: Date.now() + TTL_MS };
		saveLocks(locks);
	});

	pi.registerCommand("locks", {
		description: "List live edit locks",
		handler: async (_args, ctx) => {
			const locks = loadLocks();
			const rows = Object.entries(locks).map(([path, entry]) => {
				const mine = entry.owner === owner ? " (you)" : "";
				return `${path} — ${entry.owner}${mine} · ${Math.round((entry.expiresAt - Date.now()) / 60000)}m left`;
			});
			ctx.ui.notify(rows.join("\n") || "No live edit locks.", "info");
		},
	});

	pi.registerCommand("lock", {
		description: "Acquire an edit lock: /lock <path>",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /lock <path>", "error");
				return;
			}
			const path = normalize(raw, ctx.cwd);
			const locks = loadLocks();
			if (locks[path] && locks[path].owner !== owner) {
				ctx.ui.notify(`Already locked by ${locks[path].owner}.`, "error");
				return;
			}
			locks[path] = { owner, expiresAt: Date.now() + TTL_MS };
			saveLocks(locks);
			ctx.ui.notify(`Locked ${path} for ${owner}.`, "info");
		},
	});

	pi.registerCommand("unlock", {
		description: "Release edit locks: /unlock <path> | all | steal <path>",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const locks = loadLocks();
			if (parts[0] === "all") {
				for (const [path, entry] of Object.entries(locks)) {
					if (entry.owner === owner) delete locks[path];
				}
				saveLocks(locks);
				ctx.ui.notify("Released all locks you own.", "info");
				return;
			}
			const steal = parts[0] === "steal";
			const raw = steal ? parts[1] : parts[0];
			if (!raw) {
				ctx.ui.notify("Usage: /unlock <path> | all | steal <path>", "error");
				return;
			}
			const path = normalize(raw, ctx.cwd);
			const entry = locks[path];
			if (!entry) {
				ctx.ui.notify("Not locked.", "info");
				return;
			}
			if (entry.owner !== owner && !steal) {
				ctx.ui.notify(`Locked by ${entry.owner} — use /unlock steal ${raw} to take over explicitly.`, "error");
				return;
			}
			delete locks[path];
			saveLocks(locks);
			ctx.ui.notify(`Unlocked ${path}${steal ? ` (taken over from ${entry.owner})` : ""}.`, "info");
		},
	});
}
