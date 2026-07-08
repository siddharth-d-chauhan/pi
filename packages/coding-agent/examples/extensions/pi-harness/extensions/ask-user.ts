/**
 * ask-user.ts — let the agent ASK before it guesses.
 *
 * Adds an `ask_user` tool the model calls when it hits a genuinely ambiguous,
 * high-impact decision it can't resolve from the request/code/sensible defaults.
 * Presents a structured question (options / multi-select / freeform) via pi's
 * native UI. Inspired by pi-ask-user (MIT) and mirrors the host AskUserQuestion
 * capability — rebuilt on pi's real ui.select/input primitives, zero deps.
 *
 * Why it matters here: it closes a real gap in the harness. guardrails blocks bad
 * actions and gates draws draft→confirm on mutations, but nothing lets the agent
 * PROACTIVELY disambiguate. Asking before acting directly REDUCES the corrections
 * memory.ts otherwise has to capture — better to ask once than be corrected and
 * remember it.
 *
 * Discipline (prompt policy): ask only when the answer genuinely changes what you
 * do and can't be inferred — not for conventional defaults or facts you can verify
 * yourself. That's the same bar the harness holds itself to.
 *
 * Headless (RPC/print): no interactive UI, so ask_user returns a clear signal that
 * the model must proceed with a stated assumption instead of blocking.
 */

// One tight guideline — the tool's own description already covers WHEN to ask, so
// this only adds the sharp anti-over-asking rule (kept short to spare the prefix).
const GUIDELINES = [
	"Don't ask for choices with a conventional default or facts you can verify yourself (read the file/code) — pick the obvious option and proceed. Ask only for a genuine fork you can't resolve.",
];

export default function (pi: any) {
	pi.registerTool({
		name: "ask_user",
		label: "ask user",
		description:
			"Ask the user a structured question when a decision is genuinely theirs and you can't resolve it " +
			"from the request, code, or sensible defaults. Provide options for a choice, or omit them for a " +
			"freeform answer. Prefer this over guessing on high-impact/ambiguous decisions. Returns the user's " +
			"answer (or, headless, a signal to proceed with a stated assumption).",
		promptSnippet: "ask_user(question, options?) — ask the user to decide when it's genuinely their call",
		promptGuidelines: GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "the decision to put to the user" },
				context: { type: "string", description: "optional 1-2 line context / why it matters" },
				options: {
					type: "array",
					description: "choices; each 'label' or 'label — description'. Omit for freeform.",
					items: { type: "string" },
				},
				allow_multiple: { type: "boolean", description: "let the user pick several options" },
				allow_freeform: { type: "boolean", description: "offer an 'Other…' freeform entry alongside options" },
				timeout_ms: { type: "number", description: "auto-dismiss after this long (optional)" },
			},
			required: ["question"],
		},
		async execute(_id: string, params: any, signal: AbortSignal, _u: any, ctx: any) {
			const { question, context, options, allow_multiple, allow_freeform, timeout_ms } = params ?? {};
			const opts = { signal, ...(timeout_ms ? { timeout: timeout_ms } : {}) };

			// Headless: can't prompt. Tell the model to proceed on a stated assumption.
			if (!ctx?.hasUI || !ctx?.ui?.select) {
				return {
					content: [
						{
							type: "text",
							text:
								"[ask_user unavailable — no interactive UI in this mode] Proceed with the most reasonable " +
								"default for: " +
								question +
								". State the assumption you made so the user can correct it.",
						},
					],
				};
			}

			const title = context ? `${question}\n(${context})` : question;
			const choices: string[] = Array.isArray(options) ? options.filter((o: any) => typeof o === "string") : [];

			// Freeform (no options): single input.
			if (!choices.length) {
				const answer = await ctx.ui.input(title, "your answer", opts);
				return {
					content: [
						{
							type: "text",
							text: answer?.trim() ? `User answered: ${answer.trim()}` : "User dismissed without answering.",
						},
					],
				};
			}

			const FREEFORM = "Other… (type your own)";
			const DONE = "✓ Done selecting";

			// Multi-select: loop select, toggling picks, until Done.
			if (allow_multiple) {
				const picked = new Set<string>();
				for (;;) {
					const menu = [
						...choices.map((c) => (picked.has(c) ? `☑ ${c}` : `☐ ${c}`)),
						...(allow_freeform ? [FREEFORM] : []),
						DONE,
					];
					const sel = await ctx.ui.select(`${title}  [pick any, then Done]`, menu, opts);
					if (sel === undefined) break; // dismissed
					if (sel === DONE) break;
					if (sel === FREEFORM) {
						const extra = await ctx.ui.input("Type your answer", "", opts);
						if (extra?.trim()) picked.add(extra.trim());
						continue;
					}
					const bare = sel.replace(/^[☑☐]\s/, "");
					if (picked.has(bare)) picked.delete(bare);
					else picked.add(bare);
				}
				const chosen = [...picked];
				return {
					content: [
						{
							type: "text",
							text: chosen.length ? `User selected: ${chosen.join(", ")}` : "User selected nothing.",
						},
					],
				};
			}

			// Single choice (optionally with freeform escape).
			const menu = allow_freeform ? [...choices, FREEFORM] : choices;
			const sel = await ctx.ui.select(title, menu, opts);
			if (sel === undefined) return { content: [{ type: "text", text: "User dismissed without choosing." }] };
			if (sel === FREEFORM) {
				const extra = await ctx.ui.input("Type your answer", "", opts);
				return {
					content: [{ type: "text", text: extra?.trim() ? `User answered: ${extra.trim()}` : "User dismissed." }],
				};
			}
			return { content: [{ type: "text", text: `User chose: ${sel}` }] };
		},
	});
}
