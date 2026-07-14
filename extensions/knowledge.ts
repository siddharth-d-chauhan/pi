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

/** Keep one phase-aware code tool hot. The overlapping generic code search
 * stays behind knowledge_call so agents do not query both surfaces for the
 * same evidence. */
const CODE = new Set(["pi_context_code"]);

/** The prompt fix: a single Guidelines directive (attached to the anchor code
 *  tool) that makes the model reach for these while coding. */
const CODE_GUIDELINE = [
	"Before writing or editing code, query ctx context_code ONCE with an exact registered repository name " +
		"to locate existing implementations and utilities to reuse. Do not retry it with invented repository aliases. For a symbol's callers, " +
		"flow, gaps, or coverage, use knowledge_call and describe the cold tool first if its arguments are unknown. " +
		"Prefer reusing existing code over reinventing it, and check the flow before changing shared code.",
];

export interface RegisteredCodeRepository {
	repository: string;
	root: string;
}

function insideRoot(cwd: string, root: string): boolean {
	const normalizedCwd = cwd.replace(/\/+$/, "");
	const normalizedRoot = root.replace(/\/+$/, "");
	return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`);
}

/** Resolve only against the authoritative KP registry; never pass invented names through. */
export function resolveRegisteredRepository(
	requested: string | undefined,
	query: string | undefined,
	cwd: string,
	repositories: RegisteredCodeRepository[],
): string | undefined {
	const requestedName = requested?.trim();
	if (requestedName) {
		const exact = repositories.find((repo) => repo.repository.toLowerCase() === requestedName.toLowerCase());
		if (exact) return exact.repository;
	}

	const queryText = query?.toLowerCase() ?? "";
	const queryMatches = repositories.filter(
		(repo) => queryText.includes(repo.repository.toLowerCase()) || queryText.includes(repo.root.toLowerCase()),
	);
	if (queryMatches.length === 1) return queryMatches[0].repository;

	if (requestedName) {
		const lowered = requestedName.toLowerCase();
		const aliasMatches = repositories.filter(
			(repo) => lowered.includes(repo.repository.toLowerCase()) || repo.repository.toLowerCase().includes(lowered),
		);
		if (aliasMatches.length === 1) return aliasMatches[0].repository;
		return undefined;
	}

	const cwdMatches = repositories.filter((repo) => insideRoot(cwd, repo.root));
	return cwdMatches.length === 1 ? cwdMatches[0].repository : undefined;
}

export function constrainRepositorySchema(schema: unknown, repositories: RegisteredCodeRepository[]): unknown {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	const source = schema as Record<string, unknown>;
	const properties =
		source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
			? (source.properties as Record<string, unknown>)
			: undefined;
	if (!properties?.repository || repositories.length === 0) return schema;
	const repository =
		typeof properties.repository === "object" && !Array.isArray(properties.repository)
			? (properties.repository as Record<string, unknown>)
			: {};
	return {
		...source,
		properties: {
			...properties,
			repository: {
				...repository,
				enum: repositories.map((repo) => repo.repository),
				description: "Exact registered repository name; choose one enum value and never invent an alias",
			},
		},
	};
}

const SCOPED_CONTEXT_TOOLS = new Set(["pi_context_task", "pi_context_shift", "pi_context_code"]);

/** Pi owns session location and project selection. Model-supplied values are
 * hints only: cwd is always the live session cwd and task/shift use KP's
 * configured project instead of allowing an invented empty partition. */
export function normalizeContextArguments(
	piName: string,
	params: Record<string, unknown>,
	cwd: string,
	repositories: RegisteredCodeRepository[],
): Record<string, unknown> {
	if (!SCOPED_CONTEXT_TOOLS.has(piName)) return params;
	const arguments_: Record<string, unknown> = piName === "pi_context_code" ? { ...params } : { ...params, cwd };
	if (piName === "pi_context_task" || piName === "pi_context_shift") delete arguments_.project;

	if (repositories.length === 0) return arguments_;
	const requested = typeof params.repository === "string" ? params.repository : undefined;
	const queryKey = piName === "pi_context_task" ? "text" : piName === "pi_context_shift" ? "new_request" : "query";
	const query = typeof params[queryKey] === "string" ? params[queryKey] : undefined;
	const repository = resolveRegisteredRepository(requested, query, cwd, repositories);
	if (!repository) {
		delete arguments_.repository;
		if (requested || piName === "pi_context_code") {
			throw new Error(
				`Unknown repository '${requested ?? ""}'. Use exactly one registered name: ${repositories.map((repo) => repo.repository).join(", ")}`,
			);
		}
		return arguments_;
	}
	arguments_.repository = repository;
	return arguments_;
}

/** Project is deployment configuration for Pi, not a model choice. */
export function constrainContextSchema(piName: string, schema: unknown): unknown {
	if ((piName !== "pi_context_task" && piName !== "pi_context_shift") || !schema || typeof schema !== "object") {
		return schema;
	}
	const source = schema as Record<string, unknown>;
	const properties =
		source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
			? { ...(source.properties as Record<string, unknown>) }
			: undefined;
	if (!properties) return schema;
	delete properties.project;
	const required = Array.isArray(source.required)
		? source.required.filter((name): name is string => typeof name === "string" && name !== "project")
		: source.required;
	return { ...source, properties, ...(required ? { required } : {}) };
}

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

export function summarizeKnowledgeResult(piName: string, content: unknown): string {
	const text = blocksToText(content);
	const lines = text.split("\n").filter((line) => line.trim());
	const lbl = piName.replace(/^knowledge_/, "kp ").replace(/^pi_/, "ctx ");
	try {
		const parsed = JSON.parse(text) as {
			found?: boolean;
			error?: { code?: string; message?: string };
			errors?: Array<{ code?: string; message?: string }>;
			scope?: { status?: string };
		};
		const error = parsed.error ?? parsed.errors?.[0];
		if (error) return `${lbl} · DEGRADED · ${error.code ?? "ERROR"}: ${error.message ?? "unknown failure"}`;
		if (parsed.found === false) return `${lbl} · DEGRADED · no usable result`;
		if (parsed.scope?.status && parsed.scope.status !== "resolved") {
			return `${lbl} · DEGRADED · scope ${parsed.scope.status}`;
		}
	} catch {
		// Non-JSON tools keep the compact generic summary.
	}
	const head = (lines[0] ?? "").replace(/\s+/g, " ").trim();
	return `${lbl} · ${lines.length} line${lines.length === 1 ? "" : "s"} · ${text.length} chars${head ? ` — ${head}` : ""}`;
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

		let repositories: RegisteredCodeRepository[] = [];
		try {
			const result = await (await connect()).callTool({ name: "knowledge.list_repos", arguments: {} }, undefined, {
				timeout: KP_CALL_TIMEOUT_MS,
			});
			const parsed = JSON.parse(blocksToText(result.content)) as { repos?: RegisteredCodeRepository[] };
			repositories = (parsed.repos ?? []).filter(
				(repo) => typeof repo.repository === "string" && typeof repo.root === "string",
			);
		} catch {
			// Registry enrichment is optional; exact validation remains fail-open.
		}

		let mounted = 0;
		const proxied: Array<{ piName: string; server: string; desc: string; inputSchema: unknown }> = [];
		for (const tool of tools) {
			const piName = tool.name.replace(/\./g, "_");
			if (!READ_ONLY.has(piName)) continue; // only the vetted read surface mounts
			if (!CORE.has(piName) && !CODE.has(piName)) {
				proxied.push({
					piName,
					server: tool.name,
					desc: (tool.description ?? "").split("\n")[0].slice(0, 90),
					inputSchema: tool.inputSchema,
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
				promptGuidelines: piName === "pi_context_code" ? CODE_GUIDELINE : undefined,
				parameters: constrainContextSchema(
					piName,
					constrainRepositorySchema(tool.inputSchema, repositories),
				) as never,
				// Compact, width-safe display — show WHAT it did, not the payload.
				renderResult: (res: { content?: unknown }, _o: unknown, theme: { fg(n: string, s: string): string }) => {
					const summary = summarizeKnowledgeResult(piName, res.content);
					return compactLine(theme.fg(summary.includes("DEGRADED") ? "error" : "dim", summary));
				},
				async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal) {
					const c = await connect();
					const arguments_ = normalizeContextArguments(piName, params, ctx.cwd, repositories);
					const result = await c.callTool({ name: tool.name, arguments: arguments_ }, undefined, {
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
			const byPiName = new Map(proxied.map((p) => [p.piName, p]));
			pi.registerTool({
				name: "knowledge_call",
				label: "kp call",
				description:
					"Call a cold read-only knowledge tool by name. Use {list:true} for names, {describe:tool} for its schema, then {tool, arguments}.",
				parameters: {
					type: "object",
					properties: {
						list: { type: "boolean", description: "return the tool catalog" },
						describe: { type: "string", description: "return one cold tool's input schema" },
						tool: { type: "string" },
						arguments: { type: "object" },
					},
				} as never,
				async execute(
					_id: string,
					params: { list?: boolean; describe?: string; tool?: string; arguments?: Record<string, unknown> },
					signal: AbortSignal,
				) {
					if (params?.list) {
						const catalog = proxied.map((p) => `- ${p.piName}: ${p.desc}`).join("\n");
						return { content: [{ type: "text", text: catalog }] as never, details: undefined };
					}
					if (params?.describe) {
						const described = byPiName.get(params.describe);
						if (!described)
							throw new Error(`unknown tool '${params.describe}' — call knowledge_call {list:true}`);
						return {
							content: [{ type: "text", text: JSON.stringify(described.inputSchema) }] as never,
							details: undefined,
						};
					}
					if (!params?.tool) throw new Error("provide list, describe, or tool");
					const selected = byPiName.get(params.tool);
					if (!selected) throw new Error(`unknown tool '${params.tool}' — call knowledge_call {list:true}`);
					const c = await connect();
					const result = await c.callTool(
						{ name: selected.server, arguments: params.arguments ?? {} },
						undefined,
						{
							signal,
							timeout: KP_CALL_TIMEOUT_MS,
						},
					);
					if (result.isError) {
						const msg = (result.content as Array<{ type: string; text?: string }>)
							.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
							.join("\n");
						throw new Error(msg || `${selected.server} failed`);
					}
					return { content: result.content as never, details: undefined };
				},
			});
		}

		ctx.ui?.setStatus?.("knowledge", `kp ${mounted}+${proxied.length}`);
	});
}
