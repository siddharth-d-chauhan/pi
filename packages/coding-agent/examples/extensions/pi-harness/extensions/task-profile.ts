/**
 * task-profile.ts — task-typed context, where it actually pays: SUBAGENTS.
 *
 * The insight: a per-turn profile on the MAIN thread is the wrong place — the
 * main session is a generalist that swings debug→implement→understand turn to
 * turn, so re-classifying and re-shaping it every turn is churn. A SUBAGENT is
 * the opposite: spawned for ONE focused task of a KNOWN type, short-lived. That's
 * where a fixed profile is unambiguous and high-value.
 *
 * And the right mechanism makes KV-cache work FOR us instead of against us:
 *   A subagent's type is known at SPAWN (delegate sets KP_TASK_PROFILE). So we
 *   set its fixed tool set ONCE at session_start — BEFORE the first token — so the
 *   prefix is built correctly from t=0 and then NEVER changes. Every turn of that
 *   subagent reuses the SAME cached prefix. The agent carries only the tools its
 *   type needs, and because the set is fixed-at-spawn (not mutated per turn),
 *   there is zero cache churn. This is the correct inversion of the naive
 *   "setActiveTools per task" (which would rebuild the prefix every turn): fix it
 *   once, up front, per type — like capabilities.ts's one-shot cold-set, but
 *   type-specialized.
 *
 * Behavior by context:
 *   SUBAGENT (KP_TASK_PROFILE set):  at session_start, restrict the active tool
 *     set to this type's fixed set (base ∪ type tools), ONCE. Stable + cached for
 *     the subagent's life. Also emits task:profile so its codemap uses the right
 *     retrieval mode.
 *   MAIN THREAD (no KP_TASK_PROFILE): PASSIVE. No auto tool-shaping (it's a
 *     generalist; capabilities.ts's cold-set stays). Available on demand via
 *     /task <type> if you want to deliberately shape the main thread.
 *
 * Thinking stays owned by auto-thinking. Role→model is resolved by delegate from
 * the same type (see delegate.ts).
 *
 * Types: debug · refactor · understand · review · implement · trivial · general.
 *
 * Config: KP_TASKPROFILE_ENABLED=0 disable · KP_TASKPROFILE_QUIET=1 no UI notice.
 */

const ENABLED = process.env.KP_TASKPROFILE_ENABLED !== "0";
const QUIET = process.env.KP_TASKPROFILE_QUIET === "1";
// A subagent is identifiable by the profile env delegate sets at spawn.
const SUBAGENT_TYPE = process.env.KP_TASK_PROFILE || "";

// short glyph per type for a compact, scannable UI notice.
const GLYPH: Record<string, string> = {
	debug: "🐛",
	refactor: "♻️",
	understand: "🔍",
	review: "🔎",
	implement: "🔧",
	trivial: "·",
	general: "○",
};

type TaskType = "debug" | "refactor" | "understand" | "review" | "implement" | "trivial" | "general";

interface Profile {
	type: TaskType;
	// specialist tools for this type; a subagent's FIXED set = BASE_TOOLS ∪ these
	// (set once at spawn). Empty → keep the full set (trivial/general).
	tools: string[];
	// codemap retrieval mode hint (consumed via task:profile by codemap/others).
	codemapMode: "bundle" | "structured" | "debug" | "dataflow";
	// role hint for delegate/model-router.
	role: "planner" | "worker" | "scout" | "reviewer";
}

// Ordered strongest→weakest; first match wins. Kept regex-cheap (no LLM).
const RULES: Array<{ type: TaskType; re: RegExp }> = [
	{
		type: "debug",
		re: /\b(debug|stack ?trace|traceback|exception|failing test|test fails?|why (is|does|isn'?t|won'?t).*(break|fail|crash|throw|null|undefined)|root ?cause|reproduce|npe|segfault|panic|deadlock|race condition|not working|broken)\b/i,
	},
	{
		type: "review",
		re: /\b(review|audit|is this (correct|right|safe|ok)|code ?review|check (this|the|my)|find (bugs|issues|problems)|security (review|audit)|vet\b)\b/i,
	},
	{
		type: "refactor",
		re: /\b(refactor|rename|extract (a |the )?(method|function|variable|class)|move (this|the|it)|restructure|clean ?up|deduplicate|inline|pull up|rename (this|the|all))\b/i,
	},
	{
		type: "understand",
		re: /\b(how does|how do|explain|what (is|does|are)|where (is|are|does)|walk me through|trace (the|through)|understand|why (is|does) (it|this|the).*(work|structured|designed)|architecture|overview of|show me how)\b/i,
	},
	{
		type: "implement",
		re: /\b(implement|add (a |an |support )|build (a |an |the )|create (a |an |the )|write (a |an |the )|feature|new (endpoint|method|function|class|route|command)|wire up|hook up|integrate)\b/i,
	},
	{
		type: "trivial",
		re: /\b(typo|format|lint|indent|whitespace|spelling|bump (the )?version|add a comment|one-?liner)\b/i,
	},
];

// The tools that EVERY subagent keeps regardless of type (read/edit/ask/delegate
// primitives it can't work without). A type's set = BASE ∪ its specialist tools.
const BASE_TOOLS = ["hread", "hedit", "ask_user", "delegate", "knowledge_search"];

// Per type: the specialist tools that define this subagent's fixed set (set ONCE
// at spawn — a stable, cached prefix for the subagent's whole life), the codemap
// retrieval mode, and the role hint delegate uses to pick the model.
const PROFILES: Record<TaskType, Profile> = {
	debug: {
		type: "debug",
		tools: ["debug", "verify_work", "review_diff", "session_search", "sandbox_run"],
		codemapMode: "debug",
		role: "planner",
	},
	refactor: {
		type: "refactor",
		tools: ["rename_symbol", "find_references", "hedit_block", "check_file"],
		codemapMode: "structured",
		role: "worker",
	},
	understand: {
		type: "understand",
		tools: ["knowledge_code_search", "knowledge_trace", "knowledge_find_code", "recall_memory", "session_search"],
		codemapMode: "structured",
		role: "scout",
	},
	review: {
		type: "review",
		tools: ["review_diff", "verify_work", "check_file", "find_references"],
		codemapMode: "bundle",
		role: "reviewer",
	},
	implement: {
		type: "implement",
		tools: ["knowledge_code_search", "verify_work", "check_file", "hedit_block"],
		codemapMode: "bundle",
		role: "worker",
	},
	trivial: { type: "trivial", tools: [], codemapMode: "bundle", role: "worker" },
	general: { type: "general", tools: [], codemapMode: "bundle", role: "worker" },
};

// The full fixed tool set for a subagent of this type (base ∪ specialist),
// intersected with what actually exists so we never activate a phantom name.
function fixedToolSet(type: TaskType, existing: string[]): string[] {
	const want = new Set([...BASE_TOOLS, ...PROFILES[type].tools]);
	return existing.length ? [...want].filter((t) => existing.includes(t)) : [...want];
}

function _classify(text: string): TaskType {
	const t = (text || "").trim();
	if (!t) return "general";
	if (t.length < 60 && RULES.find((r) => r.type === "trivial")!.re.test(t)) return "trivial";
	for (const r of RULES) {
		if (r.type === "trivial") continue;
		if (r.re.test(t)) return r.type;
	}
	return "general";
}

export default function (pi: any) {
	if (!ENABLED) return;

	// ---- SUBAGENT PATH: fix the tool set ONCE at spawn (cache-stable) ----
	if (SUBAGENT_TYPE && SUBAGENT_TYPE in PROFILES) {
		const type = SUBAGENT_TYPE as TaskType;
		const profile = PROFILES[type];
		pi.on("session_start", async () => {
			try {
				// Emit the retrieval-mode/role signal (codemap in this child uses it).
				try {
					pi.events?.emit?.("task:profile", { type, codemapMode: profile.codemapMode, role: profile.role });
				} catch {}
				// Restrict to this type's FIXED set — once, before the first turn — so the
				// prefix is built for this type at t=0 and stays cached every turn after.
				// (No effect for trivial/general, which keep the full set.)
				if (profile.tools.length) {
					const all: string[] = pi.getAllTools?.()?.map((t: any) => t?.name ?? t) ?? [];
					const set = fixedToolSet(type, all);
					if (set.length) pi.setActiveTools?.(set);
				}
				if (!QUIET) {
					const g = GLYPH[type] ?? "";
					try {
						pi.ui?.notify?.(
							`${g} subagent type: ${type} — fixed tools [${profile.tools.join(", ") || "full set"}], retrieval ${profile.codemapMode} (cached prefix)`,
							"info",
						);
					} catch {}
				}
			} catch {}
		});
		// A typed subagent doesn't re-classify — its type is fixed for its life.
		return;
	}

	// ---- MAIN THREAD PATH: passive; on-demand via /task only ----
	// The main session is a generalist that swings task types turn to turn; we do
	// NOT auto-shape its tools (that's capabilities.ts's stable cold-set) or nudge
	// every turn. /task <type> lets you deliberately emit a profile signal (so
	// codemap follows a chosen retrieval mode) without touching the tool set.
	let forcedMode: TaskType | null = null;

	pi.registerCommand("task", {
		description:
			"Task profile (main thread is passive; subagents are typed at spawn). /task <debug|refactor|understand|review|implement> emits the retrieval/role signal for the next turns · /task off clears it",
		handler: async (args: string, ctx: any) => {
			const a = (args || "").trim().toLowerCase();
			if (!a) {
				ctx.ui.notify(
					`Task-profile: main thread is PASSIVE (generalist). Subagents are typed at spawn (fixed tools + cached prefix).\n` +
						(forcedMode
							? `Current main-thread signal: ${forcedMode} (codemap ${PROFILES[forcedMode].codemapMode}).`
							: `No main-thread signal set. Use /task <type> to emit one.`) +
						`\nTypes: ${Object.keys(PROFILES)
							.filter((t) => t !== "general")
							.join(", ")}.`,
					"info",
				);
				return;
			}
			if (a === "off") {
				forcedMode = null;
				try {
					pi.events?.emit?.("task:profile", { type: "general", codemapMode: "bundle", role: "worker" });
				} catch {}
				ctx.ui.notify("Main-thread task signal cleared.", "info");
				return;
			}
			if (a in PROFILES && a !== "general" && a !== "trivial") {
				forcedMode = a as TaskType;
				const p = PROFILES[forcedMode];
				try {
					pi.events?.emit?.("task:profile", { type: forcedMode, codemapMode: p.codemapMode, role: p.role });
				} catch {}
				const g = GLYPH[forcedMode] ?? "";
				ctx.ui.notify(
					`${g} main-thread signal: ${forcedMode} — codemap retrieval ${p.codemapMode}, role ${p.role}. (Tools unchanged — main thread stays a generalist.)`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`Use: /task <${Object.keys(PROFILES)
					.filter((t) => t !== "general" && t !== "trivial")
					.join("|")}> or /task off.`,
				"warning",
			);
		},
	});
}
