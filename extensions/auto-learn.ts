/**
 * Auto-Learn Extension — makes pi accumulate durable knowledge across
 * sessions, so boot packets get more useful every day.
 *
 * Three capture paths, all landing in the knowledge platform through
 * pi.memory_writeback (which gates: rules/preferences pin to BOOT_ALWAYS
 * and appear in the very next session's boot):
 *
 *  1. `remember` tool — the model records a durable rule/preference/lesson/
 *     pitfall when it learns one (driven by a standing instruction injected
 *     below). Model-observed items are `proposed`; user-attributed items are
 *     authoritative.
 *  2. `/remember <text>` command — you state a rule directly; always
 *     authoritative, boot-eligible immediately.
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
	kind: Type.Union(
		KINDS.map((k) => Type.Literal(k)),
		{
			description:
				"rule/preference/convention/style = operating norm (boots always); " +
				"knowledge = a durable fact; lesson/pitfall = what worked/failed; decision/procedure = how",
		},
	),
	summary: Type.String({ description: "the durable fact, one sentence — imperative for rules" }),
	detail: Type.Optional(Type.String({ description: "optional supporting detail" })),
	from_user: Type.Optional(
		Type.Boolean({
			description: "true if the user explicitly stated this (authoritative); false if you inferred it",
		}),
	),
});

type RememberInput = Static<typeof rememberSchema>;

const DIRECTIVE_RE =
	/\b(from now on|always|never|remember (?:that|to)|don'?t ever|make sure (?:to|you)|going forward)\b/i;

function directiveBriefing(): string {
	return [
		"<auto-learn>",
		"You accumulate durable knowledge with the `remember` tool. Call it when:",
		"- the user states a standing preference or corrects your approach (kind: rule/preference, from_user: true),",
		"- you discover a reusable lesson or a pitfall while working (kind: lesson/pitfall, from_user: false),",
		"- a non-obvious decision is made worth keeping (kind: decision).",
		"Rules and preferences appear in every future session's boot context, so capture them once.",
		"Do NOT remember: transient task state, secrets, or anything the repo already records.",
		"</auto-learn>",
	].join("\n");
}

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
			const parsed = JSON.parse(text) as { decision?: string; memory_status?: { usable_for_boot?: boolean } };
			const boot = parsed.memory_status?.usable_for_boot ? " (in future boots)" : "";
			return `remembered as ${parsed.decision}${boot}`;
		} catch {
			return "recorded";
		}
	}

	function repoName(cwd: string): string {
		const parts = cwd.replace(/\/+$/, "").split("/");
		return parts[parts.length - 1] || "";
	}

	pi.registerTool({
		name: "remember",
		label: "remember",
		description:
			"Record a durable rule, preference, lesson, or pitfall to the knowledge platform. " +
			"Rules/preferences appear in every future session's boot context. " +
			"Use from_user: true only when the user explicitly stated it.",
		parameters: rememberSchema,
		async execute(_id: string, rawInput: RememberInput, _signal, _onUpdate, ctx) {
			const input = rawInput as RememberInput & { scope?: "global" | "repo" | "file"; file?: string };
			const evidence = input.from_user
				? { user_stated: ["explicit user directive"] }
				: { observed: ["inferred while working"] };
			const scopeArgs: Record<string, unknown> = {};
			if (input.scope === "repo") scopeArgs.repository = repoName(ctx?.cwd ?? process.cwd());
			else if (input.scope === "file" && input.file) scopeArgs.file = input.file;
			const text = await writeback({
				kind: input.kind,
				summary: input.summary,
				text: input.detail,
				evidence,
				...scopeArgs,
			});
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerCommand("remember", {
		description: "Record a durable rule for pi: /remember <the rule>",
		handler: async (args, ctx) => {
			const rule = (args ?? "").trim();
			if (!rule) {
				ctx.ui.notify("Usage: /remember <rule> — e.g. /remember never force-push shared branches", "error");
				return;
			}
			const kind =
				/\bprefer|like|use\b/i.test(rule) && !/\bnever|always|don'?t\b/i.test(rule) ? "preference" : "rule";
			const text = await writeback({
				kind,
				summary: rule,
				evidence: { user_stated: ["/remember command"] },
			});
			ctx.ui.notify(`${text} — "${rule}"`, "info");
		},
	});

	// Detect a durable directive in the user's message; nudge the model to
	// capture it via `remember` on this turn.
	pi.on("input", async (event) => {
		pendingDirective = DIRECTIVE_RE.test(event.text) ? event.text.slice(0, 200) : undefined;
	});

	pi.on("context", async (event) => {
		const messages = event?.messages;
		if (!Array.isArray(messages)) return;
		const blocks = [directiveBriefing()];
		if (pendingDirective) {
			blocks.push(
				`<auto-learn-nudge>The user's message looks like a standing directive. If it is one, ` +
					`call remember(kind: rule|preference, from_user: true) to capture it.</auto-learn-nudge>`,
			);
		}
		return {
			messages: [
				...messages,
				...blocks.map((text) => ({
					role: "user" as const,
					content: [{ type: "text" as const, text }],
					timestamp: Date.now(),
				})),
			],
		};
	});
}
