/**
 * session-search.ts — search across all past pi conversations, cheaply.
 *
 * pi persists every session as JSONL under ~/.pi/agent/sessions/. This keeps an
 * incremental SQLite FTS5 index (node:sqlite, porter stemming, BM25): each
 * session file is parsed exactly once per change (mtime+size tracked), searches
 * are millisecond index lookups — no LLM calls, no embeddings, no daemon.
 * Results are compact pointers (reference-based); session_fetch expands a hit
 * on demand. Durable *facts* still belong in the brain; this is verbatim recall
 * of what was said.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DB_DIR = join(homedir(), ".pi", "agent", "pi-harness");
const DB_PATH = join(DB_DIR, "session-index.db");
const BREADCRUMB_PATH = join(DB_DIR, "session-breadcrumbs.json");

// ---------------------------------------------------------------------------
// Session-ops: per-pane "continue where I left off".
//
// Keyed by TTY / TMUX_PANE so multiple concurrent panes each resolve to THEIR
// own last session, not a single global pointer. On resume we compare the
// recorded cwd to the current cwd and surface a re-root-vs-fork choice when they
// differ. Transcript listing for a large session uses a bounded prefix+tail
// slice so we never read a multi-MB JSONL whole.
// ---------------------------------------------------------------------------

/** Stable key for this terminal pane. */
function paneKey(): string {
	return (
		process.env.TMUX_PANE ||
		process.env.PI_PANE ||
		process.env.STY || // GNU screen
		process.env.WINDOWID ||
		process.env.SSH_TTY ||
		process.env.TTY ||
		process.env.TERM_SESSION_ID || // macOS Terminal.app / iTerm
		"default"
	);
}

interface Breadcrumb {
	session: string; // session file path
	cwd: string;
	when: string;
}

function loadBreadcrumbs(): Record<string, Breadcrumb> {
	try {
		if (existsSync(BREADCRUMB_PATH)) return JSON.parse(readFileSync(BREADCRUMB_PATH, "utf-8"));
	} catch {}
	return {};
}

function saveBreadcrumb(crumb: Breadcrumb) {
	try {
		mkdirSync(DB_DIR, { recursive: true });
		const all = loadBreadcrumbs();
		all[paneKey()] = crumb;
		writeFileSync(BREADCRUMB_PATH, JSON.stringify(all, null, 2));
	} catch {}
}

/** Bounded prefix+tail read of a JSONL transcript — never loads a huge file whole. */
export function boundedSlice(file: string, headN = 6, tailN = 6): { head: any[]; tail: any[]; total: number } {
	let lines: string[] = [];
	try {
		lines = readFileSync(file, "utf-8")
			.split("\n")
			.filter((l) => l.trim());
	} catch {
		return { head: [], tail: [], total: 0 };
	}
	const parse = (arr: string[]) =>
		arr
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter((e) => e?.message?.role);
	if (lines.length <= headN + tailN) {
		const all = parse(lines);
		return { head: all, tail: [], total: all.length };
	}
	return {
		head: parse(lines.slice(0, headN)),
		tail: parse(lines.slice(-tailN)),
		total: lines.length,
	};
}

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
	if (db) return db;
	mkdirSync(DB_DIR, { recursive: true });
	db = new DatabaseSync(DB_PATH);
	db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
      text, role UNINDEXED, file UNINDEXED, entry_id UNINDEXED, ts UNINDEXED,
      tokenize='porter unicode61'
    );
  `);
	return db;
}

function entryText(entry: any): string {
	const m = entry?.message;
	if (!m?.content) return "";
	return (Array.isArray(m.content) ? m.content : [])
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n");
}

/** Parse-once incremental sync: only files whose mtime/size changed are (re)indexed. */
function syncIndex(): { files: number; reindexed: number } {
	const d = getDb();
	const known = new Map<string, { mtime: number; size: number }>();
	for (const r of d.prepare("SELECT path, mtime, size FROM files").all() as any[])
		known.set(r.path, { mtime: r.mtime, size: r.size });

	const insFile = d.prepare("INSERT OR REPLACE INTO files (path, mtime, size) VALUES (?, ?, ?)");
	const delEntries = d.prepare("DELETE FROM entries WHERE file = ?");
	const insEntry = d.prepare("INSERT INTO entries (text, role, file, entry_id, ts) VALUES (?, ?, ?, ?, ?)");

	let files = 0,
		reindexed = 0;
	for (const dir of readdirSync(SESSIONS_ROOT)) {
		const dirPath = join(SESSIONS_ROOT, dir);
		let names: string[];
		try {
			names = readdirSync(dirPath).filter((n) => n.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(dirPath, name);
			files++;
			const st = statSync(path);
			const k = known.get(path);
			if (k && k.mtime === st.mtimeMs && k.size === st.size) continue;

			d.exec("BEGIN");
			try {
				delEntries.run(path);
				for (const line of readFileSync(path, "utf-8").split("\n")) {
					let e: any;
					try {
						e = JSON.parse(line);
					} catch {
						continue;
					}
					const role = e?.message?.role;
					if (role !== "user" && role !== "assistant") continue;
					const text = entryText(e);
					if (text.trim()) insEntry.run(text, role, path, String(e.id ?? ""), e.timestamp ?? 0);
				}
				insFile.run(path, st.mtimeMs, st.size);
				d.exec("COMMIT");
				reindexed++;
			} catch (err) {
				d.exec("ROLLBACK");
				throw err;
			}
		}
	}
	return { files, reindexed };
}

// pi encodes cwd into the dir name, but symlink resolution (/tmp→/private/tmp on
// macOS) makes a single reconstruction unreliable — match both the literal and
// the realpath-resolved encoding.
function projectDirCandidates(cwd: string): string[] {
	const enc = (p: string) => `--${p.replace(/^\//, "").replaceAll("/", "-")}--`;
	const set = new Set([enc(cwd)]);
	try {
		set.add(enc(realpathSync(cwd)));
	} catch {}
	return [...set];
}

export function search(query: string, scope: string, cwd: string, role: string, maxResults: number) {
	syncIndex();
	const d = getDb();
	// AND of quoted terms — safe against FTS5 syntax injection, porter still stems.
	const match = query
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => `"${t.replaceAll('"', "")}"`)
		.join(" ");
	if (!match) return [];
	let sql = `SELECT snippet(entries, 0, '', '', '…', 24) AS snip, role, file, entry_id, ts
             FROM entries WHERE entries MATCH ?`;
	const params: any[] = [match];
	if (role !== "any") {
		sql += " AND role = ?";
		params.push(role);
	}
	if (scope === "project") {
		const cands = projectDirCandidates(cwd);
		sql += ` AND (${cands.map(() => "file LIKE ?").join(" OR ")})`;
		for (const c of cands) params.push(`${join(SESSIONS_ROOT, c)}%`);
	}
	sql += " ORDER BY bm25(entries), ts DESC LIMIT ?";
	params.push(maxResults * 3);

	const rows = d.prepare(sql).all(...params) as any[];
	const perSession = new Map<string, number>();
	const out: any[] = [];
	for (const r of rows) {
		const session = basename(r.file);
		const n = perSession.get(session) ?? 0;
		if (n >= 3) continue;
		perSession.set(session, n + 1);
		out.push({
			session,
			file: r.file,
			entryId: r.entry_id,
			role: r.role,
			when: r.ts ? new Date(r.ts).toISOString().slice(0, 16) : "?",
			snippet: String(r.snip).replace(/\s+/g, " ").slice(0, 240),
		});
		if (out.length >= maxResults) break;
	}
	return out;
}

export default function (pi: any) {
	pi.registerTool({
		name: "session_search",
		label: "session search",
		description:
			"Search across ALL past conversations (pi session transcripts on this machine) via a local " +
			"FTS index (BM25, stemmed). Use when the user refers to something previously discussed " +
			"('what did we decide about X', 'the error from yesterday'). Returns compact pointers; " +
			"expand a hit with session_fetch.",
		promptSnippet:
			"session_search(query) — fast indexed search over all past conversations; session_fetch expands a hit",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "keywords (AND-matched, stemmed)" },
				scope: { type: "string", enum: ["project", "all"], description: "default project" },
				role: { type: "string", enum: ["user", "assistant", "any"], description: "default any" },
				max_results: { type: "number", description: "default 8" },
			},
			required: ["query"],
		},
		async execute(_id: string, params: any) {
			const res = search(
				params.query,
				params.scope ?? "project",
				process.cwd(),
				params.role ?? "any",
				params.max_results ?? 8,
			);
			if (!res.length)
				return { content: [{ type: "text", text: `No past-conversation matches for: ${params.query}` }] };
			const lines = res.map((h) => `[${h.when}] ${h.role} (${h.session} #${h.entryId}): …${h.snippet}…`);
			return {
				content: [
					{
						type: "text",
						text: `${res.length} matches (best first):\n${lines.join("\n")}\n\nUse session_fetch(file, entry_id) for full context.`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "session_fetch",
		label: "session fetch",
		description: "Expand a session_search hit: full text of the matched entry plus surrounding turns.",
		parameters: {
			type: "object",
			properties: {
				file: { type: "string", description: "session file path from session_search" },
				entry_id: { type: "string", description: "entry id from session_search" },
				context_entries: { type: "number", description: "surrounding entries each side, default 2" },
			},
			required: ["file", "entry_id"],
		},
		async execute(_id: string, params: any) {
			if (!params.file.startsWith(SESSIONS_ROOT)) throw new Error("only pi session files are fetchable");
			const entries = readFileSync(params.file, "utf-8")
				.split("\n")
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter((e) => e?.message?.role);
			const i = entries.findIndex((e) => String(e.id) === String(params.entry_id));
			if (i < 0) throw new Error(`entry ${params.entry_id} not found`);
			const k = params.context_entries ?? 2;
			const text = entries
				.slice(Math.max(0, i - k), i + k + 1)
				.map((e) => `--- ${e.message.role} (#${e.id}) ---\n${entryText(e).slice(0, 4000)}`)
				.join("\n");
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerCommand("sessions", {
		description: "Search past conversations: /sessions <query> ('all: <query>' searches every project)",
		handler: async (args: string, ctx: any) => {
			let query = (args || "").trim();
			let scope = "project";
			if (query.startsWith("all:")) {
				scope = "all";
				query = query.slice(4).trim();
			}
			if (!query) {
				ctx.ui.notify("Usage: /sessions <query>  (or /sessions all: <query>)", "warning");
				return;
			}
			const res = search(query, scope, process.cwd(), "any", 10);
			if (!res.length) {
				ctx.ui.notify(`No matches for: ${query}`, "info");
				return;
			}
			const lines = res.map((h) => `[${h.when}] ${h.role} · ${h.session.slice(0, 34)}\n   …${h.snippet}…`);
			ctx.ui.notify(`${res.length} matches:\n${lines.join("\n")}`, "info");
		},
	});

	// --- Session-ops: per-pane continuation breadcrumb ---------------------

	// Record THIS pane's active session whenever a session starts, and on a
	// resume surface a cwd-mismatch (re-root vs fork) if the recorded cwd differs.
	pi.on("session_start", async (event: any, ctx: any) => {
		try {
			const sm = ctx?.sessionManager;
			const file = sm?.getSessionFile?.();
			const cwd = sm?.getCwd?.() ?? process.cwd();
			if (!file) return;

			if (event?.reason === "resume" || event?.reason === "fork") {
				const prev = loadBreadcrumbs()[paneKey()];
				if (prev?.cwd && prev.cwd !== cwd) {
					ctx?.ui?.notify(
						`cwd mismatch on resume: this session ran in ${prev.cwd}, you are now in ${cwd}. ` +
							`Re-root (work here) or fork (branch a copy) as appropriate.`,
						"warning",
					);
				}
			}
			saveBreadcrumb({ session: file, cwd, when: new Date().toISOString() });
		} catch {}
	});

	// Keep the breadcrumb's "when" fresh so the newest-active pane pointer wins.
	pi.on("turn_end", async (_event: any, ctx: any) => {
		try {
			const sm = ctx?.sessionManager;
			const file = sm?.getSessionFile?.();
			if (!file) return;
			saveBreadcrumb({ session: file, cwd: sm?.getCwd?.() ?? process.cwd(), when: new Date().toISOString() });
		} catch {}
	});

	pi.registerCommand("continue", {
		description: "Show this pane's last session (continue where you left off), with cwd-mismatch check",
		handler: async (_args: string, ctx: any) => {
			const crumb = loadBreadcrumbs()[paneKey()];
			if (!crumb) {
				ctx.ui.notify("No prior session recorded for this pane yet.", "info");
				return;
			}
			const cwd = ctx?.sessionManager?.getCwd?.() ?? process.cwd();
			const slice = existsSync(crumb.session) ? boundedSlice(crumb.session) : { head: [], tail: [], total: 0 };
			const preview = [...slice.head, ...slice.tail]
				.map((e) => `  ${e.message.role}: ${entryText(e).replace(/\s+/g, " ").slice(0, 120)}`)
				.join("\n");
			const mismatch =
				crumb.cwd && crumb.cwd !== cwd
					? `\n⚠ cwd mismatch: recorded ${crumb.cwd}, current ${cwd} — re-root or fork.`
					: "";
			ctx.ui.notify(
				`Last session (this pane): ${basename(crumb.session)}\n` +
					`  when: ${crumb.when}  ·  cwd: ${crumb.cwd}  ·  ${slice.total} entries${mismatch}\n` +
					(preview ? `--- preview (bounded prefix+tail) ---\n${preview}` : ""),
				"info",
			);
		},
	});

	pi.registerTool({
		name: "session_last",
		label: "last session",
		description:
			"Return this terminal pane's most recent prior session (for 'continue where I left off'): its file, " +
			"cwd, timestamp, a bounded prefix+tail transcript preview, and a cwd-mismatch flag. Keyed by TTY/pane " +
			"so concurrent panes each resolve to their own last session.",
		promptSnippet: "session_last() — this pane's last session (continue-where-left-off) with cwd-mismatch flag",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const crumb = loadBreadcrumbs()[paneKey()];
			if (!crumb) return { content: [{ type: "text", text: "No prior session recorded for this pane." }] };
			const cwd = process.cwd();
			const slice = existsSync(crumb.session) ? boundedSlice(crumb.session) : { head: [], tail: [], total: 0 };
			const preview = [...slice.head, ...slice.tail]
				.map((e) => `${e.message.role}: ${entryText(e).replace(/\s+/g, " ").slice(0, 200)}`)
				.join("\n");
			const mismatch = crumb.cwd && crumb.cwd !== cwd;
			return {
				content: [
					{
						type: "text",
						text:
							`session: ${crumb.session}\ncwd: ${crumb.cwd}\nwhen: ${crumb.when}\nentries: ${slice.total}\n` +
							`cwd_mismatch: ${mismatch ? `YES (now in ${cwd}) — re-root vs fork` : "no"}\n\n` +
							`--- preview (bounded prefix+tail) ---\n${preview}`,
					},
				],
			};
		},
	});
}
