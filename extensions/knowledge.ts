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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KP_DIR = process.env.PI_KP_DIR ?? "/home/siddharth/vault/tools/knowledge-platform";
const KP_CALL_TIMEOUT_MS = Number(process.env.PI_KP_TIMEOUT_MS ?? 30_000);

/** Full-schema workhorses; everything else read-only goes behind knowledge_call. */
const CORE = new Set([
	"knowledge_search",
	"knowledge_code_search",
	"knowledge_packet",
	"pi_context_task",
	"pi_context_code",
]);

/** pi-normalized names of the read-only KP surface (server uses dots). */
const READ_ONLY = new Set([
	...CORE,
	"pi_context_boot",
	"pi_context_shift",
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

	async function connect(): Promise<Client> {
		if (client) return client;
		const spec = loadServerSpec();
		const transport = new StdioClientTransport({
			command: join(KP_DIR, spec.command),
			args: spec.args,
			cwd: KP_DIR,
			env: { ...process.env, ...spec.env } as Record<string, string>,
		});
		const c = new Client({ name: "pi-fork", version: "0.1.0" });
		await c.connect(transport);
		client = c;
		return c;
	}

	// Shared channel for context-broker.ts (and future consumers): one KP
	// process per pi session, whichever extension loads first.
	(globalThis as Record<string, unknown>).__pi_kp__ = {
		connect,
		timeoutMs: KP_CALL_TIMEOUT_MS,
	} satisfies KpShared;

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
			if (!READ_ONLY.has(piName)) continue; // fork mounts the read-only surface only
			if (!CORE.has(piName)) {
				proxied.push({
					piName,
					server: tool.name,
					desc: (tool.description ?? "").split("\n")[0].slice(0, 90),
				});
				continue;
			}
			mounted++;
			pi.registerTool({
				name: piName,
				label: piName.startsWith("pi_context")
					? piName.replace(/^pi_/, "ctx ")
					: piName.replace(/^knowledge_/, "kp "),
				description: tool.description ?? piName,
				parameters: tool.inputSchema as never,
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
					return { content: result.content as never, details: undefined };
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
