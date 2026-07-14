/**
 * Knowledge Extension (fork edition) — wires the Knowledge Platform brain
 * into pi over a long-lived MCP stdio client (`kp serve --mcp-stdio`).
 *
 * Read-only surface only:
 *   - CORE tools mount with full schemas (search, code search, packet,
 *     and the Pi Context Broker tools pi.context_task / pi.context_code /
 *     pi.context_shift)
 *   - the read-only long tail is reachable through the knowledge_call proxy
 *   - mutations are NOT mounted here (no gates in the fork — use the
 *     harness for writes)
 *
 * The KP checkout is located via PI_KP_DIR (default: the vault tools repo).
 * The MCP client is published on globalThis so context-broker.ts can reuse
 * the same server process for boot packets.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KP_DIR = process.env.PI_KP_DIR ?? "/home/siddharth/vault/tools/knowledge-platform";
const KP_CALL_TIMEOUT_MS = Number(process.env.PI_KP_TIMEOUT_MS ?? 30_000);
const KP_CONNECT_TIMEOUT_MS = Number(process.env.PI_KP_CONNECT_TIMEOUT_MS ?? 8_000);

/** Reject if `p` does not settle within `ms` — so a hung connect can't wedge a phase. */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/** Full-schema workhorses; everything else read-only goes behind knowledge_call.
 *  Token discipline: every mounted tool ships its description+schema in EVERY
 *  request, so only the genuinely hot, model-initiated tools mount directly —
 *  pi_semantic_expand (the default recall), knowledge_search (deep fallback),
 *  and the task/shift phase calls. Harness-driven phases (boot, before_action,
 *  debug, coverage, gate) are invoked by extensions through the shared client
 *  and need no model-facing mount; colder reads stay callable via the
 *  knowledge_call proxy, paying their schema cost only when actually used.
 *  Mutations and broker-maintenance operations are intentionally absent: model
 *  tool calls must not be able to alter memory state or trigger reconciliation. */
const CORE = new Set(["knowledge_search", "pi_context_task", "pi_context_shift", "pi_semantic_expand"]);

/** Code + flow query surface — promoted from the proxy to direct mounts so the
 *  model can (and, via the guideline below, is TOLD to) query codebase structure
 *  while coding instead of grepping blind. find_code / code_search / resolve_symbol
 *  answer "what exists / where"; trace / neighbors answer "how it flows / what
 *  connects"; pi_context_code is the broker's code packet. */
const CODE = new Set([
	"knowledge_find_code",
	"knowledge_code_search",
	"knowledge_resolve_symbol",
	"knowledge_trace",
	"knowledge_neighbors",
	"pi_context_code",
	// completeness: missing implementation / missing tests for a rule or symbol.
	"knowledge_gaps",
	"knowledge_coverage",
]);

/** The prompt fix: a single Guidelines directive (attached to the anchor code
 *  tool) that makes the model reach for these while coding. */
const CODE_GUIDELINE = [
	"Before writing or editing code, QUERY the codebase graph instead of guessing or grepping blind: " +
		"use kp find_code / code_search to locate existing implementations and utilities to REUSE, " +
		"kp resolve_symbol for a symbol's real definition and its callers, and kp trace / neighbors to " +
		"follow call and data FLOW and see what connects. Prefer reusing existing code over reinventing it, " +
		"and check the flow before changing shared code. When finishing, use kp gaps / coverage to check for " +
		"missing implementation or tests.",
];

// KP reads can return large graph/code payloads. The MODEL still gets the full
// (bounded) result, but the TUI must not dump it — over-wide/huge blocks break
// the layout. So we cap the content the model sees and render only a compact,
// width-safe "what it did" line in the UI.
const RESULT_CAP_CHARS = 12_000;

function blocksToText(content: unknown): string {
	return Array.isArray(content)
		? (content as Array<{ type?: string; text?: string }>)
				.map((b) => (b?.type === "text" ? (b.text ?? "") : ""))
				.join("\n")
		: "";
}

function capContent(content: unknown): unknown {
	const text = blocksToText(content);
	if (text.length <= RESULT_CAP_CHARS) return content;
	const head = Math.floor(RESULT_CAP_CHARS * 0.6);
	const body = `${text.slice(0, head)}\n…[${text.length - RESULT_CAP_CHARS} chars elided]…\n${text.slice(text.length - (RESULT_CAP_CHARS - head))}`;
	return [{ type: "text", text: body }];
}

/** A one-line, width-truncated display component (never breaks the layout). */
function compactLine(text: string): Component {
	return {
		render: (width: number) => [truncateToWidth(text, Math.max(1, width))],
		invalidate: () => {},
	};
}

/** pi-normalized names of the mountable KP surface (server uses dots). */
const READ_ONLY = new Set([
	...CORE,
	// Demoted from direct mounts to the proxy (token discipline, see CORE):
	"knowledge_code_search",
	"knowledge_packet",
	"pi_context_code",
	"pi_context_before_action",
	"pi_context_debug",
	"pi_context_pre_finish",
	"pi_semantic_search",
	"pi_knowledge_coverage",
	"pi_context_boot",
	"pi_context_spawn",
	"pi_pre_action_gate",
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
	"knowledge_memory_by_kind",
	"knowledge_session_brief",
	"knowledge_facts_by_source",
	"knowledge_episode_facts",
	"knowledge_document_text",
	"knowledge_fetch_blob",
	"knowledge_list_communities",
	"knowledge_search_communities",
	"knowledge_community_members",
	"knowledge_doctor",
]);

interface KpShared {
	connect: () => Promise<Client>;
	timeoutMs: number;
}

function loadServerSpec(): { command: string; args: string[]; env?: Record<string, string> } {
	const cfg = JSON.parse(readFileSync(join(KP_DIR, ".mcp.json"), "utf-8"));
	const spec = cfg.mcpServers?.knowledge;
	if (!spec) throw new Error(`no 'knowledge' server in ${KP_DIR}/.mcp.json`);
	return spec;
}

export default function (pi: ExtensionAPI) {
	let client: Client | undefined;
	let connecting: Promise<Client> | undefined;
	// Bumped whenever we intentionally drop the client (transport death or
	// shutdown) so a stale close can't evict a newer connection.
	let generation = 0;

	async function connect(): Promise<Client> {
		if (client) return client;
		// Coalesce concurrent first-connects onto a single transport.
		if (connecting) return connecting;
		const myGen = ++generation;
		connecting = (async () => {
			const spec = loadServerSpec();
			const transport = new StdioClientTransport({
				command: join(KP_DIR, spec.command),
				args: spec.args,
				cwd: KP_DIR,
				env: { ...process.env, ...spec.env } as Record<string, string>,
			});
			const c = new Client({ name: "pi-fork", version: "0.1.0" });
			// PI-07: a dead transport must not be cached forever — drop the client
			// on close/error so the next call reconnects. Generation-guarded so a
			// stale close can't evict a newer replacement.
			const drop = () => {
				if (generation === myGen) client = undefined;
			};
			c.onclose = drop;
			c.onerror = drop;
			// PI-06: bound the connect itself, not just per-request calls; close a
			// half-open transport if it wedges.
			try {
				await withDeadline(c.connect(transport), KP_CONNECT_TIMEOUT_MS, "kp connect");
			} catch (err) {
				try {
					await transport.close();
				} catch {
					// best-effort cleanup of the half-open transport
				}
				throw err;
			}
			client = c;
			return c;
		})();
		try {
			return await connecting;
		} finally {
			connecting = undefined;
		}
	}

	// Shared channel for context-broker.ts (and future consumers): one KP
	// process per pi session, whichever extension loads first.
	(globalThis as Record<string, unknown>).__pi_kp__ = {
		connect,
		timeoutMs: KP_CALL_TIMEOUT_MS,
	} satisfies KpShared;

	// PI-08: close the owned MCP process on shutdown/reload so it doesn't leak,
	// bumping the generation so a late transport close can't evict a replacement
	// created by a subsequent session.
	pi.on("session_shutdown", async () => {
		const c = client;
		client = undefined;
		connecting = undefined;
		generation++;
		try {
			await c?.close();
		} catch {
			// best-effort teardown
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		let tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
		try {
			const c = await connect();
			const listed = await c.listTools();
			tools = listed.tools as typeof tools;
		} catch (err) {
			// Brain down is degraded, not fatal — pi's builtins still work.
			ctx.ui?.notify?.(`knowledge brain unavailable: ${(err as Error).message}`, "warning");
			return;
		}

		let mounted = 0;
		const proxied: Array<{ piName: string; server: string; desc: string }> = [];
		for (const tool of tools) {
			const piName = tool.name.replace(/\./g, "_");
			if (!READ_ONLY.has(piName)) continue; // only the vetted read surface mounts
			if (!CORE.has(piName) && !CODE.has(piName)) {
				proxied.push({
					piName,
					server: tool.name,
					desc: (tool.description ?? "").split("\n")[0].slice(0, 90),
				});
				continue;
			}
			mounted++;
			// Token discipline: mount the first sentence only (≤220 chars) — the
			// server docstrings run long and ship in every request.
			const fullDesc = (tool.description ?? piName).trim();
			const firstSentence = fullDesc.split(/(?<=\.)\s/, 1)[0] ?? fullDesc;
			const isCode = CODE.has(piName);
			pi.registerTool({
				name: piName,
				label: piName.startsWith("pi_context")
					? piName.replace(/^pi_/, "ctx ")
					: piName.replace(/^knowledge_/, "kp "),
				description: firstSentence.length > 220 ? `${firstSentence.slice(0, 219)}…` : firstSentence,
				// Surface code/flow query in the model's tool list + tell it WHEN to
				// use them (the guideline rides once, on the anchor tool).
				promptSnippet: isCode
					? `${piName.replace(/^knowledge_/, "kp ").replace(/^pi_/, "ctx ")} — query code/flow before editing`
					: undefined,
				promptGuidelines: piName === "knowledge_find_code" ? CODE_GUIDELINE : undefined,
				parameters: tool.inputSchema as never,
				// Compact, width-safe display — show WHAT it did, not the payload.
				renderResult: (res: { content?: unknown }, _o: unknown, theme: { fg(n: string, s: string): string }) => {
					const text = blocksToText(res.content);
					const lines = text.split("\n").filter((l) => l.trim());
					const head = (lines[0] ?? "").replace(/\s+/g, " ").trim();
					const lbl = piName.replace(/^knowledge_/, "kp ").replace(/^pi_/, "ctx ");
					const summary = `${lbl} · ${lines.length} line${lines.length === 1 ? "" : "s"} · ${text.length} chars${head ? ` — ${head}` : ""}`;
					return compactLine(theme.fg("dim", summary));
				},
				async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal) {
					const c = await connect();
					const result = await c.callTool({ name: tool.name, arguments: params }, undefined, {
						signal,
						timeout: KP_CALL_TIMEOUT_MS,
					});
					if (result.isError) {
						const msg = (result.content as Array<{ type: string; text?: string }>)
							.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
							.join("\n");
						throw new Error(msg || `${tool.name} failed`);
					}
					return { content: capContent(result.content) as never, details: undefined };
				},
			});
		}

		if (proxied.length > 0) {
			const byPiName = new Map(proxied.map((p) => [p.piName, p.server]));
			pi.registerTool({
				name: "knowledge_call",
				label: "kp call",
				description:
					"Call a less-common read-only knowledge tool by name. Use {list:true} once to see the catalog, " +
					"then {tool, arguments}.",
				parameters: {
					type: "object",
					properties: {
						list: { type: "boolean", description: "return the tool catalog" },
						tool: { type: "string" },
						arguments: { type: "object" },
					},
				} as never,
				async execute(
					_id: string,
					params: { list?: boolean; tool?: string; arguments?: Record<string, unknown> },
					signal: AbortSignal,
				) {
					if (params?.list || !params?.tool) {
						const catalog = proxied.map((p) => `- ${p.piName}: ${p.desc}`).join("\n");
						return { content: [{ type: "text", text: catalog }] as never, details: undefined };
					}
					const server = byPiName.get(params.tool);
					if (!server) throw new Error(`unknown tool '${params.tool}' — call knowledge_call {list:true}`);
					const c = await connect();
					const result = await c.callTool({ name: server, arguments: params.arguments ?? {} }, undefined, {
						signal,
						timeout: KP_CALL_TIMEOUT_MS,
					});
					if (result.isError) {
						const msg = (result.content as Array<{ type: string; text?: string }>)
							.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
							.join("\n");
						throw new Error(msg || `${server} failed`);
					}
					return { content: result.content as never, details: undefined };
				},
			});
		}

		ctx.ui?.setStatus?.("knowledge", `kp ${mounted}+${proxied.length}`);
	});
}
