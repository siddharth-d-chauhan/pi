/**
 * knowledge.ts — mounts the Knowledge Platform brain into pi as first-class tools.
 *
 * Bridges pi's registerTool to the KP MCP server (kp serve --mcp-stdio) over a
 * long-lived stdio client. Read-only tools are exposed by default; mutating
 * tools require KP_PI_ALLOW_WRITE=1 (gates: no silent brain mutations from a
 * coding session — see CLAUDE.md "Gates").
 *
 * Tool schemas come from the server's tools/list at session start, so this file
 * never drifts from the KP tool surface. pi validates parameters with TypeBox,
 * which accepts the plain JSON Schema objects MCP already provides.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Brain ops are slow on the CPU-embedder stack (fork measured 10-15s per warm
// fact-search; indexing runs minutes) — the MCP SDK's 60s default would kill them.
const KP_CALL_TIMEOUT_MS = Number(process.env.KP_PI_TIMEOUT_MS ?? 300_000);

// Core tools advertised in the system prompt's "Available tools" section.
// piName → one-line snippet. The long tail stays callable but unadvertised.
const PROMPT_SNIPPETS: Record<string, string> = {
	knowledge_search: "knowledge_search — cited facts (rules, decisions, docs)",
	knowledge_code_search: "knowledge_code_search — semantic code w/ flow+neighbors+coverage",
	knowledge_find_code: "knowledge_find_code — locate symbols across repos",
	knowledge_trace: "knowledge_trace — rule → code+tests",
	knowledge_packet:
		"knowledge_packet(question) — connected context bundle (anchor+code+tests+gaps), for planning/impact",
	knowledge_memory_by_kind:
		"knowledge_memory_by_kind(kind) — list all Preferences/Conventions/Rules/Style/Knowledge as a set",
	knowledge_session_brief: "knowledge_session_brief — compact project memory prewarm for this session",
};

// Terse imperatives, not prose — models act on these at a fraction of the tokens.
// Deliberately does NOT re-describe the knowledge_* tools (their schemas already
// do that); it only sets ORDERING and behavior the schemas can't convey.
// Retrieval-before-grep and context-economy live in capabilities.ts AWARENESS (one copy,
// permanent prefix). This block keeps ONLY the learning nudge, which nothing else carries.
const KNOWLEDGE_FIRST_POLICY = `

## Learning
- Record failures (what didn't work + why) via the gated brain tools — highest-value memories. After a reusable solution, offer to save a pi skill draft (never unasked).`;
// Monorepo root = pi-harness/.. ; .mcp.json there defines the knowledge server.
const REPO_ROOT = resolve(HERE, "..", "..");
const KP_CWD = join(REPO_ROOT, "knowledge-platform");

// Workhorse tools that earn a full schema in every request; the rest of the
// read-only surface is reachable through the knowledge_call proxy.
const CORE = new Set([
	"knowledge_search",
	"knowledge_code_search",
	"knowledge_find_code",
	"knowledge_trace",
	"knowledge_packet", // connected KnowledgePacket — high-value for plan/impact/debug

	// fetch_blob demoted to the knowledge_call proxy — it's recovery (fetch an
	// evicted span by hash), not a tool the model reaches for proactively; keeping
	// its ~150-token schema out of the hot prefix.
]);

// The read-only surface (proxy-eligible). Mutating tools mount individually so
// gates.ts sees their real names; KP_PI_READONLY=1 drops them entirely.
// Names are the pi-normalized form (server uses dots: knowledge.ask → knowledge_ask).
// knowledge_ask is deliberately absent — the caller IS the LLM; it synthesizes
// from knowledge_search results itself (fork ruling 8c1f9ad).
const READ_ONLY = new Set([
	"knowledge_search",
	"knowledge_code_search",
	"knowledge_find_code",
	"knowledge_trace",
	"knowledge_neighbors",
	"knowledge_resolve_symbol",
	"knowledge_resolve",
	"knowledge_coverage",
	"knowledge_gaps",
	"knowledge_timeline",
	"knowledge_list_repos",
	"knowledge_stale_claims",
	"knowledge_packet",
	"knowledge_memory_by_kind",
	"knowledge_session_brief",
	"knowledge_facts_by_source",
	"knowledge_episode_facts",
	"knowledge_document_text",
	"knowledge_fetch_blob",
	"knowledge_list_communities",
	"knowledge_search_communities",
	"knowledge_community_members",
	"knowledge_map_diff",
	"knowledge_doctor",
]);

function loadServerSpec() {
	// The knowledge server spec lives in knowledge-platform/.mcp.json; a root-level
	// .mcp.json (if one appears later) takes precedence.
	for (const dir of [REPO_ROOT, KP_CWD]) {
		// JSON.parse is inherently untyped; downstream consumers (StdioClientTransport env
		// spread) rely on the loose shape, so `any` is the faithful annotation here.
		let cfg: any;
		try {
			cfg = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
		} catch {
			continue;
		}
		const spec = cfg.mcpServers?.knowledge;
		if (spec) return spec;
	}
	throw new Error("no 'knowledge' server spec found in .mcp.json (repo root or knowledge-platform/)");
}

export default async function (pi: any) {
	let client: Client | null = null;
	let sessionBriefPrompt = "";

	async function connect(): Promise<Client> {
		if (client) return client;
		const spec = loadServerSpec();
		const transport = new StdioClientTransport({
			command: join(KP_CWD, spec.command), // relative .venv/bin/kp → absolute
			args: spec.args,
			cwd: KP_CWD,
			env: { ...process.env, ...spec.env },
		});
		const c = new Client({ name: "pi-harness", version: "0.1.0" });
		await c.connect(transport);
		client = c;
		return c;
	}

	function formatSessionBrief(payload: any): string {
		const items = Array.isArray(payload?.items)
			? payload.items.slice(0, Number(process.env.KP_SESSION_BRIEF_LIMIT ?? 24))
			: [];
		if (!items.length) return "";
		const lines = items.map((it: any) => {
			const kind = it.kind ? `[${it.kind}] ` : "";
			const scope = it.scope ? ` (${it.scope})` : "";
			return `- ${kind}${String(it.text ?? "").slice(0, 220)}${scope}`;
		});
		return `\n\n## Session memory brief (${payload.project ?? "default"})\n${lines.join("\n")}`;
	}

	async function prewarmSessionBrief(ctx: any, tools: any[]) {
		sessionBriefPrompt = "";
		if (process.env.KP_SESSION_BRIEF_ENABLED === "0") return;
		const hasBrief = tools.some((t: any) => t.name === "knowledge.session_brief");
		if (!hasBrief) return;
		try {
			const c = await connect();
			const result = await c.callTool(
				{
					name: "knowledge.session_brief",
					arguments: {
						project: process.env.KP_PROJECT,
						limit: Number(process.env.KP_SESSION_BRIEF_LIMIT ?? 24),
					},
				},
				undefined,
				{ timeout: Number(process.env.KP_SESSION_BRIEF_TIMEOUT_MS ?? 10_000) },
			);
			if (result.isError) return;
			const text = (result.content as any[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
			const payload = JSON.parse(text || "{}");
			sessionBriefPrompt = formatSessionBrief(payload);
			if (sessionBriefPrompt) ctx.ui?.notify?.(`knowledge session brief: ${payload.count ?? 0} facts`, "info");
		} catch {
			// Best-effort prewarm only; never block session startup.
			sessionBriefPrompt = "";
		}
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
		try {
			const c = await connect();
			({ tools } = await c.listTools());
			await prewarmSessionBrief(ctx, tools);
		} catch (err: any) {
			// Brain down is a degraded mode, not a fatal one — pi's builtins still work.
			ctx.ui?.notify?.(`knowledge brain unavailable: ${err.message}`, "warning");
			return;
		}

		// Full KP surface by default — mutation safety is gates.ts's job (draft→confirm
		// + secret scan), not an env-var speed bump. KP_PI_READONLY=1 opts out.
		const allowWrite = process.env.KP_PI_READONLY !== "1";
		const mountAll = process.env.KP_PI_MOUNT === "all";
		let mounted = 0;
		const proxied: { piName: string; server: string; desc: string }[] = [];
		const proxiedWrite: { piName: string; server: string; desc: string }[] = [];
		for (const tool of tools) {
			// LLM APIs forbid dots in tool names; normalize knowledge.ask → knowledge_ask.
			const piName = tool.name.replace(/\./g, "_");
			const isWrite = !READ_ONLY.has(piName);
			if (isWrite && !allowWrite) continue;
			// Context economy: only CORE tools get a full schema in every request. The
			// read-only long tail goes behind knowledge_call, mutations behind
			// knowledge_write (whose confirm param is what gates.ts gates on).
			if (!mountAll && !CORE.has(piName)) {
				const row = { piName, server: tool.name, desc: (tool.description ?? "").split("\n")[0].slice(0, 90) };
				(isWrite ? proxiedWrite : proxied).push(row);
				continue;
			}
			mounted++;
			pi.registerTool({
				name: piName,
				label: piName.replace(/^knowledge_/, "kp "),
				description: tool.description ?? piName,
				promptSnippet: PROMPT_SNIPPETS[piName],
				parameters: tool.inputSchema,
				async execute(_id: string, params: any, signal: AbortSignal) {
					// `confirm` is a gates.ts marker, not a KP parameter — strip before the server sees it.
					const { confirm: _confirm, ...args } = params ?? {};
					const c = await connect();
					const result = await c.callTool({ name: tool.name, arguments: args }, undefined, {
						signal,
						timeout: KP_CALL_TIMEOUT_MS,
					});
					if (result.isError) {
						const msg = (result.content as any[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
						throw new Error(msg || `${tool.name} failed`);
					}
					return { content: result.content };
				},
			});
		}

		if (proxied.length) {
			const catalog = proxied.map((p) => `- ${p.piName}: ${p.desc}`).join("\n");
			const byPiName = new Map(proxied.map((p) => [p.piName, p.server]));
			pi.registerTool({
				name: "knowledge_call",
				label: "kp call",
				// Discover-on-demand: the tool CATALOG is NOT in this description (it would
				// ride the cached prefix every turn). Call with {list:true} once to get the
				// ~16 less-common read tools, then call by name. Saves ~400 prefix tokens.
				description:
					"Access less-common read-only brain tools (neighbors, timeline, coverage, gaps, communities, etc.). First call {list:true} to see names, then {tool, arguments}.",
				promptSnippet:
					"knowledge_call(list:true → then tool,arguments) — less-common read-only brain tools (neighbors/timeline/coverage/gaps)",
				parameters: {
					type: "object",
					properties: {
						list: { type: "boolean", description: "true → return available tool names+descriptions" },
						tool: { type: "string", description: "tool name (from list)" },
						arguments: { type: "object", description: "arguments for that tool" },
					},
				},
				async execute(_id: string, params: any, signal: AbortSignal) {
					if (params?.list || !params?.tool) return { content: [{ type: "text", text: catalog }] };
					const server = byPiName.get(params.tool);
					if (!server)
						throw new Error(`unknown tool '${params.tool}' — call knowledge_call {list:true} for names`);
					const c = await connect();
					const result = await c.callTool({ name: server, arguments: params.arguments ?? {} }, undefined, {
						signal,
						timeout: KP_CALL_TIMEOUT_MS,
					});
					if (result.isError) {
						const msg = (result.content as any[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
						throw new Error(msg || `${params.tool} failed`);
					}
					return { content: result.content };
				},
			});
		}

		if (proxiedWrite.length) {
			const catalog = proxiedWrite.map((p) => `- ${p.piName}: ${p.desc}`).join("\n");
			const byPiName = new Map(proxiedWrite.map((p) => [p.piName, p.server]));
			pi.registerTool({
				name: "knowledge_write",
				label: "kp write",
				// Discover-on-demand (catalog out of prefix — saves ~440 tokens). Writes
				// are occasional in a coding session, so paying for the enumeration every
				// turn is pure waste. First {list:true}, then {tool, arguments, confirm}.
				description:
					"Mutate the brain (remember/correct facts, ingest, register/index repos, communities). Gated: draft → approval → confirm:true. First call {list:true} for tool names.",
				promptSnippet:
					"knowledge_write(list:true → then tool,arguments,confirm) — mutate the brain (gated draft→confirm)",
				parameters: {
					type: "object",
					properties: {
						list: { type: "boolean", description: "true → return available write-tool names" },
						tool: { type: "string", description: "tool name (from list)" },
						arguments: { type: "object", description: "arguments for that tool" },
						confirm: { type: "boolean", description: "set true ONLY after the user approved the draft" },
					},
				},
				async execute(_id: string, params: any, signal: AbortSignal) {
					if (params?.list || !params?.tool) return { content: [{ type: "text", text: catalog }] };
					const server = byPiName.get(params.tool);
					if (!server)
						throw new Error(`unknown tool '${params.tool}' — call knowledge_write {list:true} for names`);
					const c = await connect();
					const result = await c.callTool({ name: server, arguments: params.arguments ?? {} }, undefined, {
						signal,
						timeout: KP_CALL_TIMEOUT_MS,
					});
					if (result.isError) {
						const msg = (result.content as any[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
						throw new Error(msg || `${params.tool} failed`);
					}
					return { content: result.content };
				},
			});
		}

		ctx.ui?.notify?.(
			`knowledge brain: ${mounted} core + ${proxied.length} via knowledge_call + ${proxiedWrite.length} writes via knowledge_write (of ${tools.length})`,
			"info",
		);
	});

	// Knowledge-first reflex belongs in the system prompt, not a guidelines hack.
	pi.on("before_agent_start", async (event: any) => {
		if (!client) return; // brain never connected — don't advertise it
		return { systemPrompt: event.systemPrompt + KNOWLEDGE_FIRST_POLICY + sessionBriefPrompt };
	});

	// LIVE VISIBILITY: surface what the brain is being asked, AS the call fires (not after). So a
	// knowledge_search shows "🔎 licensing service" the moment it runs, instead of an opaque result
	// blob later. Fires on tool_call (before execution). Read-only — never blocks the call.
	pi.on("tool_call", async (event: any) => {
		const tool: string = event?.toolName || "";
		if (!/^knowledge_/.test(tool)) return;
		const inp = event?.input || {};
		const q = inp.query || inp.question || inp.name || inp.entity || inp.kind || inp.text || "";
		const limit = inp.limit ? ` (≤${inp.limit})` : "";
		const label = tool.replace(/^knowledge_/, "");
		pi.ctx?.ui?.notify?.(`🔎 ${label}${q ? `: ${String(q).slice(0, 80)}` : ""}${limit}`, "info");
	});

	pi.on("session_shutdown", async () => {
		await client?.close().catch(() => {});
		client = null;
	});
}
