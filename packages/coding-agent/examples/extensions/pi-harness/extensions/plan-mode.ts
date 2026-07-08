/**
 * plan-mode.ts — read-only exploration until you approve the plan.
 *
 * The last universal workflow gap: Claude Code, opencode, and oh-my-pi all have a
 * plan mode; this adds ours. In plan mode the agent can read/search/analyze freely
 * but CANNOT mutate anything (edit/write/hedit, mutating bash, brain/MCP writes) —
 * it produces a plan, and only after you approve does execution begin.
 *
 * Enforcement is real (tool_call block), not prompt discipline — same seam as
 * guardrails.ts. State is per-session in memory.
 *
 * Flow:  /plan [task]     → enter plan mode (agent explores + proposes, no edits)
 *        /approve          → exit; edits allowed; the agent proceeds with the plan
 *        /approve chain    → exit AND turn the plan's steps into a runnable chain
 *                            (Gap B: plan → structured execution, not just prose)
 *        /plan-cancel       → exit without approving (discard)
 *
 * The plan → chain bridge: in plan mode the agent is asked to end its plan with a
 * machine-readable STEPS block (one `- <agent-kind>: <what>` per step). /approve
 * chain parses that block and emits a delegate chain the agent can run/orchestrate
 * — closing the plan→implement handoff deterministically instead of by re-reading
 * prose. Emits `plan:chain` on the bus so delegate persists it.
 *
 * Composes with everything: guardrails/gates still apply on top after approval.
 *
 * Config: KP_PLAN_ENABLED=0 disable.
 */

const ENABLED = process.env.KP_PLAN_ENABLED !== "0";

// Tools that mutate — blocked while planning. Reads/search/analyze pass through.
const MUTATING_TOOLS = /^(edit|write|hedit|multiedit|apply_patch|str_replace)$/;
const MUTATING_BASH = [
	/\b(rm|mv|cp|mkdir|rmdir|touch|tee|dd|truncate|chmod|chown)\b/,
	/\bgit\s+(commit|add|push|checkout|reset|rm|mv|apply|stash)\b/,
	/>>?\s*\S/, // shell redirection that writes a file
	/\b(npm|pnpm|yarn|pip|uv)\s+(install|add|remove|uninstall)\b/,
	/\bsed\s+-i\b/,
	/\bpatch\b/,
];

export default function (pi: any) {
	if (!ENABLED) return;

	let planning = false;
	let planTask = "";
	let lastPlanText = ""; // the agent's most recent message while planning (for → chain)

	// Capture the agent's plan text so /approve chain can parse its STEPS block.
	pi.on("message_end", async (event: any) => {
		if (!planning) return;
		try {
			const msg = event?.message;
			if (msg?.role === "assistant") {
				const t = (msg.content || [])
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("\n");
				if (t.trim()) lastPlanText = t;
			}
		} catch {}
	});

	// Parse the machine-readable STEPS block into chain stages. Accepts either
	// "### STEPS" / "STEPS:" fenced list of "- <kind>: <what>" lines, or falls back
	// to any "- <kind>: <what>" lines in the plan. kind → agent name; what → prompt.
	const KINDS =
		/^(reviewer|debugger|implementer|refactorer|explorer|worker|planner|scout|tester|code-reviewer|builder|fixer|researcher)$/i;
	function parsePlanSteps(text: string): Array<{ agent: string; prompt: string }> {
		const lines = text.split("\n");
		let inBlock = false;
		const steps: Array<{ agent: string; prompt: string }> = [];
		for (const raw of lines) {
			const l = raw.trim();
			if (/^#{0,3}\s*steps\b\s*:?\s*$/i.test(l)) {
				inBlock = true;
				continue;
			}
			if (inBlock && /^#{1,6}\s/.test(l)) break; // next heading ends the block
			const m = l.match(/^[-*]\s*([a-z][a-z-]*)\s*:\s*(.+)$/i);
			if (m && (inBlock || KINDS.test(m[1]))) steps.push({ agent: m[1].toLowerCase(), prompt: m[2].trim() });
		}
		return steps;
	}

	function isMutatingCall(toolName: string, input: any): boolean {
		if (MUTATING_TOOLS.test(toolName)) return true;
		if (/_mcp$/.test(toolName) && input?.tool && !input?.list) return true; // any MCP tool call in plan mode is suspect; block writes conservatively
		if (
			toolName.startsWith("knowledge_") &&
			!/(search|ask|find|trace|neighbors|resolve|coverage|gaps|timeline|list|code_search|fetch_blob|document_text|facts_by|episode|stale|communit|map_diff|doctor)/.test(
				toolName,
			)
		)
			return true;
		if (toolName === "knowledge_write") return true;
		if (toolName === "delegate" && /run_agent|run_chain|orchestrate/.test(input?.action ?? "")) return true; // sub-agents could edit
		if (toolName === "bash") {
			const cmd = String(input?.command ?? "");
			return MUTATING_BASH.some((re) => re.test(cmd));
		}
		return false;
	}

	pi.on("tool_call", async (event: any) => {
		if (!planning) return;
		const { toolName, input } = event;
		if (isMutatingCall(toolName, input)) {
			return {
				block: true,
				reason:
					`PLAN MODE: mutations are blocked (attempted ${toolName}). Finish exploring and present your PLAN ` +
					`(what you'll change, files, steps, risks). The user runs /approve to allow execution, then retry.`,
			};
		}
	});

	pi.on("before_agent_start", async (event: any) => {
		if (!planning) return;
		return {
			systemPrompt:
				(event.systemPrompt ?? "") +
				`\n\n## PLAN MODE ACTIVE\nYou are in read-only plan mode${planTask ? ` for: ${planTask}` : ""}. Explore (read/search/analyze) ` +
				`but do NOT edit, write, run mutating commands, or delegate work — those are blocked. Produce a concrete PLAN ` +
				`(files to change, steps, risks, open questions). Ask via ask_user if a decision is genuinely the user's. ` +
				`The user approves with /approve before any changes happen.\n\n` +
				`END your plan with a machine-readable STEPS block so it can be executed as a chain:\n` +
				`### STEPS\n- <agent-kind>: <what this step does>\n(one per line; agent-kind ∈ implementer, reviewer, debugger, refactorer, explorer). ` +
				`The user may run \`/approve chain\` to turn these into a runnable delegate chain.`,
		};
	});

	pi.registerCommand("plan", {
		description: "Enter read-only plan mode: /plan [task]. Agent explores + proposes; no edits until /approve.",
		handler: async (args: string, ctx: any) => {
			planning = true;
			planTask = (args || "").trim();
			ctx.ui.notify(
				`🗺  PLAN MODE on${planTask ? ` — ${planTask}` : ""}. Read-only: the agent will propose a plan, no edits until /approve.`,
				"info",
			);
		},
	});

	pi.registerCommand("approve", {
		description:
			"Approve the plan and exit plan mode. /approve chain also turns the plan's STEPS into a runnable delegate chain.",
		handler: async (args: string, ctx: any) => {
			if (!planning) {
				ctx.ui.notify("Not in plan mode.", "info");
				return;
			}
			planning = false;
			const wantChain = /\bchain\b/i.test(args || "");
			if (!wantChain) {
				ctx.ui.notify("✅ Plan approved — plan mode off. The agent can now make the changes it proposed.", "info");
				return;
			}

			// Gap B: turn the approved plan's STEPS into a delegate chain.
			const steps = parsePlanSteps(lastPlanText);
			if (!steps.length) {
				ctx.ui.notify(
					"✅ Plan approved. (No parseable STEPS block found — proceeding without a chain. Ask the agent to end its plan with a `### STEPS` list to enable /approve chain.)",
					"info",
				);
				return;
			}
			const name =
				"plan-" +
					(planTask || "chain")
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-")
						.replace(/^-|-$/g, "")
						.slice(0, 32) || "plan-chain";
			// Persist via delegate's create_chain through the bus, else surface the steps.
			let created = false;
			try {
				const req: any = { name, steps, task: planTask };
				pi.events?.emit?.("plan:chain", req);
				created = req.created === true;
			} catch {}
			const preview = steps.map((s, i) => `  ${i + 1}. ${s.agent}: ${s.prompt}`).join("\n");
			ctx.ui.notify(
				`✅ Plan approved → ${steps.length} steps${created ? ` saved as chain '${name}'` : ""}.\n${preview}\n` +
					(created
						? `Run it: delegate({action:"orchestrate", chain:"${name}", task:"${planTask}"})`
						: `(chain not persisted — run the steps via delegate run_agent, or create_chain them.)`),
				"info",
			);
			return `Approved plan as ${steps.length}-step chain${created ? ` '${name}'` : ""}:\n${preview}`;
		},
	});

	pi.registerCommand("plan-cancel", {
		description: "Exit plan mode without approving (discard the plan).",
		handler: async (_args: string, ctx: any) => {
			planning = false;
			planTask = "";
			ctx.ui.notify("Plan mode cancelled.", "info");
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show whether plan mode is active.",
		handler: async (_args: string, ctx: any) => {
			ctx.ui.notify(
				planning
					? `Plan mode ACTIVE${planTask ? ` — ${planTask}` : ""}. /approve to allow edits.`
					: "Plan mode off.",
				"info",
			);
		},
	});
}
