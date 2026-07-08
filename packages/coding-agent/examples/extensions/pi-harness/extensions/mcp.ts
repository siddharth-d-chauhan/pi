/**
 * mcp.ts — our own MCP adapter: mount any MCP server from .mcp.json into pi,
 * with discover-on-demand proxying, native gate integration, and in-pi config.
 *
 * Built ourselves (not adopting pi-mcp-adapter) for the same reasons the rest of
 * this harness is hand-built: it generalizes the proven knowledge.ts bridge,
 * stays a small owned extension (no 1.8MB black box), and — the decisive reason —
 * lets gates.ts SEE which tool is being called so mutating MCP tools (Jira create,
 * transition, …) flow through draft→confirm. A generic third-party proxy hides
 * the real tool name inside its own call, defeating the gate.
 *
 * Design (mirrors knowledge.ts, generalized):
 *  - Reads server specs from .mcp.json / .pi/mcp.json / ~/.pi/agent/mcp.json.
 *    The `knowledge` server is EXCLUDED — it keeps its dedicated first-class bridge.
 *  - Per server: ONE discover-on-demand proxy tool `<server>_mcp` (~low tokens).
 *    {list:true} → catalog; {tool, arguments} → call; mutating tools need
 *    {confirm:true}, which gates.ts gates on.
 *  - Lazy connect: servers connect on first use, idle-disconnect after a timeout.
 *  - Output guard: results capped so a chatty MCP tool can't flood context
 *    (composes with context-economy / tool-distill downstream anyway).
 *  - In-pi config: /mcp list · /mcp add · /mcp remove — writes .mcp.json.
 *
 * Mutation heuristic: MCP has no formal read/write flag, so we classify by name
 * (create/update/delete/add/remove/set/write/transition/… → mutating). Configurable
 * per server via a `readOnly`/`writeTools` hint in the spec; when unsure, gate it.
 *
 * Config: KP_MCP_ENABLED=0 disable · KP_MCP_IDLE_MS idle disconnect (default 10m) ·
 * KP_MCP_RECONNECT=0 disable spawn-retry + reconnect-on-closed-pipe resilience.
 *
 * Reconnect resilience: transport onClose clears the cached connection but KEEPS the
 * cached catalog; connect() retries spawn with backoff before giving up; a callTool that
 * fails on a closed transport (EPIPE / "pipe closed" / "Connection closed") reconnects
 * and retries ONCE. This closes the idle-timer-vs-callTool race.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const ENABLED = process.env.KP_MCP_ENABLED !== "0";
const IDLE_MS = Number(process.env.KP_MCP_IDLE_MS || 600_000);
const RECONNECT = process.env.KP_MCP_RECONNECT !== "0";
const RECONNECT_BACKOFF = [500, 1_000, 2_000, 4_000]; // spawn retry delays
const CALL_TIMEOUT = Number(process.env.KP_PI_TIMEOUT_MS ?? 300_000);
const MAX_RESULT_CHARS = 50_000;

// Mutation classifier: tool names implying state change → gated.
const MUTATING =
	/(^|_)(create|update|delete|add|remove|set|write|edit|put|post|patch|transition|move|assign|close|merge|delete|purge|drop|insert|upsert|rename|archive|restore|revoke|grant|send|publish|comment|worklog)(_|$)/i;

type ServerSpec = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	type?: string;
	readOnly?: boolean;
	writeTools?: string[];
};

// Config sources, later overrides earlier. knowledge is excluded (own bridge).
function configPaths(cwd: string): string[] {
	return [
		join(homedir(), ".config", "mcp", "mcp.json"),
		join(homedir(), ".pi", "agent", "mcp.json"),
		join(cwd, ".mcp.json"),
		join(cwd, ".pi", "mcp.json"),
	];
}

function loadServers(cwd: string): Record<string, ServerSpec> {
	const servers: Record<string, ServerSpec> = {};
	for (const p of configPaths(cwd)) {
		try {
			const cfg = JSON.parse(readFileSync(p, "utf-8"));
			for (const [name, spec] of Object.entries(cfg.mcpServers ?? {}))
				if (name !== "knowledge") servers[name] = spec as ServerSpec; // knowledge = dedicated bridge
		} catch {}
	}
	return servers;
}

// The writable project config target for /mcp add|remove.
function writeConfigPath(cwd: string): string {
	const proj = join(cwd, ".mcp.json");
	return proj;
}

function isMutating(spec: ServerSpec, toolName: string): boolean {
	if (spec.writeTools?.length) return spec.writeTools.includes(toolName);
	if (spec.readOnly) return false;
	return MUTATING.test(toolName);
}

function truncate(text: string): string {
	return text.length > MAX_RESULT_CHARS
		? `${text.slice(0, MAX_RESULT_CHARS)}\n… [MCP result truncated at ${MAX_RESULT_CHARS} chars]`
		: text;
}

export default function (pi: any) {
	if (!ENABLED) return;

	// Per-server lazy connection with idle disconnect.
	const conns = new Map<string, { client: Client; timer?: NodeJS.Timeout }>();

	async function connect(name: string, spec: ServerSpec): Promise<Client | null> {
		const existing = conns.get(name);
		if (existing) {
			touch(name);
			return existing.client;
		}
		if (!spec.command) return null;
		// Spawn with backoff; a flaky/racing transport gets a few attempts before we give up.
		const attempts = RECONNECT ? RECONNECT_BACKOFF : RECONNECT_BACKOFF.slice(0, 1);
		for (let i = 0; i < attempts.length; i++) {
			try {
				const cwd = spec.cwd ? resolve(REPO_ROOT, spec.cwd) : process.cwd();
				const transport = new StdioClientTransport({
					command: spec.command,
					args: spec.args ?? [],
					cwd,
					env: Object.fromEntries(
						Object.entries({ ...process.env, ...(spec.env ?? {}) }).filter(
							(e): e is [string, string] => e[1] !== undefined,
						),
					),
				});
				const client = new Client({ name: "pi-mcp", version: "0.1.0" });
				// onClose clears the cached connection (idle close, crash, EPIPE) but the catalog
				// Map is left intact, so {list:true} and mutation-checks survive a dropped conn.
				// Entry-scoped: only evict if THIS client is still the cached one (a newer
				// reconnect may have already replaced it).
				transport.onclose = () => {
					const c = conns.get(name);
					if (c?.client === client) {
						if (c.timer) clearTimeout(c.timer);
						conns.delete(name);
					}
				};
				await client.connect(transport);
				conns.set(name, { client });
				touch(name);
				return client;
			} catch {
				if (i < attempts.length - 1) await sleep(attempts[i]);
			}
		}
		return null;
	}
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// A callTool that fails because the transport closed under it (idle timer, crash) gets
	// ONE reconnect-and-retry. Anything else — including a second closed-pipe — propagates.
	function isTransportClosed(err: any): boolean {
		const m = String(err?.message ?? err ?? "");
		return /EPIPE|pipe closed|Connection closed|write after end|not connected/i.test(m);
	}
	async function callWithReconnect(
		name: string,
		spec: ServerSpec,
		client: Client,
		req: { name: string; arguments: any },
		opts: { signal: AbortSignal; timeout: number },
	): Promise<any> {
		try {
			return await client.callTool(req, undefined, opts);
		} catch (err) {
			if (!RECONNECT || !isTransportClosed(err)) throw err;
			conns.delete(name);
			const fresh = await connect(name, spec);
			if (!fresh) throw err;
			touch(name);
			return await fresh.callTool(req, undefined, opts);
		}
	}
	function touch(name: string) {
		const c = conns.get(name);
		if (!c) return;
		if (c.timer) clearTimeout(c.timer);
		c.timer = setTimeout(() => {
			c.client.close().catch(() => {});
			conns.delete(name);
		}, IDLE_MS);
	}

	// Cache tool catalogs so {list:true} and mutation-checks don't need a live conn.
	const catalogs = new Map<string, { piName: string; name: string; desc: string; mutating: boolean }[]>();
	async function catalog(
		name: string,
		spec: ServerSpec,
	): Promise<typeof catalogs extends Map<any, infer V> ? V : never> {
		if (catalogs.has(name)) return catalogs.get(name)!;
		const client = await connect(name, spec);
		if (!client) return [];
		let tools: any[] = [];
		try {
			({ tools } = await client.listTools());
		} catch {
			return [];
		}
		const rows = tools.map((t) => ({
			piName: t.name.replace(/\./g, "_"),
			name: t.name,
			desc: (t.description ?? "").split("\n")[0].slice(0, 100),
			mutating: isMutating(spec, t.name),
		}));
		catalogs.set(name, rows);
		return rows;
	}

	function registerServer(name: string, spec: ServerSpec) {
		const proxyName = `${name.replace(/[^a-zA-Z0-9_]/g, "_")}_mcp`;
		pi.registerTool({
			name: proxyName,
			label: `${name} mcp`,
			description:
				`Access the '${name}' MCP server. First call {list:true} for its tools, then ` +
				`{tool, arguments}. Mutating tools (create/update/delete/…) need {confirm:true} after user approval.`,
			parameters: {
				type: "object",
				properties: {
					list: { type: "boolean", description: "true → list this server's tools" },
					tool: { type: "string", description: "tool name (from list)" },
					arguments: { type: "object", description: "arguments for that tool" },
					confirm: { type: "boolean", description: "set true ONLY after the user approved a mutating call" },
				},
			},
			async execute(_id: string, params: any, signal: AbortSignal) {
				const rows = await catalog(name, spec);
				if (params?.list || !params?.tool) {
					const text = rows.length
						? rows.map((r) => `- ${r.piName}${r.mutating ? " (write)" : ""}: ${r.desc}`).join("\n")
						: `(${name}: no tools / server unreachable)`;
					return { content: [{ type: "text", text }] };
				}
				const row = rows.find((r) => r.piName === params.tool || r.name === params.tool);
				if (!row) throw new Error(`unknown tool '${params.tool}' — call ${proxyName} {list:true}`);
				const client = await connect(name, spec);
				if (!client) throw new Error(`${name}: server unreachable`);
				touch(name);
				const result = await callWithReconnect(
					name,
					spec,
					client,
					{ name: row.name, arguments: params.arguments ?? {} },
					{ signal, timeout: CALL_TIMEOUT },
				);
				if (result.isError) {
					const msg = (result.content as any[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
					throw new Error(msg || `${row.name} failed`);
				}
				const text = truncate(
					(result.content as any[]).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n"),
				);
				return { content: [{ type: "text", text }] };
			},
		});
	}

	pi.on("session_start", async (_e: any, ctx: any) => {
		const servers = loadServers(process.cwd());
		const names = Object.keys(servers);
		for (const name of names) registerServer(name, servers[name]);
		if (names.length)
			ctx?.ui?.notify?.(`MCP: ${names.length} server(s) mounted (discover-on-demand): ${names.join(", ")}`, "info");
	});

	// In-pi config: list / add / remove.
	// Force-drop a live connection (so the next use reconnects fresh). Returns whether one was open.
	async function disconnect(name: string): Promise<boolean> {
		const c = conns.get(name);
		if (!c) return false;
		if (c.timer) clearTimeout(c.timer);
		await c.client.close().catch(() => {});
		conns.delete(name);
		return true;
	}

	const USAGE =
		"MCP:\n" +
		"  /mcp list                       — configured servers + live status\n" +
		"  /mcp status [name]              — connection health + tool count\n" +
		"  /mcp reconnect [name|--all]     — drop + reconnect (all if no name)\n" +
		"  /mcp add <name> <command> [args…] [--env K=V…]  — add a stdio server\n" +
		'  /mcp update <name> [--command c] [--args "…"] [--env K=V] [--rm-env K]\n' +
		"  /mcp enable|disable <name>      — mount/unmount without deleting config\n" +
		"  /mcp remove <name>              — delete from config\n" +
		"  /mcp tools <name>               — list a server's tools";

	pi.registerCommand("mcp", {
		description:
			"MCP servers — list · status · reconnect · add · update · enable/disable · remove · tools (full manager)",
		handler: async (args: string, ctx: any) => {
			const toks = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = toks[0] || "list";
			const name = toks[1];
			const rest = toks.slice(2);
			const cwd = process.cwd();
			const info = (m: string) => ctx.ui.notify(m, "info");
			const warn = (m: string) => ctx.ui.notify(m, "warning");
			// parse "--env K=V" pairs + other flags out of a token list
			const parseFlags = (tokens: string[]) => {
				const env: Record<string, string> = {};
				const rmEnv: string[] = [];
				const positional: string[] = [];
				let command: string | undefined;
				let argsStr: string | undefined;
				let disabled: boolean | undefined;
				for (let i = 0; i < tokens.length; i++) {
					const t = tokens[i];
					if (t === "--env" && tokens[i + 1]) {
						const [k, ...v] = tokens[++i].split("=");
						env[k] = v.join("=");
					} else if (t === "--rm-env" && tokens[i + 1]) {
						rmEnv.push(tokens[++i]);
					} else if (t === "--command" && tokens[i + 1]) {
						command = tokens[++i];
					} else if (t === "--args" && tokens[i + 1]) {
						argsStr = tokens[++i];
					} else positional.push(t);
				}
				return { env, rmEnv, command, argsStr, disabled, positional };
			};

			if (sub === "list") {
				const servers = loadServers(cwd);
				const names = Object.keys(servers);
				if (!names.length) {
					info("No MCP servers configured. /mcp add <name> <command> [args…]");
					return;
				}
				const lines = names.map((n) => {
					const live = conns.has(n) ? "● connected" : "○ idle";
					const dis = (servers[n] as any).disabled ? " (disabled)" : "";
					return `  ${live}  ${n}${dis} — ${servers[n].command ?? "?"} ${(servers[n].args ?? []).join(" ")}`;
				});
				info(`MCP servers:\n${lines.join("\n")}\n(knowledge uses its own dedicated bridge)`);
				return;
			}

			if (sub === "status") {
				const servers = loadServers(cwd);
				const targets = name ? [name] : Object.keys(servers);
				const out: string[] = [];
				for (const n of targets) {
					if (!servers[n]) {
						out.push(`  ${n}: not configured`);
						continue;
					}
					const connected = conns.has(n);
					let tools = "?";
					try {
						const cat = await catalog(n, servers[n]);
						tools = String(cat.length);
					} catch {
						tools = "unreachable";
					}
					out.push(`  ${connected ? "●" : "○"} ${n} — ${connected ? "connected" : "idle"}, ${tools} tools`);
				}
				info(`MCP status:\n${out.join("\n")}`);
				return;
			}

			if (sub === "reconnect") {
				const servers = loadServers(cwd);
				const all = name === "--all" || !name;
				const targets = all ? Object.keys(servers) : [name];
				let n = 0;
				for (const t of targets) {
					if (!servers[t]) {
						warn(`'${t}' not configured.`);
						continue;
					}
					await disconnect(t);
					catalogs.delete(t);
					const c = await connect(t, servers[t]); // eager reconnect + refresh catalog
					if (c) {
						try {
							await catalog(t, servers[t]);
						} catch {}
						n++;
					}
				}
				info(`Reconnected ${n} server${n === 1 ? "" : "s"}${all ? " (all)" : ""}.`);
				return;
			}

			if (sub === "add") {
				const { env, positional } = parseFlags(rest);
				if (!name || !positional.length) {
					warn("Usage: /mcp add <name> <command> [args…] [--env K=V…]");
					return;
				}
				const path = writeConfigPath(cwd);
				let cfg: any = {};
				try {
					cfg = JSON.parse(readFileSync(path, "utf-8"));
				} catch {}
				cfg.mcpServers ??= {};
				const spec: any = { type: "stdio", command: positional[0], args: positional.slice(1) };
				if (Object.keys(env).length) spec.env = env;
				cfg.mcpServers[name] = spec;
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
				catalogs.delete(name);
				await disconnect(name);
				registerServer(name, spec);
				info(
					`Added '${name}' → ${path}. Mounted now.${Object.keys(env).length ? " env set." : " Set any secrets via --env or edit the config."}`,
				);
				return;
			}

			if (sub === "update") {
				if (!name) {
					warn('Usage: /mcp update <name> [--command c] [--args "a b"] [--env K=V] [--rm-env K]');
					return;
				}
				const path = writeConfigPath(cwd);
				let cfg: any = {};
				try {
					cfg = JSON.parse(readFileSync(path, "utf-8"));
				} catch {}
				if (!cfg.mcpServers?.[name]) {
					warn(`'${name}' not in ${path}.`);
					return;
				}
				const { env, rmEnv, command, argsStr } = parseFlags(rest);
				const spec = cfg.mcpServers[name];
				if (command) spec.command = command;
				if (argsStr !== undefined) spec.args = argsStr.split(/\s+/).filter(Boolean);
				if (Object.keys(env).length) {
					spec.env = { ...(spec.env || {}), ...env };
				}
				for (const k of rmEnv) {
					if (spec.env) delete spec.env[k];
				}
				writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
				catalogs.delete(name);
				await disconnect(name);
				registerServer(name, spec);
				info(`Updated '${name}' → ${path}. Reconnected with new config.`);
				return;
			}

			if (sub === "enable" || sub === "disable") {
				if (!name) {
					warn(`Usage: /mcp ${sub} <name>`);
					return;
				}
				const path = writeConfigPath(cwd);
				let cfg: any = {};
				try {
					cfg = JSON.parse(readFileSync(path, "utf-8"));
				} catch {}
				if (!cfg.mcpServers?.[name]) {
					warn(`'${name}' not in ${path}.`);
					return;
				}
				cfg.mcpServers[name].disabled = sub === "disable";
				writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
				if (sub === "disable") {
					await disconnect(name);
					catalogs.delete(name);
				} else registerServer(name, cfg.mcpServers[name]);
				info(`'${name}' ${sub}d.`);
				return;
			}

			if (sub === "remove") {
				if (!name) {
					warn("Usage: /mcp remove <name>");
					return;
				}
				const path = writeConfigPath(cwd);
				try {
					const cfg = JSON.parse(readFileSync(path, "utf-8"));
					if (cfg.mcpServers?.[name]) {
						delete cfg.mcpServers[name];
						writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
						await disconnect(name);
						catalogs.delete(name);
						info(`Removed '${name}' from ${path} (unmounted).`);
					} else warn(`'${name}' not in ${path}.`);
				} catch {
					warn(`No ${path} to edit.`);
				}
				return;
			}

			if (sub === "tools") {
				const servers = loadServers(cwd);
				if (!name || !servers[name]) {
					warn("Usage: /mcp tools <name>");
					return;
				}
				try {
					const cat = await catalog(name, servers[name]);
					info(
						`${name} tools (${cat.length}):\n` +
							cat.map((t) => `  ${t.piName}${t.mutating ? " ✎" : ""} — ${t.desc || ""}`.trimEnd()).join("\n"),
					);
				} catch (e: any) {
					warn(`Couldn't list ${name}: ${e?.message || e}`);
				}
				return;
			}

			info(USAGE);
		},
	});

	pi.on("session_shutdown", async () => {
		for (const { client, timer } of conns.values()) {
			if (timer) clearTimeout(timer);
			await client.close().catch(() => {});
		}
		conns.clear();
	});
}
