/**
 * model-router.ts — roles that resolve to a model by policy, not a fixed id.
 *
 * oh-my-pi's pi-model-router insight (deeper than a static role→model map): a role
 * (e.g. "planner", "worker", "scout") is a RANKED CANDIDATE POOL + a selection
 * method (cheapest-of-the-smartest / fastest / cheapest), resolved per use, with a
 * fallback ladder down the candidates on failure.
 *
 * You already route per-stage in delegate/debug by concrete model id. This adds a
 * layer above: name a ROLE and it resolves to the concrete model by policy —
 * change the pool/policy once, every stage using that role follows. And on a
 * model failure (quota/error), it falls back to the next candidate automatically.
 *
 * Roles are declared in .pi/roles.json (project) over ~/.pi/agent/pi-harness/roles.json:
 *   {
 *     "planner":  { "models": ["claude-opus-4-8","gpt-5.5","claude-sonnet-5"], "method": "smart" },
 *     "worker":   { "models": ["gpt-5.4-mini","claude-haiku-4-5"], "method": "cheap" },
 *     "scout":    { "models": ["gpt-5.4-mini"], "method": "cheap" }
 *   }
 * method: "smart" = first (candidates listed smartest-first) · "cheap" = cheapest
 * by the builtin cost table · "fast" = lowest-latency tier · else first.
 *
 * Resolution: `resolve_role` tool + a shared event so delegate/debug can call it.
 * Also exposes roles as a lookup the model can use: delegate a stage with
 * model:"@planner" and it resolves. Fallback: get_role_fallback returns the next
 * candidate when the current one fails.
 *
 * Config: KP_ROUTER_ENABLED=0 · roles.json.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ENABLED = process.env.KP_ROUTER_ENABLED !== "0";
const USER_CFG = join(homedir(), ".pi", "agent", "pi-harness", "roles.json");

type Role = { models: string[]; method?: "smart" | "cheap" | "fast" };
type Roles = Record<string, Role>;

// rough cost/intelligence/latency ordering for the models we use (relative).
// Lower cost rank = cheaper; higher smart rank = smarter; lower latency = faster.
const TABLE: Record<string, { cost: number; smart: number; latency: number }> = {
	"claude-opus-4-8": { cost: 9, smart: 10, latency: 6 },
	"claude-fable-5": { cost: 8, smart: 10, latency: 6 },
	"claude-sonnet-5": { cost: 5, smart: 8, latency: 4 },
	"gpt-5.5": { cost: 5, smart: 8, latency: 4 },
	"gpt-5.4": { cost: 4, smart: 7, latency: 4 },
	"claude-haiku-4-5-20251001": { cost: 2, smart: 5, latency: 2 },
	"gpt-5.4-mini": { cost: 1, smart: 5, latency: 2 },
	"gpt-5.3-codex-spark": { cost: 1, smart: 4, latency: 1 },
};
const bare = (m: string) => m.replace(/^[^/]+\//, "").replace(/:.*$/, "");
function score(m: string, method: string): number {
	const t = TABLE[bare(m)] ?? { cost: 5, smart: 5, latency: 5 };
	if (method === "cheap") return -t.cost; // higher = better → prefer low cost
	if (method === "fast") return -t.latency;
	if (method === "smart") return t.smart * 10 - t.cost; // smartest, tie-break cheaper
	return 0; // "first" — keep listed order
}

const DEFAULT_ROLES: Roles = {
	planner: { models: ["claude-opus-4-8", "gpt-5.5", "claude-sonnet-5"], method: "smart" },
	reviewer: { models: ["gpt-5.5", "claude-sonnet-5"], method: "smart" },
	worker: { models: ["gpt-5.4-mini", "claude-haiku-4-5-20251001"], method: "cheap" },
	scout: { models: ["gpt-5.4-mini"], method: "cheap" },
};

function loadRoles(cwd: string): Roles {
	const roles: Roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
	for (const p of [USER_CFG, join(cwd, ".pi", "roles.json")]) {
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8"));
			for (const [k, v] of Object.entries(raw)) if ((v as Role).models) roles[k] = v as Role;
		} catch {}
	}
	return roles;
}

// resolve a role to its ordered candidate list (best-first by method).
function resolveRole(roles: Roles, name: string): string[] {
	const r = roles[name.replace(/^@/, "")];
	if (!r || !r.models?.length) return [];
	const method = r.method || "first";
	if (method === "first") return [...r.models];
	return [...r.models].sort((a, b) => score(b, method) - score(a, method));
}

export default function (pi: any) {
	if (!ENABLED) return;

	let roles = loadRoles(process.cwd());
	let active = process.env.KP_ROUTER_OFF !== "1"; // runtime on/off toggle
	pi.on("session_start", async () => {
		roles = loadRoles(process.cwd());
	});

	// Shared resolver other extensions (delegate/debug) can call via the event bus:
	// pi.events.emit("router:resolve", {role}, cb) — but simplest is the tool below
	// and a synchronous helper exposed on pi.events for in-process use.
	pi.events?.on?.("router:resolve", (req: any) => {
		if (!active) {
			req.result = [];
			return;
		} // OFF → no resolution; delegate uses the bare id
		req.result = resolveRole(roles, req.role);
	});

	pi.registerTool({
		name: "resolve_role",
		label: "resolve role",
		description:
			"Resolve a model ROLE to concrete model candidates by policy (planner/reviewer/worker/scout or your own). " +
			"Returns the best model + fallbacks (ordered). Use to pick a model for a delegate stage — e.g. worker→cheapest, " +
			"planner→smartest. Pass the returned top model as a stage's model, or the whole list for fallback.",
		promptSnippet: "resolve_role(role) — role→best model+fallbacks (planner/worker/scout/…)",
		parameters: {
			type: "object",
			properties: { role: { type: "string", description: "role name (planner/reviewer/worker/scout/custom)" } },
			required: ["role"],
		},
		async execute(_id: string, params: any) {
			if (!active)
				return {
					content: [
						{ type: "text", text: "model routing is OFF (/roles on to enable) — use a concrete model id." },
					],
				};
			const cands = resolveRole(roles, params.role);
			if (!cands.length)
				return {
					content: [{ type: "text", text: `no role '${params.role}'. Roles: ${Object.keys(roles).join(", ")}` }],
				};
			return {
				content: [
					{
						type: "text",
						text: `role '${params.role}' → ${cands[0]}${cands.length > 1 ? ` (fallbacks: ${cands.slice(1).join(", ")})` : ""}`,
					},
				],
			};
		},
	});

	pi.registerCommand("roles", {
		description: "Model roles: /roles on|off · /roles list · /roles set <name> <method> <models>",
		handler: async (args: string, ctx: any) => {
			const [sub, name, method, ...rest] = (args || "").trim().split(/\s+/);
			if (sub === "off") {
				active = false;
				ctx.ui.notify(
					"Model routing OFF — @role references use the bare model id; stages use their literal model.",
					"info",
				);
				return;
			}
			if (sub === "on") {
				active = true;
				ctx.ui.notify("Model routing ON — @role resolves to the best model by policy.", "info");
				return;
			}
			if (!sub || sub === "list") {
				ctx.ui.notify(
					`Model routing: ${active ? "ON" : "OFF"} (/roles on|off)\n` +
						"Roles:\n" +
						Object.entries(roles)
							.map(
								([k, r]) =>
									`  ${k} [${r.method || "first"}] → ${resolveRole(roles, k)[0]} (${r.models.length} candidates)`,
							)
							.join("\n") +
						'\nUse in a delegate stage: model:"@<role>" (resolve_role tool), or /roles set to edit.',
					"info",
				);
				return;
			}
			if (sub === "set") {
				const models = rest
					.join(" ")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				if (!name || !["smart", "cheap", "fast", "first"].includes(method) || !models.length) {
					ctx.ui.notify("Usage: /roles set <name> <smart|cheap|fast|first> <model,model,…>", "warning");
					return;
				}
				const path = join(process.cwd(), ".pi", "roles.json");
				let raw: any = {};
				try {
					raw = JSON.parse(readFileSync(path, "utf-8"));
				} catch {}
				raw[name] = { models, method };
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
				roles = loadRoles(process.cwd());
				ctx.ui.notify(`Role '${name}' [${method}] → ${resolveRole(roles, name)[0]}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /roles list · /roles set <name> <method> <models>", "warning");
		},
	});
}
