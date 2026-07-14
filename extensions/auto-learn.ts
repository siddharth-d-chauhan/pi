/**
 * Auto-Learn Extension — makes pi accumulate durable knowledge across
 * sessions, so boot packets get more useful every day.
 *
 * Two capture paths are intentionally non-authoritative:
 *
 *  1. `remember` tool — the model records a durable rule/preference/lesson/
 *     pitfall when it learns one (driven by a standing instruction injected
 *     below). Every tool call is queued as a proposal for later human review.
 *  2. `/remember <text>` command queues the same proposal-only candidate; it
 *     must not infer authority from command text.
 *  3. Directive detection — when your message contains a durable directive
 *     ("always…", "never…", "from now on…", "remember…"), a nudge is
 *     appended so the model definitely captures it via `remember`.
 *
 * Everything is fail-open: no knowledge platform → the tool reports it,
 * pi is otherwise unaffected.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

interface KpShared {
	connect: () => Promise<{
		callTool: (
			req: { name: string; arguments: Record<string, unknown> },
			schema?: undefined,
			opts?: { timeout?: number },
		) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
	}>;
}

const WRITE_TIMEOUT_MS = 5_000;

const KINDS = [
	"rule",
	"preference",
	"convention",
	"style",
	"knowledge",
	"lesson",
	"pitfall",
	"decision",
	"procedure",
	"note",
] as const;

const rememberSchema = Type.Object({
	// Compact enum form (not Type.Union of literals) — this schema ships in
	// every request, and anyOf-of-const is ~4x the bytes of a plain enum.
	kind: Type.Unsafe<(typeof KINDS)[number]>({
		type: "string",
		enum: [...KINDS],
		description: "rule/preference boot always; convention/style task relevant; others are recallable facts",
	}),
	summary: Type.String({ description: "one sentence, imperative for rules" }),
	detail: Type.Optional(Type.String()),
	scope: Type.Optional(
		Type.Unsafe<"global" | "repo" | "file">({
			type: "string",
			enum: ["global", "repo", "file"],
			description: "default global",
		}),
	),
	file: Type.Optional(Type.String({ description: "path when scope=file" })),
});

type RememberInput = Static<typeof rememberSchema>;

const DIRECTIVE_RE =
	/\b(from now on|always|never|remember (?:that|to)|don'?t ever|make sure (?:to|you)|going forward)\b/i;

export default function (pi: ExtensionAPI) {
	let pendingDirective: string | undefined;

	async function writeback(args: Record<string, unknown>): Promise<string> {
		const shared = (globalThis as Record<string, unknown>).__pi_kp__ as KpShared | undefined;
		if (!shared) return "knowledge platform not available — nothing recorded";
		const client = await shared.connect();
		const result = await client.callTool({ name: "pi.memory_writeback", arguments: args }, undefined, {
			timeout: WRITE_TIMEOUT_MS,
		});
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		try {
			const parsed = JSON.parse(text) as {
				candidate?: unknown;
				decision?: string;
				error?: string;
				reason?: string;
				memory_status?: { usable_for_boot?: boolean };
			};
			if (result.isError || parsed.error || parsed.decision === "error" || parsed.decision === "rejected") {
				return `not recorded: ${parsed.error ?? parsed.reason ?? "knowledge platform rejected the proposal"}`;
			}
			if (parsed.candidate) return "proposal queued for human review";
			if (!parsed.decision) return "not recorded: invalid knowledge platform response";
			const boot = parsed.memory_status?.usable_for_boot ? " (in future boots)" : "";
			return `remembered as ${parsed.decision}${boot}`;
		} catch {
			return result.isError
				? "not recorded: knowledge platform error"
				: "not recorded: invalid knowledge platform response";
		}
	}

	function repoName(cwd: string): string {
		const parts = cwd.replace(/\/+$/, "").split("/");
		return parts[parts.length - 1] || "";
	}

	pi.registerTool({
		name: "remember",
		label: "remember",
		// The full when-to-call briefing lives HERE (tool schemas ride the cached
		// prompt prefix) instead of a per-turn context append, which is re-sent
		// uncached on every request.
		description:
			"Queue an untrusted proposal for a durable rule, preference, lesson, or pitfall. " +
			"A human must review it before it can affect future session context. " +
			"Call it when the user states a standing preference or corrects your approach (kind: rule/preference), " +
			"when you discover a reusable lesson or pitfall while working (kind: lesson/pitfall), " +
			"or when a non-obvious decision worth keeping is made (kind: decision). " +
			"Do NOT remember transient task state, secrets, or anything the repo already records.",
		parameters: rememberSchema,
		async execute(_id: string, rawInput: RememberInput, _signal, _onUpdate, ctx) {
			const input = rawInput as RememberInput & Record<string, unknown>;
			if ("from_user" in input || "evidence" in input || "inject_class" in input || "priority" in input) {
				throw new Error("remember only queues untrusted proposals; authority fields are not accepted");
			}
			const scopeArgs: Record<string, unknown> = {};
			if (input.scope === "repo") scopeArgs.repository = repoName(ctx?.cwd ?? process.cwd());
			else if (input.scope === "file" && input.file) scopeArgs.file = input.file;
			const text = await writeback({
				kind: input.kind,
				summary: input.summary,
				text: input.detail,
				// Omitting evidence is deliberate: KP stores this as proposed and does
				// not serve it until the trusted approval workflow promotes it.
				...scopeArgs,
			});
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerCommand("remember", {
		description: "Queue a durable memory proposal for human review: /remember <rule>",
		handler: async (args, ctx) => {
			const rule = (args ?? "").trim();
			if (!rule) {
				ctx.ui.notify("Usage: /remember <rule> — e.g. /remember never force-push shared branches", "error");
				return;
			}
			const kind =
				/\bprefer|like|use\b/i.test(rule) && !/\bnever|always|don'?t\b/i.test(rule) ? "preference" : "rule";
			const text = await writeback({ kind, summary: rule });
			ctx.ui.notify(`${text} — "${rule}"`, "info");
		},
	});

	// Detect a durable directive in the user's message; nudge the model to
	// capture it via `remember` on this turn.
	pi.on("input", async (event) => {
		pendingDirective = DIRECTIVE_RE.test(event.text) ? event.text.slice(0, 200) : undefined;
	});

	// The standing when-to-remember briefing lives in the tool description
	// (cached prefix). Only the transient directive nudge is injected, and only
	// on the turn where a directive was detected.
	pi.on("context", async (event) => {
		const messages = event?.messages;
		if (!Array.isArray(messages) || !pendingDirective) return;
		return {
			messages: [
				...messages,
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text:
								`<auto-learn-nudge>The user's message looks like a standing directive. If it is one, ` +
								`call remember(kind: rule|preference) to queue an untrusted proposal for later review.</auto-learn-nudge>`,
						},
					],
					timestamp: Date.now(),
				},
			],
		};
	});
}
