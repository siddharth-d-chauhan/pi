/**
 * codemap.ts — the repo's graph intel (god / impact / path / …) as agent tools.
 *
 * "Give only the relevant context" done structurally. contextual-code-rag's
 * `codemap` CLI already builds a real dependency graph (tree-sitter) over the
 * repo and exposes verbs that Aider's PageRank map and Agentless's localizer only
 * approximate — but they're stranded in the CLI. This surfaces ONLY the
 * context-optimization verbs (retrieve the right slice for a task; not reports /
 * ops) so the agent can pull the relevant context instead of groping:
 *
 *   codemap_query     — the connected context BUNDLE for a task, fit to a token
 *                        budget (dense+lexical+graph, reranked). The core
 *                        "retrieve only what's relevant" verb (Agentless-style).
 *   codemap_feature   — a concept dossier: the code implementing feature/idea X.
 *   codemap_god       — the ranked skeleton: most central / most-depended-upon
 *                        symbols (PageRank over the call graph). Cheap "what
 *                        matters here" primer.
 *   codemap_impact    — blast radius of a symbol: callers + routes/tables/tests.
 *                        "What breaks if I touch this" — scopes what to look at.
 *   codemap_neighbors — a symbol's typed neighbourhood (callers/callees/deps/tests).
 *   codemap_path      — the relationship path between two symbols (how A reaches B).
 *
 * (Deliberately NOT exposed: overview/wiki/tour/risk/layers/deadcode/lineage —
 * they're reports ABOUT the code, not task-context; and index/serve/embed/… are
 * ops. Kept off to hold the agent's tool surface to context-optimization only.)
 *
 * Shell-out (like review.ts → devbrain, debug.ts → debuggers): calls the codemap
 * console script. Deliberately OFF BY DEFAULT — codemap needs its own venv + a
 * built `.codemap` index (per BOOTSTRAP), which isn't present everywhere. Turn on
 * where it's set up: KP_CODEMAP_ENABLED=1 (+ KP_CODEMAP_BIN if not on PATH).
 *
 * This complements the knowledge-first path (knowledge_code_search/trace through
 * KP): the graph verbs (god/impact/path/neighbors) have no KP equivalent; query/
 * feature are the direct-CLI form for when you want a budgeted bundle without the
 * KP round-trip.
 *
 * Empty-result recheck (rank 25): a retrieval verb (query/feature/god/impact/…)
 * that comes back EMPTY on a possibly-stale index triggers ONE `codemap index`
 * refresh-then-retry before reporting "not found" — the INDEX_STALE recoverable-
 * error discipline. Gate: KP_CODEMAP_RECHECK=0 to disable.
 *
 * Config:
 *   KP_CODEMAP_ENABLED=1   turn on (default OFF)
 *   KP_CODEMAP_BIN         path to the codemap executable (default "codemap" on PATH)
 *   KP_CODEMAP_ROOT        repo root to analyze (default process.cwd())
 *   KP_CODEMAP_TIMEOUT_MS  per-call timeout (default 60s; first call may build state)
 *   KP_CODEMAP_RECHECK=0   disable the empty-result refresh-then-retry
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";

const ENABLED = process.env.KP_CODEMAP_ENABLED === "1"; // OFF by default
const BIN = process.env.KP_CODEMAP_BIN || "codemap";
const TIMEOUT = Number(process.env.KP_CODEMAP_TIMEOUT_MS || 60_000);
const RECHECK = process.env.KP_CODEMAP_RECHECK !== "0"; // empty-result refresh-then-retry
const root = () => process.env.KP_CODEMAP_ROOT || process.cwd();

// Verbs whose empty output means "index found nothing" (worth a refresh+retry),
// as opposed to god/path where empty is a legitimate answer.
const RETRIEVAL_VERBS = new Set(["query", "feature", "impact", "neighbors"]);

// Does codemap's output read as a real zero-result (not an error, not content)?
function isEmptyResult(r: { ok: boolean; out: string }): boolean {
	if (!r.ok) return false; // errors are handled/ surfaced separately, not "empty"
	const t = (r.out || "").trim();
	return !t || t === "(no output)" || /^(no results?|nothing found|0 results?|no matches?)\b/i.test(t);
}

function run(args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((res) => {
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(BIN, args, { cwd: root(), stdio: ["ignore", "pipe", "pipe"] });
		} catch (e: any) {
			return res({
				ok: false,
				out: `codemap failed to spawn (${e.message}). Is it installed + on PATH? Set KP_CODEMAP_BIN.`,
			});
		}
		let out = "",
			err = "";
		const timer = setTimeout(() => proc.kill(), TIMEOUT);
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", (d) => {
			err += d.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) return res({ ok: true, out: out.slice(-12000) || "(no output)" });
			// Surface the actionable failure — most often "no index; run codemap index".
			const msg = (err || out).slice(-1500);
			res({
				ok: false,
				out: `codemap ${args[0]} failed${/index|not found|register/i.test(msg) ? " (repo may need `codemap index <path>` first)" : ""}:\n${msg}`,
			});
		});
		proc.on("error", (e) => {
			clearTimeout(timer);
			res({ ok: false, out: `codemap error: ${e.message}` });
		});
	});
}

export default function (pi: any) {
	if (!ENABLED) return; // dormant until turned on where codemap is set up

	// Task-based retrieval: task-profile.ts emits the retrieval mode fitting the
	// current task (debug→debug/flow+state, understand→structured, else bundle).
	// codemap_query uses it as the default mode unless the caller overrides.
	let taskMode: string | null = null;
	try {
		pi.events?.on?.("task:profile", (p: any) => {
			taskMode = p?.codemapMode ?? null;
		});
	} catch {}

	const QUIET = process.env.KP_CODEMAP_QUIET === "1";
	const tool = (name: string, label: string, description: string, params: any, build: (p: any) => string[]) =>
		pi.registerTool({
			name,
			label,
			description,
			parameters: params,
			async execute(_id: string, p: any) {
				const argv = build(p ?? {});
				// Surface the operation in the UI — which verb, and (for query) the mode
				// in effect, so the task-driven retrieval choice is visible not silent.
				if (!QUIET) {
					const modeIdx = argv.indexOf("--mode");
					const modeStr =
						modeIdx >= 0 ? ` [mode: ${argv[modeIdx + 1]}${taskMode && !p?.mode ? " ← task" : ""}]` : "";
					try {
						pi.ui?.notify?.(`codemap ${argv[0]}${modeStr}…`, "info");
					} catch {}
				}
				let r = await run(argv);
				// Empty-result recheck: a retrieval verb that found nothing on a possibly-
				// stale index gets ONE `codemap index` refresh then a retry (INDEX_STALE).
				if (RECHECK && RETRIEVAL_VERBS.has(argv[0]) && isEmptyResult(r)) {
					if (!QUIET) {
						try {
							pi.ui?.notify?.(`codemap ${argv[0]} empty → refreshing index once…`, "info");
						} catch {}
					}
					const idx = await run(["index", root()]);
					if (idx.ok) {
						const retry = await run(argv);
						if (!isEmptyResult(retry)) r = retry;
						else
							r = {
								ok: true,
								out: `${retry.out.trim() || "(no results)"}\n(refreshed the index and retried — still nothing; treat as genuinely absent.)`,
							};
					} else {
						// freshness honesty (principle 3): the reindex failed, so an empty result may be
						// STALE, not genuinely absent — annotate rather than let the model trust it.
						r = {
							ok: true,
							out: `${r.out.trim() || "(no results)"}\n(⚠ index refresh FAILED — this empty result may be stale; run \`codemap index ${root()}\` manually before trusting "not found".)`,
						};
					}
				}
				return { content: [{ type: "text", text: r.out }], isError: !r.ok };
			},
		});

	tool(
		"codemap_query",
		"codemap query",
		"Retrieve the connected context BUNDLE for a task — the right slice of the codebase (relevant symbols + their " +
			"surrounding code + flow), fit to a token budget, via dense+lexical+graph retrieval with reranking. The core " +
			"'give me only what's relevant to X' verb — prefer this over grepping when you need task context. query = a " +
			"natural-language description of what you're working on; budget = max tokens (default from config).",
		{
			type: "object",
			properties: {
				query: { type: "string", description: "what you're working on (natural language)" },
				budget: { type: "number", description: "max tokens for the bundle (optional)" },
				mode: {
					type: "string",
					description:
						"retrieval mode (default follows the task profile): bundle|structured|debug|dataflow|compact",
				},
			},
			required: ["query"],
		},
		(p) => {
			// caller mode > task-profile mode > compact default.
			const mode = p.mode || taskMode || "compact";
			const a = ["query", String(p.query), "--root", root(), "--mode", String(mode)];
			if (p.budget) a.push("--budget", String(p.budget));
			return a;
		},
	);

	tool(
		"codemap_feature",
		"codemap feature",
		"A concept dossier: the code that implements a feature or idea across the repo (the relevant files/symbols for " +
			"'X'). Use to gather everything touching a capability before you work on it. concept = the feature/idea; k = breadth.",
		{
			type: "object",
			properties: {
				concept: { type: "string", description: "the feature or concept" },
				k: { type: "number", description: "how many seeds (default 8)" },
			},
			required: ["concept"],
		},
		(p) => ["feature", String(p.concept), "--path", root(), "-k", String(p.k ?? 8)],
	);

	tool(
		"codemap_god",
		"codemap god",
		"The repo's ranked skeleton: the most central / most-depended-upon symbols (PageRank over the real call graph). " +
			"The cheap 'what is this codebase, what matters' primer — pull this before groping through files. k = how many.",
		{ type: "object", properties: { k: { type: "number", description: "how many top symbols (default 20)" } } },
		(p) => ["god", root(), "-k", String(p.k ?? 20)],
	);

	tool(
		"codemap_impact",
		"codemap impact",
		"Blast radius of a symbol: its callers plus the routes / tables / tests it reaches. Answers 'what breaks if I " +
			"change this' — run before editing a shared function. symbol = the function/class/method name.",
		{
			type: "object",
			properties: { symbol: { type: "string", description: "symbol to analyze" } },
			required: ["symbol"],
		},
		(p) => ["impact", String(p.symbol), "--path", root()],
	);

	tool(
		"codemap_path",
		"codemap path",
		"The relationship path between two symbols — how A reaches B through the call/dependency graph. Use to understand " +
			"how two parts of the code are connected. a, b = symbol names.",
		{ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
		(p) => ["path", String(p.a), String(p.b), "--path", root()],
	);

	tool(
		"codemap_neighbors",
		"codemap neighbors",
		"A symbol's typed neighbourhood: its callers, callees, dependencies, and tests. Tighter than impact — the " +
			"immediate graph around one symbol. symbol = the name.",
		{ type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
		(p) => ["neighbors", String(p.symbol), "--path", root()],
	);

	pi.registerCommand("codemap", {
		description:
			"Repo context intel: /codemap query <text>|feature <concept>|god|impact <sym>|path <a> <b>|neighbors <sym>",
		handler: async (args: string, ctx: any) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const verb = parts[0] || "god";
			const rest = parts.slice(1).join(" ");
			let argv: string[];
			switch (verb) {
				case "query":
					argv = ["query", rest, "--root", root(), "--mode", "compact"];
					break;
				case "feature":
					argv = ["feature", rest, "--path", root(), "-k", "8"];
					break;
				case "impact":
					argv = ["impact", parts[1] || "", "--path", root()];
					break;
				case "path":
					argv = ["path", parts[1] || "", parts[2] || "", "--path", root()];
					break;
				case "neighbors":
					argv = ["neighbors", parts[1] || "", "--path", root()];
					break;
				default:
					argv = ["god", root(), "-k", parts[1] || "20"];
			}
			ctx.ui.notify(`codemap ${verb}…`, "info");
			const r = await run(argv);
			ctx.ui.notify(r.out, r.ok ? "info" : "warning");
			return r.out;
		},
	});
}
