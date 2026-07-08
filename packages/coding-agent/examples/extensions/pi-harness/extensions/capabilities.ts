/**
 * capabilities.ts — deactivate cold-tail tools (reclaim prefix) + one map/enabler.
 *
 * Two goals in tension, resolved via pi.setActiveTools:
 *  - pi must KNOW the harness surface (or it won't use it) → the `capability` tool's
 *    description IS the compact harness map (~250 tok, one place).
 *  - small prefix → the rarely-used COLD tools are DEACTIVATED at session start
 *    (pi.setActiveTools removes them from the model's active set, so their schemas
 *    leave the prefix — ~1.8k tok reclaimed). When the model needs one, it calls
 *    capability({enable:"<tool>"}) and the tool is re-activated for use.
 *
 * Hot tools (delegate, debug, hread/hedit, knowledge_*, recall_memory, review_diff,
 * repo, ask_user) stay active — the model reaches for them fluently. Cold tools
 * (find_references, rename_symbol, resolve_role, check_file, a2a send/recv) are
 * enable-on-demand. (remember_note/reflect_memory/hedit_block/session_fetch are hot.)
 *
 * Real token reclaim (not just indirection): setActiveTools genuinely drops the
 * schemas from the request. The map costs ~250 tok; the cold schemas were ~1.8k.
 *
 * Config: KP_CAPS_ENABLED=0 disable (all tools stay active).
 */

const ENABLED = process.env.KP_CAPS_ENABLED !== "0";

const MAP = `# Harness capabilities

SCOPE: scope(task) — gather relevant files/symbols. Use it WHEN you need unfamiliar context; skip it for a small/known change or a direct question (don't add a retrieval turn the task doesn't need).
RETRIEVAL (when you need to find something you don't already know): knowledge_search/code_search/find_code/trace (cited facts+code); recall_memory; session_search — good before grep for a real search. Not needed for a direct question you can already answer or a change you can already make. CRAFT the query to intent ("how X implemented"→"X implementation classes/handlers"). Brain size: knowledge_doctor (true counts), NOT memory_by_kind (typed-only).
EDIT: hread→hedit (hash-anchored, cheap+safe); hedit_block (replace a whole {…} construct). Prefer over builtin edit.
DELEGATE: delegate (isolated sub-agents: run_agent/run_chain/orchestrate/create_chain). A2A: sub-agents coordinate via send_message/check_messages. SHARED CONTEXT: dlc_context() (what earlier stages already scoped/read/found — call first, skip rediscovery) + dlc_note(kind,key,text) (record a discovery for later stages).
DEBUG: debug (run a script under a debugger, or attach to a live JVM/Spring-Boot — breakpoint+inspect what a request carries; multi-repo).
REVIEW: review_diff (P0-P3 adversarial); verify_work (anti-reward-hacking: is it real-done or just green?); check_file (type-check); rename_symbol/find_references (semantic LSP).
MEMORY (7 typed kinds): user preferences/rules/style/conventions are AUTO-captured from their messages + relevant ones auto-surface (recurring→always-on digest). YOU record with remember_note: knowledge (any durable fact — codebase/domain/world, never decays), failure/decision (an EVENT — Episodic, decays by recency), procedure (how-to). recall_memory(query, type=episodic|procedural|semantic) — "hit this before?" (episodic), "solved this?" (procedural), standing choices (semantic). Also reflect_memory · /memory trend|reflect|digest|stale.
TODO: todo_write(items) — set a checklist for multi-step work; todo_check(item) — tick items off as you go. Use for ~3+ step tasks so progress stays legible.
MODEL: resolve_role (role→best model). REPO: repo (github/bitbucket PRs as paths). ASK: ask_user. RULES: /omfg (trigger-matched course-correction — memory owns always-on).
EVAL (opt-in KP_EVAL=1): eval(cells) — persistent Python (globals persist across calls). ADVISOR (opt-in KP_ADVISOR=1): a 2nd model reviews each turn, surfaces CONCERN/BLOCKER notes.
CONTEXT (when KP_CODEMAP_ENABLED=1): codemap_query (connected bundle for a task, budgeted — retrieve only what's relevant), codemap_feature (concept dossier), codemap_god (ranked skeleton), codemap_impact (blast radius), codemap_neighbors, codemap_path — structural "only-relevant" context from the real call graph.
AUTO (passive — these happen WITHOUT a tool call; rely on them):
• Output compression: test runs→failures-only, git status→summary, big source files→signatures w/ bodies collapsed (full at the cited temp path). /compress shows savings.
• Edit syntax-guard: an edit that would break syntax (py/js/ts/go/rust/java/c) is auto-reverted with the error — fix and retry.
• Auto-thinking: your reasoning budget is set per turn from the task (hard/design/debug→more, trivial→less); manual override backs it off (/autothink resume).
• Context management (LCM): long history is losslessly compacted so you don't run out of window; oversized tool results are externalized with recovery instructions. For a clean restart on a long/muddy session, /handoff writes a curated summary (goal/state/decisions/open-threads/next-step) to carry into a fresh session.
• Task profiles: a DELEGATED sub-agent is typed by its agent-KIND (reviewer/debugger/implementer/refactorer/explorer) — its tools, retrieval mode, and model are fixed at spawn from that name. Name the agent to shape it.
• Model routing (when on): @role or an agent-kind resolves to the best model by policy (planner→smart, worker→cheap). resolve_role to inspect; /roles to toggle.
• Rules: /omfg turns a mistake into a trigger-matched correction (glob-gated, fires on a pattern). Memory owns always-on standing facts; rules fire conditionally.
• Bash is hardened: pagers/prompts are disabled (git/npm won't hang waiting for input) — just run commands normally.
• Secrets are redacted from anything sent to the model (reversible tokens), and never persisted to the brain.
• Retrieval self-heals: a zero-result scope/codemap search on a stale index auto-reindexes once and retries before reporting "not found".
• MCP auto-reconnects if a server drops; the tool catalog survives the gap.

Less-common tools (find_references, rename_symbol, resolve_role, check_file, send_message, check_messages, a2a_agents) are enable-on-demand: call capability({enable:"<tool>"}) then use it.
WEB/BROWSER (cold by default — enable when you need to browse): web_search, fetch_content, get_search_content (web access) + chrome_* (browser automation). capability({enable:"web_search"}) etc.`;

// Cold tools — deactivated at start, enabled on demand. (Kept out of the hot set;
// each is still registered by its own extension, just not active in the prefix.)
const COLD = [
	"find_references",
	"rename_symbol",
	"resolve_role",
	"check_file",
	"send_message",
	"check_messages",
	"a2a_agents",
];

// Superseded BUILTINS — pi's `read`/`edit` (~970 tok of schema) are fully replaced
// by our hash-anchored hread/hedit (staleness-safe, and hedit is syntax-guarded by
// edit-lint). Deactivating them reclaims ~970 tok/turn AND forces the better tool.
// Re-enable with capability({enable:"read"|"edit"}) or KP_KEEP_BUILTINS=1.
const SUPERSEDED_BUILTINS = process.env.KP_KEEP_BUILTINS === "1" ? [] : ["read", "edit"];

// Heavy OPTIONAL npm tools — web/browser access (pi-web-access + pi-chrome). Live
// /context showed fetch_content/web_search as the two single heaviest tools (~1.2k
// combined), and pi-chrome adds many chrome_* browser-automation tools — all rarely
// needed in a normal coding session. Cold by default; enable when you actually
// browse: capability({enable:"web_search"}) etc., or KP_KEEP_WEB=1 to keep hot.
const WEB_TOOLS = process.env.KP_KEEP_WEB === "1" ? [] : ["web_search", "fetch_content", "get_search_content"];
const COLD_PREFIXES = process.env.KP_KEEP_WEB === "1" ? [] : ["chrome_", "browser_"]; // pi-chrome automation

export default function (pi: any) {
	if (!ENABLED) return;

	// Proactive awareness: a tool description is only read when the model considers
	// that tool, so passive behaviors get missed. Inject ONE concise line into the
	// system prompt (always read) so pi knows the harness surface exists + the key
	// AUTO behaviors it should rely on, and that capability({list:true}) has the full
	// map. Small + fixed → negligible cached-prefix cost (unlike the whole map).
	const AWARENESS =
		// Only what the tool schemas DON'T already say: the automatic behaviors (no
		// tool to surface them) + two workflow rules that aren't obvious from any one
		// tool. Per-tool guidance lives in each tool's own promptSnippet (already in
		// the prefix) — not repeated here. capability({list:true}) has the full map.
		`\n\n## This harness — behaviors your tools don't announce\n` +
		`AUTOMATIC (no call needed — rely on these): tool output is compressed before context (tests→failures-only, git status→summary, ` +
		`big source files→signatures with bodies collapsed); an edit that breaks syntax is auto-reverted with the error; your thinking ` +
		`budget is set per task; long context is losslessly compacted (LCM) so you won't run out of window; secrets are redacted from what's ` +
		`sent to you and bash pagers/prompts are disabled (commands won't hang). Past corrections are auto-captured and relevant ones auto-surface.\n` +
		`SCOPE FIDELITY (do ONLY what's asked): answer a QUESTION with an answer — never take action on a question. "can/does/should/is it possible to X?" wants a yes/no + explanation, NOT X built. Match the action to the ask: a small ask = a small change; don't expand "can you add a theme?" into 5 themes, or one fix into a refactor. If the obvious next step is bigger than what was requested, DESCRIBE it and ask before doing it. When genuinely unsure whether the user wants the thing done or just discussed, ask — one line — rather than build. ` +
		`TOKEN ECONOMY: within the asked scope, act directly (no needless ask/menu/preamble); no prose recaps of tool output; cite don't re-enumerate; don't re-run a tool already run. ` +
		`HABITS: for a task of ~3+ steps, set a checklist with todo_write and tick it with todo_check as you go. ` +
		`WHEN DELEGATING: name the sub-agent by KIND (reviewer/debugger/implementer/refactorer/explorer) — that fixes its tools+model. ` +
		`Stages share a discovery ledger (dlc_context/dlc_note): read it first, don't rediscover what an earlier stage found.\n` +
		`MORE TOOLS ON DEMAND: some tools are deactivated to keep the prompt lean but ARE available — if you need one you don't see, ` +
		`enable it with capability({enable:"<tool>"}) instead of saying you can't. Notably WEB SEARCH / browsing (web_search, ` +
		`fetch_content, chrome_*) is off by default: to search the web or fetch a URL, call capability({enable:"web_search"}) then use it. ` +
		`capability({list:true}) shows everything.`;
	// ── KV-CACHE INVARIANT for the system prompt (READ BEFORE ADDING ANYTHING) ──
	// The system prompt is the cached prefix. Handlers chain in LOAD ORDER
	// (each does `event.systemPrompt + POLICY`), so the prefix is:
	//   [pi base] [knowledge] [hashline] [delegate] [AWARENESS ← here] [plan-mode?]
	// The cache is valid up to the FIRST byte that differs from last turn. Therefore:
	//   1) A NEW prefix injection must be STABLE (a constant string — no dates,
	//      counters, per-turn/task data). A varying byte busts cache EVERY turn.
	//   2) It must APPEND at the END (load the new extension AFTER capabilities), so
	//      it never shifts an existing block and only its own tail can miss on warm.
	//   3) If the content is per-turn/volatile, DON'T put it in the system prompt —
	//      inject it into the CONVERSATION via the `context` hook (post-prefix,
	//      cache-safe), the way task-profile.ts does. See [[kv-cache-safe-context]].
	// AWARENESS is a constant → cache-stable. Keep it that way.
	pi.on("before_agent_start", async (event: any) => ({ systemPrompt: (event.systemPrompt ?? "") + AWARENESS }));

	// After startup, drop the cold tools, superseded builtins, and heavy web/browser
	// tools so their schemas leave the prefix (hread/hedit replace read/edit ~970 tok;
	// web/chrome ~1.2k+). A tool is cold if it's in the exact set OR matches a cold
	// prefix (pi-chrome's chrome_* family).
	const DROP = new Set([...COLD, ...SUPERSEDED_BUILTINS, ...WEB_TOOLS]);
	const isCold = (t: string) => DROP.has(t) || COLD_PREFIXES.some((p) => t.startsWith(p));
	pi.on("session_start", async () => {
		try {
			const active: string[] = pi.getActiveTools?.() ?? [];
			if (active.length) pi.setActiveTools?.(active.filter((t) => !isCold(t)));
		} catch {}
	});

	pi.registerTool({
		name: "capability",
		label: "capability",
		// The full MAP is returned by capability({list:true}) — it is NOT embedded in
		// this description (that would ride the cached prefix every turn, ~700 tok of
		// pure waste, since the map's purpose is discover-on-demand). Description stays
		// a short pointer; the map is pulled when the model actually wants it.
		description:
			"Discover + unlock the harness's less-common tools. capability({list:true}) returns the full capability map " +
			'(all tools grouped by purpose); capability({enable:"<tool>"}) activates a less-common tool so you can then ' +
			"call it. Common tools (delegate, debug, hread/hedit, knowledge_search, scope, verify_work, review_diff, repo, " +
			"ask_user) are already available directly.",
		promptSnippet: "capability(list:true → full map | enable:<tool>) — discover/unlock less-common harness tools",
		parameters: {
			type: "object",
			properties: {
				list: { type: "boolean", description: "true → the harness capability map" },
				enable: { type: "string", description: "a less-common tool to activate (then call it directly)" },
			},
		},
		async execute(_id: string, params: any) {
			if (params?.enable) {
				if (!isCold(params.enable))
					return {
						content: [
							{
								type: "text",
								text: `'${params.enable}' is already available (common tool) — call it directly, or capability({list:true}) for the map.`,
							},
						],
					};
				try {
					const active: string[] = pi.getActiveTools?.() ?? [];
					pi.setActiveTools?.([...new Set([...active, params.enable])]);
					return { content: [{ type: "text", text: `Enabled ${params.enable} — you can now call it directly.` }] };
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `couldn't enable ${params.enable}: ${e.message}` }],
						isError: true,
					};
				}
			}
			return { content: [{ type: "text", text: MAP }] };
		},
	});
}
