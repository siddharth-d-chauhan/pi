/**
 * harness-sdk.ts — the fork's harness_sdk, ported to pi: the Claude Agent SDK
 * as a PURE LLM transport on subscription auth.
 *
 * Architecture rule (fork commit 69e6911): the SDK subprocess gets no Claude
 * Code behavior — no tools, no skills, no settings, one turn. pi owns tools,
 * memory, and context. Because the SDK doesn't accept arbitrary tool schemas,
 * pi's tools ride a prompt-based protocol: schemas are described in the system
 * prompt and the model emits a fenced tool_call block, which this provider
 * parses back into native pi toolcall events. (Known weakness inherited from
 * the fork: small models sometimes botch the protocol — prefer frontier models
 * on this provider.)
 *
 * v1 trade-off: output is buffered, not live-streamed (protocol blocks must be
 * withheld from display text). Auth is whatever `claude` is logged in as;
 * CLAUDE_CONFIG_DIR selects a profile.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROVIDER = "harness-sdk";

// ---------------------------------------------------------------------------
// Slash templates: file-based .md slash commands from .pi/commands/*.md.
//
// A file `.pi/commands/fix.md` becomes the `/fix` command. Its body is expanded
// with quote-aware placeholders and delivered as the user's input (via the
// `input` hook → transform), so users author parameterized prompts without
// writing an extension. Placeholders:
//   $1, $2, …   positional args (quote-aware splitting: "a b" is one arg)
//   $@ / $ARGUMENTS   the full remaining argument string, verbatim
//   $$          a literal $
// A leading front-matter-ish "# description:" line (optional) is stripped from
// the delivered body but used for the command listing.
// ---------------------------------------------------------------------------

/** Quote-aware arg split: honors "double" and 'single' quotes, backslash-escapes. */
export function splitArgs(s: string): string[] {
	const args: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	let has = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < s.length) {
				cur += s[++i];
			} else if (ch === quote) {
				quote = null;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (ch === "\\" && i + 1 < s.length) {
			cur += s[++i];
			has = true;
		} else if (/\s/.test(ch)) {
			if (has) {
				args.push(cur);
				cur = "";
				has = false;
			}
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) args.push(cur);
	return args;
}

/** Expand $1/$2/$@/$ARGUMENTS/$$ in a template body from an argument string. */
export function expandTemplate(body: string, argString: string): string {
	const args = splitArgs(argString);
	const full = argString.trim();
	// Order matters: $$ first (escape), then multi-char names, then positional.
	return body
		.replace(/\$\$/g, "\uE000ESC\uE000")
		.replace(/\$ARGUMENTS\b/g, full)
		.replace(/\$@/g, full)
		.replace(/\$(\d+)/g, (_m, d) => args[Number(d) - 1] ?? "")
		.replace(/\uE000ESC\uE000/g, "$");
}

const TEMPLATE_DESC_RE = /^\s*(?:#\s*)?description:\s*(.+)$/im;

function readTemplate(file: string): { description: string; body: string } | null {
	try {
		let body = readFileSync(file, "utf-8");
		let description = "";
		const m = body.match(TEMPLATE_DESC_RE);
		if (m) {
			description = m[1].trim();
			body = body.replace(m[0], "").replace(/^\s*\n/, "");
		}
		return { description, body: body.trim() };
	} catch {
		return null;
	}
}

/** Register file-based slash-command templates from <cwd>/.pi/commands/*.md. */
function registerSlashTemplates(pi: any) {
	const cwd = process.cwd();
	const dir = join(cwd, ".pi", "commands");
	if (!existsSync(dir)) return;
	let files: string[];
	try {
		files = readdirSync(dir).filter((n) => n.endsWith(".md"));
	} catch {
		return;
	}
	// name → absolute path (recomputed each invocation so edits to the .md take effect live)
	const known = new Map<string, string>();
	for (const f of files) known.set(f.slice(0, -3), join(dir, f));
	if (!known.size) return;

	for (const [name, path] of known) {
		const t = readTemplate(path);
		pi.registerCommand(name, {
			description: (t?.description || `Template: .pi/commands/${name}.md`).slice(0, 200),
			handler: async (args: string, ctx: any) => {
				// On invocation, re-read (so authored edits apply without restart) and
				// expand; then deliver the expanded prompt as the user's message.
				const tpl = readTemplate(path);
				if (!tpl) {
					ctx.ui.notify(`Template ${name}.md not readable.`, "error");
					return;
				}
				const expanded = expandTemplate(tpl.body, args || "");
				if (typeof ctx.sendUserMessage === "function") {
					await ctx.sendUserMessage(expanded);
				} else {
					// Fallback: surface the expansion so the user can copy/act on it.
					ctx.ui.notify(expanded, "info");
				}
			},
		});
	}
}

const MODELS = [
	{ id: "claude-fable-5", name: "Fable 5 (subscription)", ctx: 1_000_000, out: 128_000 },
	{ id: "claude-opus-4-8", name: "Opus 4.8 (subscription)", ctx: 200_000, out: 64_000 },
	{ id: "claude-sonnet-5", name: "Sonnet 5 (subscription)", ctx: 200_000, out: 64_000 },
	{ id: "claude-haiku-4-5-20251001", name: "Haiku 4.5 (subscription)", ctx: 200_000, out: 64_000 },
].map((m) => ({
	id: m.id,
	name: m.name,
	api: PROVIDER,
	provider: PROVIDER,
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // subscription: no per-token cost
	contextWindow: m.ctx,
	maxTokens: m.out,
}));

const TOOL_PROTOCOL = `

## Tool calling protocol

You have NO built-in tools. The tools below are executed by the harness, not by you.
To call one, END your response with one fenced block per call, nothing after it:

\`\`\`tool_call
{"name": "<tool name>", "arguments": { ... }}
\`\`\`

Emit the block ONLY when you want a tool executed; its result arrives in the next message.
Available tools (JSON Schema):
`;

/**
 * Child env for the SDK subprocess. Fork lesson (tools-common/claude_cli.py):
 * strip auth-override env vars so the subprocess ALWAYS authenticates via the
 * `claude` login — a stale ANTHROPIC_API_KEY/OAUTH token in the parent shell
 * silently redirects billing to whatever account that token belongs to.
 * HARNESS_SDK_CONFIG_DIR still selects an alternate profile when set.
 */
function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const k of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_OAUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
	])
		delete env[k];
	if (process.env.HARNESS_SDK_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.HARNESS_SDK_CONFIG_DIR;
	// User decision 2026-07-04 (explicit, caveats acknowledged): mark the child as an
	// in-session Claude Code spawn so usage draws included subscription quota instead of
	// the "extra usage" bucket Anthropic bills standalone Agent SDK spawns to. This is a
	// billing-classification workaround; it may violate ToS and can break server-side.
	env.CLAUDECODE = "1";
	env.CLAUDE_CODE_ENTRYPOINT = "cli";
	return env;
}

/** Strip pi identifiers from the outbound system prompt (user request). */
function sanitizeSystemPrompt(s: string): string {
	return s.replace(/\bpi\b/gi, "this agent").replace(/\bpi-coding-agent\b/gi, "this agent");
}

/** On failure, capture the environment facts that decide which account/binary served the call. */
function logFailure(modelId: string, message: string) {
	try {
		const { appendFileSync, mkdirSync } = require("node:fs");
		const { execSync } = require("node:child_process");
		const { homedir } = require("node:os");
		const { join } = require("node:path");
		const dir = join(homedir(), ".pi", "agent", "pi-harness");
		mkdirSync(dir, { recursive: true });
		let claudePath = "?";
		try {
			claudePath = execSync("which claude", { encoding: "utf-8" }).trim();
		} catch {}
		const authVars =
			[
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_AUTH_TOKEN",
				"ANTHROPIC_OAUTH_TOKEN",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"ANTHROPIC_BASE_URL",
				"CLAUDE_CONFIG_DIR",
				"HARNESS_SDK_CONFIG_DIR",
			]
				.filter((k) => process.env[k])
				.join(",") || "none";
		const proxies =
			["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "NO_PROXY"]
				.filter((k) => process.env[k])
				.map((k) => `${k}=${process.env[k]}`)
				.join(",") || "none";
		appendFileSync(
			join(dir, "harness-sdk-debug.log"),
			`${new Date().toISOString()} model=${modelId} cwd=${process.cwd()} claude=${claudePath} authEnv=[${authVars}] proxy=[${proxies}] allEnvNames=[${Object.keys(process.env).sort().join(" ")}] error=${message.slice(0, 300)}\n`,
		);
	} catch {}
}

function serializeTools(tools: any[]): string {
	if (!tools?.length) return "";
	const specs = tools
		.map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))
		.join("\n");
	return TOOL_PROTOCOL + specs;
}

function serializeMessages(messages: any[]): string {
	const parts: string[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const text = (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n");
			parts.push(`[user]\n${text}`);
		} else if (m.role === "assistant") {
			for (const b of m.content ?? []) {
				if (b.type === "text") parts.push(`[assistant]\n${b.text}`);
				if (b.type === "toolCall")
					parts.push(`[assistant tool_call]\n${JSON.stringify({ name: b.name, arguments: b.arguments })}`);
			}
		} else if (m.role === "toolResult") {
			const text = (m.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("\n");
			parts.push(`[tool result for ${m.toolName ?? "tool"}]\n${text}`);
		}
	}
	parts.push("[assistant]");
	return parts.join("\n\n");
}

/** Extract the balanced {...} object starting at `start` (string-aware). */
function extractBalanced(s: string, start: number): string | null {
	let depth = 0,
		inStr = false,
		esc = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return s.slice(start, i + 1);
	}
	return null;
}

/**
 * Extract tool-call blocks; returns [proseText, calls]. Ported from the fork's
 * hardened parse_text_to_response (test_text_protocol_parse.py): models drift on
 * fencing and surround calls with garbage — accept ```tool_call fences,
 * <tool_call> XML, and bare {"tool_call": ...} objects; balanced-brace extract
 * (never greedy regex — a stray trailing "}" once swallowed a whole reply);
 * tolerate prose before and junk after; strip stray trailing braces.
 */
export function parseToolCalls(text: string): [string, { name: string; arguments: any }[]] {
	const calls: { name: string; arguments: any }[] = [];
	const blockRe = /```tool_call\s*\n?([\s\S]*?)```|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
	let prose = text.replace(blockRe, (whole, fenced, xml) => {
		const body = (fenced ?? xml ?? "").trim();
		const at = body.indexOf("{");
		const json = at >= 0 ? extractBalanced(body, at) : null;
		if (json) {
			try {
				const p = JSON.parse(json);
				const c = p.tool_call ?? p;
				if (c?.name) {
					calls.push({ name: c.name, arguments: c.arguments ?? {} });
					return "";
				}
			} catch {}
		}
		return whole; // unparseable block stays visible rather than vanishing
	});
	// Bare {"tool_call": ...} without fencing — the fork's exact observed failure shape.
	if (!calls.length) {
		const at = prose.lastIndexOf('{"tool_call"');
		if (at >= 0) {
			const json = extractBalanced(prose, at);
			if (json) {
				try {
					const c = JSON.parse(json).tool_call;
					if (c?.name) {
						calls.push({ name: c.name, arguments: c.arguments ?? {} });
						prose = prose.slice(0, at) + prose.slice(at + json.length);
					}
				} catch {}
			}
		}
	}
	if (calls.length) prose = prose.replace(/[\s}]+$/, ""); // stray trailing brace after a call
	return [prose.trim(), calls];
}

export default function (pi: any) {
	// File-based slash-command templates (.pi/commands/*.md). Best-effort; never
	// let a template-loading failure break the provider registration below.
	try {
		registerSlashTemplates(pi);
	} catch {}

	pi.registerProvider(PROVIDER, {
		name: "Claude subscription via Agent SDK (harness-sdk)",
		api: PROVIDER,
		baseUrl: "claude-agent-sdk://local", // required by pi's config validation; transport is the SDK subprocess
		apiKey: "subscription", // placeholder — auth lives in the SDK subprocess (claude login / CLAUDE_CONFIG_DIR)
		models: MODELS,
		streamSimple(model: any, context: any, options?: any) {
			const { createAssistantMessageEventStream } = require("@earendil-works/pi-ai");
			const stream = createAssistantMessageEventStream();

			(async () => {
				const output: any = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				let childStderr = "";
				try {
					stream.push({ type: "start", partial: output });

					const system = sanitizeSystemPrompt(context.systemPrompt ?? "") + serializeTools(context.tools ?? []);
					const prompt = serializeMessages(context.messages ?? []);

					// pi thinking level → SDK effort (pi: minimal|low|medium|high|xhigh; SDK: low..max).
					const EFFORT: Record<string, string> = {
						minimal: "low",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
					};
					const effort = options?.reasoning ? EFFORT[options.reasoning] : undefined;

					const q = query({
						prompt,
						options: {
							stderr: (data: string) => {
								childStderr = (childStderr + data).slice(-2000);
							},
							model: model.id,
							systemPrompt: system, // replaces Claude Code's prompt entirely
							tools: [], // pure LLM: remove ALL native tools (fork lesson:
							allowedTools: [], // allowedTools=[] alone leaves schemas shadowing the protocol)
							settingSources: [], // no user CLAUDE.md/settings/hooks leak
							maxTurns: 1,
							persistSession: false,
							env: buildChildEnv(),
							...(effort ? { effort } : { thinking: { type: "disabled" } }),
							abortController: options?.signal ? { signal: options.signal } : undefined,
						} as any,
					});

					let text = "";
					let thinking = "";
					for await (const msg of q as any) {
						if (options?.signal?.aborted) throw new Error("aborted");
						if (msg.type === "assistant") {
							for (const b of msg.message?.content ?? []) {
								if (b.type === "text") text += b.text;
								if (b.type === "thinking") thinking += b.thinking ?? "";
							}
						} else if (msg.type === "result") {
							const u = msg.usage ?? {};
							output.usage.input = u.input_tokens ?? 0;
							output.usage.output = u.output_tokens ?? 0;
							output.usage.cacheRead = u.cache_read_input_tokens ?? 0;
							output.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
							output.usage.totalTokens =
								output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
						}
					}

					const [prose, calls] = parseToolCalls(text);
					let idx = 0;
					if (thinking.trim()) {
						const block = { type: "thinking", thinking };
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: idx, partial: output });
						stream.push({ type: "thinking_delta", contentIndex: idx, delta: thinking, partial: output });
						stream.push({ type: "thinking_end", contentIndex: idx, content: thinking, partial: output });
						idx++;
					}
					if (prose.trim()) {
						const block = { type: "text", text: prose };
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: idx, partial: output });
						stream.push({ type: "text_delta", contentIndex: idx, delta: prose, partial: output });
						stream.push({ type: "text_end", contentIndex: idx, content: prose, partial: output });
						idx++;
					}
					for (const call of calls) {
						const toolCall = {
							type: "toolCall",
							id: `hsdk_${Date.now().toString(36)}_${idx}`,
							name: call.name,
							arguments: call.arguments,
						};
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: idx, toolCall, partial: output });
						idx++;
					}
					output.stopReason = calls.length ? "toolUse" : "stop";
					stream.push({ type: "done", reason: output.stopReason, message: output });
					stream.end();
				} catch (error: any) {
					output.stopReason = options?.signal?.aborted ? "aborted" : "error";
					output.errorMessage = error?.message ?? String(error);
					logFailure(model.id, `${output.errorMessage} ||| childStderr: ${childStderr.slice(-800)}`);
					stream.push({ type: "error", reason: output.stopReason, error: output });
					stream.end();
				}
			})();

			return stream;
		},
	});
}
