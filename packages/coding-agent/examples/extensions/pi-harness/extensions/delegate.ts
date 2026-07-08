/**
 * delegate.ts — ONE lazy proxy for all delegation. Ephemeral subagents + chains +
 * orchestration behind a single tool, so it costs ~one schema in the prefix, not
 * five. Replaces the separate run_chain / orchestrate / create_chain tools.
 *
 * Two things this fixes:
 *  1. Context bloat: every extra tool schema rides the cached prefix every turn.
 *     Consolidating into one `delegate` proxy (actions discovered on demand) keeps
 *     the prefix lean — same discover-on-demand discipline as the KP proxies.
 *  2. Ephemeral vs persisted: a chain is a SAVED reusable pipeline. For one-off
 *     "go do this and check it", writing a YAML file is ceremony/litter. So
 *     run_agent spawns a THROWAWAY worker (no persistence); create_chain only
 *     persists when you actually want a reusable pipeline.
 *
 * Actions (delegate({action, …})):
 *  - run_agent  {prompt, model?, verify?, max_iters?}  ephemeral worker; if verify
 *               given, loops spawn→verify→re-prompt until it passes (or LLM-judges
 *               when no verify). Nothing saved to disk.
 *  - run_chain  {chain, task}                          run a saved chain (sequential)
 *  - orchestrate{chain, task}                          drive a saved chain to
 *               completion (per-stage verify/judge + re-prompt loop)
 *  - create_chain {name, steps[], description?}        persist a reusable chain
 *  - list                                              saved chains + how to use
 *
 * Each worker is an isolated `pi -p --mode json` subprocess (own context/model/
 * budget) — the parent stays thin. Native to pi 0.80.
 *
 * Config: KP_CHAIN_PI · KP_ORCH_MAX_ITERS(4) · KP_ORCH_SUPERVISOR(gpt-5.4-mini) ·
 *   KP_CHAIN_DEFAULT_PROVIDER(openai-codex) · KP_DELEGATE_STAGE_TIMEOUT_MS.
 *
 * Safety rails adopted from oh-my-pi (do not spawn unboundedly; do not leak the
 * plan-mode read-only guarantee or provider creds through a child):
 *  - Recursion depth cap (KP_DELEGATE_MAX_DEPTH, default 2). Depth rides down the
 *    subprocess tree in PI_DELEGATE_DEPTH. At/over the cap a child is spawned with
 *    the delegate/task tool STRIPPED (it can't spawn further); a KIND may never
 *    spawn its OWN name (no self-recursion). Enforced BOTH parent-side (before the
 *    spawn) and IN the child (delegate loads in every session, so it strips its own
 *    tool + blocks tool_call when PI_DELEGATE_NO_SPAWN is set).
 *  - Plan-mode propagation: while the parent is in plan mode (PI_PLAN_MODE=1, set
 *    on entry / propagated down), children are forced to a read-only tool allowlist
 *    and have spawn rights cleared — closing the "read-only escape via delegation"
 *    hole. (plan-mode.ts already blocks the parent's delegate call at the tool_call
 *    seam; this covers nested children where that seam isn't in play.)
 *  - Addressable result handles: an oversized (capped) return spills to a scratch
 *    file AND gets a stable handle; the parent can pull ONE json subpath on demand
 *    (delegate {action:"pull", handle, path}) instead of re-reading the whole spill.
 *  - verbatimReads per KIND: explore/retrieval KINDs return raw (read-summarization
 *    off in the child) so scouting isn't lossily compressed.
 *  - Env hardening: children get a scrubbed env — provider API keys (ANTHROPIC/
 *    OPENAI/…) stripped, reduced toward a core allowlist — so delegated code can't
 *    exfiltrate credentials. PI_TASK_MAX_OUTPUT_* is honored as a child output cap.
 *
 * Safety config: KP_DELEGATE_MAX_DEPTH(2) · KP_DELEGATE_ENV_HARDEN(1) ·
 *   KP_DELEGATE_VERBATIM_KINDS(explorer) · KP_TASK_MAX_OUTPUT_BYTES /
 *   PI_TASK_MAX_OUTPUT_BYTES (child return backstop).
 */

import { type ChildProcessByStdio, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import * as procRegistry from "./process-registry.ts"; // shared registry → /logs opens a subagent
import * as agentCards from "./ui-agent-cards.ts"; // rich task-card renderer (best-effort UI)

// Module-level UI handle for spawnWorker (a module-level fn) to feed the agent cards. Bound from
// the extension's hooks once we have a setWidget-capable ctx. Guarded everywhere it's called.
const ui = agentCards;

// Sub-agent return cap (research: a delegated agent should return a CONCISE
// summary ~1-2k tokens to the coordinator, not its whole transcript — the parent
// never needs the sub-agent's detailed work, only its conclusion). Oversized
// returns are externalized to a scratch file AND given a stable HANDLE: the parent
// gets the head + the handle, and can pull ONE json subpath on demand (delegate
// {action:"pull"}) instead of re-reading the whole spill. This is the capped
// return extended into "externalized + selectively recoverable" (oh-my-pi rank 20).
const RETURN_MAX = Number(process.env.KP_DELEGATE_RETURN_MAX || 8000); // ~2k tok
const RETURNS_DIR = join(tmpdir(), "pi-delegate-returns");
// Handle → spill file path, so a pull can be resolved from just the handle.
function handlePath(handle: string): string {
	return join(RETURNS_DIR, `${handle}.txt`);
}
function verbatim(agent: string): boolean {
	const k = agentKind(agent || "");
	return VERBATIM_KINDS.has((agent || "").trim().toLowerCase()) || (k ? VERBATIM_KINDS.has(k) : false);
}
function capReturn(text: string, agent: string): string {
	// Runtime output backstop (PI_TASK_MAX_OUTPUT_*): a hard ceiling on child output
	// independent of RETURN_MAX, so a runaway child can't flood us. Applied first.
	if (CHILD_MAX_OUTPUT > 0 && text.length > CHILD_MAX_OUTPUT) {
		text =
			text.slice(0, CHILD_MAX_OUTPUT) +
			`\n\n[delegate: child output hit PI_TASK_MAX_OUTPUT backstop (${CHILD_MAX_OUTPUT}B) — truncated]`;
	}
	if (text.length <= RETURN_MAX) return text;
	try {
		mkdirSync(RETURNS_DIR, { recursive: true });
		const handle = `${(agent || "worker").replace(/[^a-z0-9-]/gi, "-")}-${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
		const path = handlePath(handle);
		writeFileSync(path, text);
		return (
			text.slice(0, RETURN_MAX) +
			`\n\n[delegate: ${agent || "sub-agent"} returned ${Math.ceil(text.length / 4)} tok — capped to ~${Math.ceil(RETURN_MAX / 4)}. ` +
			`Full return at ${path}. Pull one field on demand: delegate {action:"pull", handle:"${handle}", path:"<json.subpath|/regex/>"} ` +
			`(or rg / read the file if the summary above is insufficient).]`
		);
	} catch {
		return `${text.slice(0, RETURN_MAX)}\n\n[delegate: return capped at ~${Math.ceil(RETURN_MAX / 4)} tok]`;
	}
}

// Pull ONE subpath from a spilled result by handle. `path` is either a dotted json
// subpath (foo.bar.0.baz) resolved against the spill parsed as JSON, or /regex/ to
// grep matching lines from the raw spill. Returns a compact slice, not the whole
// file — the point is selective recovery without re-reading the full return.
function pullHandle(handle: string, path: string): string {
	const p = handlePath(String(handle || "").replace(/[^a-z0-9-]/gi, "-"));
	if (!existsSync(p)) return `[delegate: no such handle '${handle}' (spill expired or wrong id)]`;
	let raw = "";
	try {
		raw = readFileSync(p, "utf-8");
	} catch {
		return `[delegate: could not read handle '${handle}']`;
	}
	const sel = String(path || "").trim();
	if (!sel) return capReturn(raw, "pull"); // no path → whole thing (re-capped)
	// /regex/ form → grep matching lines.
	const rx = sel.match(/^\/(.+)\/([a-z]*)$/);
	if (rx) {
		try {
			const re = new RegExp(rx[1], rx[2].includes("i") ? "i" : "");
			const hits = raw.split("\n").filter((l) => re.test(l));
			return hits.length
				? hits.slice(0, 200).join("\n").slice(0, RETURN_MAX)
				: `[delegate: no lines matched /${rx[1]}/ in handle '${handle}']`;
		} catch (e: any) {
			return `[delegate: bad regex — ${e.message}]`;
		}
	}
	// dotted json subpath.
	let doc: any;
	try {
		doc = JSON.parse(raw);
	} catch {
		return `[delegate: handle '${handle}' is not JSON — use /regex/ to grep it, or read ${p}]`;
	}
	let cur = doc;
	for (const key of sel.split(".")) {
		if (cur == null) return `[delegate: path '${sel}' not found (stopped at '${key}') in handle '${handle}']`;
		cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
	}
	if (cur === undefined) return `[delegate: path '${sel}' not found in handle '${handle}']`;
	const out = typeof cur === "string" ? cur : JSON.stringify(cur, null, 2);
	return out.slice(0, RETURN_MAX);
}

const PI_BIN = process.env.KP_CHAIN_PI || "pi";
const MAX_ITERS = Number(process.env.KP_ORCH_MAX_ITERS || 4);
const SUPERVISOR = process.env.KP_ORCH_SUPERVISOR || "gpt-5.4-mini";
const STAGE_TIMEOUT = Number(process.env.KP_DELEGATE_STAGE_TIMEOUT_MS || 900_000);
const DEFAULT_PROVIDER = process.env.KP_CHAIN_DEFAULT_PROVIDER || "openai-codex";

// --- safety rails config ------------------------------------------------------
// Hard recursion cap. Depth 0 = the top (human) session; each spawn increments
// PI_DELEGATE_DEPTH in the child. A child spawned AT the cap gets no spawn rights.
const MAX_DEPTH = Math.max(0, Number(process.env.KP_DELEGATE_MAX_DEPTH || 2));
const CUR_DEPTH = Math.max(0, Number(process.env.PI_DELEGATE_DEPTH || 0));
// Spawn rights are cleared for this session when a parent told us so (we're a
// grandchild at/over the cap) or plan mode is propagating down.
const NO_SPAWN = process.env.PI_DELEGATE_NO_SPAWN === "1";
const PLAN_MODE_ENV = process.env.PI_PLAN_MODE === "1";
// verbatim (raw, un-summarized) reads for these KINDS — scouting stays lossless.
const VERBATIM_KINDS = new Set(
	(process.env.KP_DELEGATE_VERBATIM_KINDS || "explorer")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean),
);
const ENV_HARDEN = process.env.KP_DELEGATE_ENV_HARDEN !== "0";
// Child output backstop (bytes): honor either name; 0 = no extra cap beyond RETURN_MAX.
const CHILD_MAX_OUTPUT = Number(process.env.KP_TASK_MAX_OUTPUT_BYTES || process.env.PI_TASK_MAX_OUTPUT_BYTES || 0);

// The delegate/task tools a stripped child must NOT keep (can't spawn further).
const SPAWN_TOOLS = ["delegate", "task"];
// A read-only allowlist for plan-mode children: read/search/analyze only. Kept in
// sync with plan-mode.ts's notion of non-mutating tools (best-effort — intersected
// with what actually exists in the child).
const READONLY_TOOLS = [
	"hread",
	"read",
	"read_cache",
	"ask_user",
	"scope",
	"knowledge_search",
	"knowledge_ask",
	"knowledge_find",
	"knowledge_trace",
	"knowledge_code_search",
	"knowledge_neighbors",
	"knowledge_resolve",
	"knowledge_coverage",
	"knowledge_gaps",
	"knowledge_timeline",
	"knowledge_document_text",
	"codemap_query",
	"session_search",
	"recall_memory",
	"find_references",
	"check_file",
];

// Provider credentials scrubbed from a child's env so delegated code can't
// exfiltrate them. The child re-derives what it needs from the model spec / mcp
// config, not from inherited provider keys.
const SECRET_ENV_RE = /(API_KEY|_TOKEN|_SECRET|SECRET_|PASSWORD|_KEY$|CREDENTIAL|ACCESS_KEY)/i;
const SECRET_ENV_EXACT = new Set([
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"COHERE_API_KEY",
	"VOYAGE_API_KEY",
	"DEEPSEEK_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AZURE_OPENAI_API_KEY",
	"HF_TOKEN",
	"HUGGINGFACE_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GITLAB_TOKEN",
	"JIRA_API_TOKEN",
	"BITBUCKET_TOKEN",
]);
// Env names that survive scrubbing even though they match the secret pattern
// (config the child legitimately needs — never a raw provider credential).
const SECRET_ENV_KEEP = new Set(["KP_DELEGATE_MAX_DEPTH"]);

// Return a scrubbed copy of an env: strip provider/credential vars (best-effort,
// pattern + explicit list). Gated by KP_DELEGATE_ENV_HARDEN (default on). The
// child obtains provider access via its own mcp/model config, not inherited keys.
function hardenEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// Opt-in: sandbox delegated children's bash (the "agent you don't watch"). When
	// KP_SANDBOX_DELEGATE=1, mark the child with KP_SANDBOX=1 so sandbox.ts auto-wraps
	// its bash (workspace-confined). Applied even if credential-hardening is off.
	const sandboxChild = process.env.KP_SANDBOX_DELEGATE === "1";
	if (!ENV_HARDEN) return sandboxChild ? { ...env, KP_SANDBOX: "1" } : env;
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (SECRET_ENV_KEEP.has(k)) {
			out[k] = v;
			continue;
		}
		if (SECRET_ENV_EXACT.has(k) || SECRET_ENV_RE.test(k)) continue; // drop credentials
		out[k] = v;
	}
	if (sandboxChild) out.KP_SANDBOX = "1";
	return out;
}

function qualifyModel(model: string): string {
	if (!model) return "";
	if (model.includes("/")) return model;
	if (/^claude-/.test(model)) return `harness-sdk/${model}`;
	return `${DEFAULT_PROVIDER}/${model}`;
}
// The KINDS of subagent a stage can be. This is the single typing axis: the
// stage's `agent:` names the kind (reviewer/debugger/implementer/…), and its
// tool set, retrieval mode, and model-role all derive from that ONE name. No
// separate "profile" field — the agent name IS the type.
//
// Each kind → a task-profile TYPE (drives tools+retrieval in task-profile.ts) and
// a model-router ROLE (drives the model). Synonyms map to the same kind so
// natural stage names ("code-reviewer", "fixer") just work.
const AGENT_KINDS: Record<string, { type: string; role: string }> = {
	debugger: { type: "debug", role: "planner" },
	reviewer: { type: "review", role: "reviewer" },
	refactorer: { type: "refactor", role: "worker" },
	explorer: { type: "understand", role: "scout" },
	implementer: { type: "implement", role: "worker" },
};
// name synonyms → canonical kind
const KIND_ALIAS: Record<string, string> = {
	debug: "debugger",
	fixer: "debugger",
	"bug-fixer": "debugger",
	troubleshooter: "debugger",
	review: "reviewer",
	"code-reviewer": "reviewer",
	auditor: "reviewer",
	critic: "reviewer",
	refactor: "refactorer",
	cleaner: "refactorer",
	understand: "explorer",
	researcher: "explorer",
	scout: "explorer",
	investigator: "explorer",
	implement: "implementer",
	builder: "implementer",
	coder: "implementer",
	writer: "implementer",
};

// Resolve a stage's agent NAME to a canonical kind (or "" if unknown).
function agentKind(agentName: string): string {
	const n = (agentName || "").trim().toLowerCase();
	if (!n) return "";
	if (n in AGENT_KINDS) return n;
	if (n in KIND_ALIAS) return KIND_ALIAS[n];
	// last resort: the name CONTAINS a kind word (e.g. "security-reviewer")
	for (const k of Object.keys(AGENT_KINDS)) if (n.includes(k) || n.includes(k.replace(/er$/, ""))) return k;
	return "";
}

// The task TYPE for a stage: from its agent kind first; else inferred from the
// prompt's wording (so an unnamed/generic agent still gets a fitting profile).
function stageType(agentName: string, prompt: string): string {
	const kind = agentKind(agentName);
	if (kind) return AGENT_KINDS[kind].type;
	const t = (prompt || "").toLowerCase();
	if (/\b(debug|stack ?trace|traceback|exception|failing|root ?cause|reproduce|broken|not working)\b/.test(t))
		return "debug";
	if (/\b(review|audit|check this|find (bugs|issues)|vet\b)\b/.test(t)) return "review";
	if (/\b(refactor|rename|extract|restructure|clean ?up|inline)\b/.test(t)) return "refactor";
	if (/\b(how does|explain|what (is|does)|understand|trace through|architecture)\b/.test(t)) return "understand";
	if (/\b(implement|add |build |create |write |feature|wire up|integrate)\b/.test(t)) return "implement";
	return "";
}

// The model-router ROLE for a stage: from its agent kind, else from its type.
const TYPE_ROLE: Record<string, string> = {
	debug: "planner",
	review: "reviewer",
	refactor: "worker",
	understand: "scout",
	implement: "worker",
};
function roleForStage(agentName: string, prompt: string): string {
	const kind = agentKind(agentName);
	if (kind) return AGENT_KINDS[kind].role;
	const type = stageType(agentName, prompt);
	return type ? TYPE_ROLE[type] || "worker" : "";
}

// Resolve a "@role" model reference through model-router (if loaded) to a concrete
// model; plain ids pass through. Uses the shared event bus (synchronous fill).
// If `model` is empty, fall back to the stage's ROLE (from its agent kind, else
// its prompt) so a reviewer→reviewer-model / debugger→planner stage is auto-fit.
function resolveRoleModel(pi: any, model: string, agentName = "", prompt = ""): string {
	let ref = model;
	if (!ref && (agentName || prompt)) {
		const r = roleForStage(agentName, prompt);
		if (r) ref = `@${r}`;
	}
	if (!ref?.startsWith("@")) return ref;
	try {
		const req: any = { role: ref.slice(1) };
		pi?.events?.emit?.("router:resolve", req);
		if (req.result?.length) return req.result[0];
	} catch {}
	return ref.replace(/^@/, ""); // router absent → treat as bare id
}
function agentSystemPrompt(cwd: string, agent: string): string | null {
	if (!agent) return null;
	for (const dir of [join(cwd, ".pi", "agents"), join(homedir(), ".pi", "agent", "agents")]) {
		const p = join(dir, `${agent}.md`);
		if (existsSync(p)) {
			try {
				return (
					readFileSync(p, "utf-8")
						.replace(/^---[\s\S]*?---\n/, "")
						.trim() || null
				);
			} catch {}
		}
	}
	return null;
}

// Read the shared discovery ledger (dlc-context.ts) for the current run and
// render it compactly, so each spawned stage starts hydrated instead of
// rediscovering. Same file the dlc_context/dlc_note tools use.
function dlcLedgerPath(): string {
	const run = process.env.A2A_RUN || `run-${process.pid}`;
	return join(homedir(), ".pi", "agent", "pi-harness", "a2a", run, "dlc-ledger.jsonl");
}
function renderDlcLedger(): string {
	try {
		const p = dlcLedgerPath();
		if (!existsSync(p)) return "";
		const notes = readFileSync(p, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const byKey = new Map<string, any>();
		for (const n of notes) byKey.set(`${n.kind}:${n.key}`, n);
		const uniq = [...byKey.values()];
		if (!uniq.length) return "";
		const order = ["scope", "plan", "read", "finding", "verify"];
		const lines: string[] = [];
		for (const kind of order) {
			const ns = uniq.filter((n) => n.kind === kind);
			if (!ns.length) continue;
			lines.push(`### ${kind} (already known — do NOT rediscover)`);
			for (const n of ns) lines.push(`- ${n.key}: ${String(n.text).slice(0, 300)}`);
		}
		return lines.length ? `## Shared discovery ledger for this task (from earlier stages)\n${lines.join("\n")}` : "";
	} catch {
		return "";
	}
}
function recordDlcNote(kind: string, key: string, text: string, by = "parent"): void {
	try {
		const p = dlcLedgerPath();
		mkdirSync(join(p, ".."), { recursive: true });
		appendFileSync(
			p,
			`${JSON.stringify({
				kind,
				key: String(key).slice(0, 200),
				text: String(text).slice(0, 4000),
				by,
				ts: new Date().toISOString(),
			})}\n`,
		);
	} catch {}
}

// spawn one isolated pi worker; return final assistant text
// Memory inheritance (mnemopi gap): pass the parent's standing corrections/
// preferences into the child so a delegated subagent isn't memory-blind. Fetched
// once per delegation via a quick KP search; injected into the child's system
// prompt. Best-effort — the child also loads its own memory extension.
let inheritedMemory: string | null = null;
function fetchInheritedMemory(cwd: string): string {
	if (inheritedMemory !== null) return inheritedMemory;
	inheritedMemory = "";
	try {
		const spec =
			JSON.parse(readFileSync(join(cwd, "knowledge-platform", ".mcp.json"), "utf-8")).mcpServers?.knowledge ??
			JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8")).mcpServers?.knowledge;
		if (!spec) return "";
		// one-shot: query KP for standing corrections via the kp cli directly (fast path)
		const out = execSync(
			`${join(cwd, "knowledge-platform", spec.command)} search "[correction]" --recipe cross_encoder 2>/dev/null || true`,
			{
				cwd: join(cwd, "knowledge-platform"),
				encoding: "utf-8",
				timeout: 20_000,
				env: { ...process.env, ...spec.env },
			},
		).trim();
		if (out) inheritedMemory = out.slice(0, 1500);
	} catch {}
	return inheritedMemory;
}

// Parent-side spawn guard: refuse to spawn when this session has no spawn rights
// (grandchild past the recursion cap, or plan-mode propagating down), when the
// next level would exceed the depth cap, or when a KIND would spawn its OWN name
// (self-recursion). Returns a reason string to refuse with, or "" to allow.
// `by` is this session's own agent id (A2A_ID) — used for the self-spawn check.
function spawnGuard(childAgent: string): string {
	if (NO_SPAWN)
		return `spawn rights cleared for this session (plan-mode read-only or past recursion cap) — cannot delegate further`;
	if (CUR_DEPTH >= MAX_DEPTH)
		return `recursion depth cap reached (depth ${CUR_DEPTH} ≥ KP_DELEGATE_MAX_DEPTH ${MAX_DEPTH}) — cannot delegate further`;
	const self = (process.env.A2A_ID || "").trim().toLowerCase();
	const child = (childAgent || "").trim().toLowerCase();
	if (self && child && self === child) return `a '${child}' cannot spawn its own kind (self-recursion blocked)`;
	// Also block spawning the same CANONICAL kind as ourselves (reviewer↔code-reviewer).
	const selfKind = agentKind(self),
		childKind = agentKind(child);
	if (selfKind && childKind && selfKind === childKind)
		return `a '${self}' (kind ${selfKind}) cannot spawn another ${childKind} (self-recursion blocked)`;
	return "";
}

function spawnWorker(
	opts: { prompt: string; model?: string; thinking?: string; agent?: string; inheritMemory?: boolean },
	cwd: string,
): Promise<string> {
	return new Promise((resolve) => {
		// Recursion / plan-mode gate: never spawn past the cap or out of a read-only
		// parent. (Also enforced in-child via tool_call block, but refuse early here.)
		const refuse = spawnGuard(opts.agent || "");
		if (refuse) return resolve(`[delegate: refused — ${refuse}]`);
		const args = ["-p", "--mode", "json", "--no-session"];
		const m = qualifyModel(opts.model || "");
		if (m) args.push("--model", opts.thinking ? `${m}:${opts.thinking}` : m);
		const sysParts: string[] = [];
		const sys = agentSystemPrompt(cwd, opts.agent || "");
		if (sys) sysParts.push(sys);
		if (opts.inheritMemory !== false) {
			const mem = fetchInheritedMemory(cwd);
			if (mem) sysParts.push(`## Inherited standing preferences (from the parent session — follow these)\n${mem}`);
		}
		// Shared discovery ledger: inject what earlier stages already scoped/planned/
		// read/found/verified, so this stage doesn't rediscover it (dlc-context.ts).
		const ledger = renderDlcLedger();
		if (ledger)
			sysParts.push(
				ledger +
					`\n(Consult this before scoping/reading; record NEW discoveries with dlc_note so later stages skip them.)`,
			);
		if (sysParts.length) args.push("--append-system-prompt", sysParts.join("\n\n"));
		args.push(opts.prompt);
		// A2A: share the parent's mailbox run with the child, give it its stage id.
		// The child's TYPE derives from its agent KIND (reviewer→review, debugger→
		// debug, …), falling back to the prompt wording — ONE axis, the agent name.
		// This fixes the child's tool set at spawn (a stable, cached prefix).
		const childType = stageType(opts.agent || "", opts.prompt || "");
		const childDepth = CUR_DEPTH + 1;
		// The child gets no spawn rights of its own when spawning it would put the
		// NEXT level at/over the cap, or when plan mode is propagating down (read-only).
		// In-child, delegate reads PI_DELEGATE_NO_SPAWN and strips its own tool + blocks
		// tool_call, so this holds even if the child's task-profile would re-add delegate.
		const childNoSpawn = childDepth >= MAX_DEPTH || PLAN_MODE_ENV || NO_SPAWN;
		const childVerbatim = verbatim(opts.agent || "");
		const baseEnv = {
			...process.env,
			A2A_RUN: process.env.A2A_RUN || `run-${process.pid}`,
			A2A_ID: opts.agent || `worker-${Math.random().toString(36).slice(2, 6)}`,
			PI_DELEGATE_DEPTH: String(childDepth),
			...(childType ? { KP_TASK_PROFILE: childType } : {}),
			...(childNoSpawn ? { PI_DELEGATE_NO_SPAWN: "1" } : {}),
			...(PLAN_MODE_ENV ? { PI_PLAN_MODE: "1" } : {}),
			// explore/retrieval KINDs return raw — tell the child's read layer not to
			// summarize (honored by read-cache/compress if they consult this signal).
			...(childVerbatim ? { PI_VERBATIM_READS: "1", KP_READ_NO_SUMMARY: "1" } : {}),
		};
		// Env hardening: strip provider API keys / credentials from the child so
		// delegated code can't exfiltrate them (KP_DELEGATE_ENV_HARDEN=0 to disable).
		const childEnv = hardenEnv(baseEnv);
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(PI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
		} catch {
			return resolve("[worker failed to spawn]");
		}
		// Rich UI: feed the omp-style task card (best-effort — never let a UI hiccup break delegation).
		const cardId = opts.agent || `worker-${Math.random().toString(36).slice(2, 6)}`;
		let reqs = 0,
			tokensK = 0;
		try {
			ui?.agentStart?.(cardId, childType || "task", String(opts.prompt || "").slice(0, 90));
		} catch {}
		// Register the child so the user can stop it mid-flight via /agents stop (Claude Code parity).
		try {
			ui?.registerProc?.(cardId, {
				kill: () => {
					try {
						proc.kill("SIGTERM");
					} catch {}
				},
			});
		} catch {}
		// Live output log for /logs — accumulate the child's readable activity (assistant text + tool
		// names) so the user can open a running subagent and watch what it's doing.
		let liveLog = `▶ ${childType || "task"}: ${String(opts.prompt || "").slice(0, 100)}\n`;
		let childState: "running" | "done" | "failed" = "running";
		try {
			procRegistry.register({
				id: cardId,
				kind: "agent",
				label: String(opts.prompt || "").slice(0, 80),
				state: () => childState,
				output: () => liveLog,
				kill: () => {
					try {
						proc.kill("SIGTERM");
					} catch {}
				},
			});
		} catch {}
		let finalText = "",
			buf = "";
		const timer = setTimeout(() => proc.kill(), STAGE_TIMEOUT);
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant") {
						reqs++;
						const u = e.message.usage;
						if (u) tokensK = ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0)) / 1000;
						try {
							ui?.agentUpdate?.(cardId, { reqs, tokensK });
						} catch {}
						const t = (e.message.content || [])
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n");
						if (t.trim()) {
							finalText = t;
							liveLog += `\n[msg ${reqs}] ${t.slice(0, 500)}\n`;
						}
					} else if (e.type === "tool_call" && e.toolName) {
						liveLog += `  · ${e.toolName}\n`; // show the subagent's tool activity live
					}
				} catch {}
			}
		});
		proc.stderr.on("data", (d) => {
			liveLog += d.toString();
		});
		proc.on("close", (code: number) => {
			clearTimeout(timer);
			childState = code === 0 && finalText ? "done" : "failed";
			liveLog += `\n■ ${childState} (exit ${code})\n`;
			const out = capReturn(finalText || "[no output]", opts.agent || "");
			try {
				ui?.agentEnd?.(cardId, childState, finalText || `[exit ${code}]`);
			} catch {}
			resolve(out);
		});
		proc.on("error", () => {
			clearTimeout(timer);
			childState = "failed";
			liveLog += "\n■ worker error\n";
			try {
				ui?.agentEnd?.(cardId, "failed", "[worker error]");
			} catch {}
			resolve("[worker error]");
		});
	});
}

function runVerify(cmd: string, cwd: string): { ok: boolean; output: string } {
	try {
		const out = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 });
		return { ok: true, output: out.slice(-2000) };
	} catch (e: any) {
		return {
			ok: false,
			output: (`${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message || "verify failed").slice(-2000),
		};
	}
}
// Semantic gate (Gap A): an adversarial completion audit as a LOOP gate — catches
// reward-hacking (test gamed, hardcoded output, stubbed logic) that a passing test
// command can't. Reuses verify.ts's skeptic prompt shape: reads the stage's git
// diff and the goal, returns REAL vs GAMED/INCOMPLETE. On not-REAL, the verdict is
// fed back as the correction so the next attempt fixes the actual work.
function semanticVerify(goal: string, cwd: string): Promise<{ ok: boolean; reason: string }> {
	return new Promise((resolve) => {
		let diff = "";
		try {
			diff = execSync("git diff HEAD", { cwd, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
		} catch {}
		if (!diff.trim())
			return resolve({ ok: false, reason: "no changes were made (empty diff) — the work wasn't done" });
		const prompt =
			`You are an adversarial completion auditor. Decide if the work below genuinely does the GOAL and is CORRECT, ` +
			`or merely LOOKS done (reward-hacked): hardcoded/test-matching outputs, special-casing the test input, stubbed ` +
			`no-op logic, tests weakened/skipped, spec-vs-impl gaps, swallowed errors.\n` +
			`Reply EXACTLY "REAL" if genuinely done+correct, else "GAMED: <the specific tell + what to fix>". Terse.\n\n` +
			`### GOAL\n${goal}\n\n### DIFF\n${diff.length > 180_000 ? `${diff.slice(0, 180_000)}\n\n⚠ DIFF TRUNCATED — you see only PART of the change; don't return REAL on a partial view, flag the unseen remainder.` : diff}`;
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(PI_BIN, ["-p", "--mode", "json", "--no-session", "--model", qualifyModel(SUPERVISOR), prompt], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			return resolve({ ok: true, reason: "" });
		} // auditor unavailable → don't block
		let text = "",
			buf = "";
		const timer = setTimeout(() => proc.kill(), 180_000);
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant")
						text = (e.message.content || [])
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n");
				} catch {}
			}
		});
		proc.stderr.on("data", () => {});
		proc.on("close", () => {
			clearTimeout(timer);
			const ok = /^\s*REAL\b/i.test(text);
			resolve({
				ok,
				reason: ok ? "" : text.replace(/^.*?GAMED:\s*/is, "").trim() || "work appears gamed/incomplete",
			});
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve({ ok: true, reason: "" });
		});
	});
}
function judge(goal: string, output: string, cwd: string): Promise<{ ok: boolean; reason: string }> {
	return new Promise((resolve) => {
		const prompt = `Strict completion judge. GOAL:\n${goal}\n\nOUTPUT:\n${output.slice(0, 6000)}\n\nReply EXACTLY "OK" if fully done, else "MISSING: <gaps>". Terse.`;
		let proc: ChildProcessByStdio<null, Readable, Readable>;
		try {
			proc = spawn(PI_BIN, ["-p", "--mode", "json", "--no-session", "--model", qualifyModel(SUPERVISOR), prompt], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			return resolve({ ok: true, reason: "" });
		}
		let text = "",
			buf = "";
		const timer = setTimeout(() => proc.kill(), 120_000);
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					const e = JSON.parse(line);
					if (e.type === "message_end" && e.message?.role === "assistant")
						text = (e.message.content || [])
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n");
				} catch {}
			}
		});
		proc.stderr.on("data", () => {});
		proc.on("close", () => {
			clearTimeout(timer);
			const ok = /^\s*OK\b/i.test(text);
			resolve({ ok, reason: ok ? "" : text.replace(/^.*?MISSING:\s*/is, "").trim() });
		});
		proc.on("error", () => {
			clearTimeout(timer);
			resolve({ ok: true, reason: "" });
		});
	});
}

// supervised loop for one unit of work (ephemeral worker OR a chain stage).
// Gate order per attempt: shell `verify` (deterministic tests) → semantic `assert`
// (verify_work skeptic: is it REAL or reward-hacked) → else LLM completion judge.
// Any gate's failure becomes the correction fed to the next attempt.
async function drive(
	unit: { prompt: string; model?: string; thinking?: string; agent?: string; verify?: string; assert?: string },
	task: string,
	prior: string,
	maxIters: number,
	cwd: string,
	log: (m: string) => void,
): Promise<{ text: string; passed: boolean; iters: number }> {
	let correction = "",
		lastText = "";
	const goal = `${unit.prompt}\n${task}`;
	for (let i = 1; i <= maxIters; i++) {
		const prompt =
			`${unit.prompt}\n\n## Task\n${task}` +
			(prior ? `\n\n## Prior outputs\n${prior}` : "") +
			(correction ? `\n\n## Previous attempt NOT accepted. Fix exactly this:\n${correction}` : "");
		log(`  ▶ ${unit.agent || "worker"} attempt ${i}/${maxIters}…`);
		lastText = await spawnWorker({ ...unit, prompt }, cwd);

		// 1) shell verify — tests must pass (cheap, deterministic).
		if (unit.verify) {
			const { ok, output } = runVerify(unit.verify, cwd);
			if (!ok) {
				correction = `Verify \`${unit.verify}\` FAILED:\n${output}`;
				log(`  ✗ verify failed`);
				continue;
			}
			log(`  ✓ verified (${unit.verify})`);
		}
		// 2) semantic assert — the work must be REAL, not gamed (Gap A: closes the
		//    loop on correctness, not just green). Runs even when tests pass, because
		//    passing tests is exactly what a reward-hack produces.
		if (unit.assert) {
			const s = await semanticVerify(unit.assert === "auto" ? goal : `${goal}\n\nMust satisfy: ${unit.assert}`, cwd);
			if (!s.ok) {
				correction = `Work rejected as gamed/incomplete: ${s.reason}`;
				log(`  ✗ semantic verify: ${s.reason.slice(0, 60)}`);
				continue;
			}
			log(`  ✓ semantically verified (REAL)`);
			return { text: lastText, passed: true, iters: i };
		}
		if (unit.verify) return { text: lastText, passed: true, iters: i }; // verified, no assert
		// 3) no explicit gate → LLM completion judge.
		const v = await judge(goal, lastText, cwd);
		if (v.ok) {
			log(`  ✓ judged complete`);
			return { text: lastText, passed: true, iters: i };
		}
		correction = v.reason || "incomplete";
		log(`  ✗ judged incomplete`);
	}
	return { text: lastText, passed: false, iters: maxIters };
}

// --- chains (saved, reusable) -------------------------------------------------
type Stage = { agent: string; model?: string; thinking?: string; prompt: string; verify?: string; assert?: string };
function parseChains(text: string): Record<string, { description?: string; steps: Stage[] }> {
	const out: Record<string, { description?: string; steps: Stage[] }> = {};
	let cur: any = null;
	let step: Stage | null = null;
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\t/g, "  ");
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;
		const t = line.trim();
		if (indent === 0 && t.endsWith(":")) {
			cur = { steps: [] };
			out[t.slice(0, -1).trim()] = cur;
			step = null;
			continue;
		}
		if (!cur) continue;
		if (t.startsWith("description:")) {
			cur.description = t
				.slice(12)
				.trim()
				.replace(/^["']|["']$/g, "");
			continue;
		}
		if (t === "steps:") continue;
		if (t.startsWith("- ")) {
			step = { agent: "", prompt: "" };
			cur.steps.push(step);
			const r = t.slice(2).trim();
			if (r) kv(step, r);
			continue;
		}
		if (step && t.includes(":")) kv(step, t);
	}
	return out;
}
function kv(s: Stage, str: string) {
	const i = str.indexOf(":");
	if (i < 0) return;
	const k = str.slice(0, i).trim();
	const v = str
		.slice(i + 1)
		.trim()
		.replace(/^["']|["']$/g, "");
	if (k === "agent") s.agent = v;
	else if (k === "model") s.model = v;
	else if (k === "thinking") s.thinking = v;
	else if (k === "prompt") s.prompt = v;
	else if (k === "verify") s.verify = v;
	else if (k === "assert") s.assert = v;
}
function discoverChains(cwd: string) {
	const chains: Record<string, { description?: string; steps: Stage[] }> = {};
	for (const dir of [join(homedir(), ".pi", "agent", "chains"), join(cwd, ".pi", "chains")]) {
		try {
			for (const f of readdirSync(dir))
				if (/\.ya?ml$/.test(f)) Object.assign(chains, parseChains(readFileSync(join(dir, f), "utf-8")));
		} catch {}
	}
	return chains;
}
// Persist a chain to .pi/chains/<name>.yaml (shared by create_chain + plan→chain).
function writeChain(name: string, steps: any[], cwd: string, description?: string): string {
	const esc = (s: string) => `"${String(s ?? "").replaceAll('"', '\\"')}"`;
	const yaml =
		`${name}:\n` +
		(description ? `  description: ${esc(description)}\n` : "") +
		`  steps:\n` +
		steps
			.map(
				(s: any) =>
					`    - agent: ${s.agent}\n` +
					(s.model ? `      model: ${s.model}\n` : "") +
					`      prompt: ${esc(s.prompt)}\n` +
					(s.verify ? `      verify: ${esc(s.verify)}\n` : "") +
					(s.assert ? `      assert: ${esc(s.assert)}\n` : ""),
			)
			.join("");
	const dir = join(cwd, ".pi", "chains");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.yaml`), yaml);
	return join(dir, `${name}.yaml`);
}

const DELEGATION_POLICY = `

## Delegation
You can spawn focused isolated sub-agents (keeps YOUR context thin) via the \`delegate\` tool — you are not limited to inline work. delegate({action:"list"}) shows how. Use it for: a focused throwaway job (run_agent, optionally with a verify command to auto-retry until it passes), multi-stage work (a saved chain via run_chain/orchestrate, or author one with create_chain), or work that must complete autonomously (orchestrate). Delegate when a job would read 4+ files / touch 2+ files / is a distinct focused task; do trivial work inline.`;

export default function (pi: any) {
	// Bind the rich-agent-card renderer to a setWidget-capable ctx (best-effort UI).
	const bindCards = (_e: any, ctx: any) => {
		try {
			agentCards.bindUi(ctx);
		} catch {}
	};
	pi.on("session_start", bindCards);
	pi.on("turn_start", bindCards);

	// ---- IN-CHILD SPAWN LOCKDOWN (runs in every session; only bites in a locked
	// child) --------------------------------------------------------------------
	// delegate loads in EVERY pi session, including delegated children. When the
	// parent cleared this child's spawn rights (PI_DELEGATE_NO_SPAWN=1 — set when the
	// next level would exceed KP_DELEGATE_MAX_DEPTH, or plan mode is propagating down)
	// we STRIP the delegate/task tool at session_start so the grandchild can't spawn
	// further, and hard-block any residual tool_call to them. This is the enforcement
	// half of the parent-side spawnGuard, so the cap holds across the process tree
	// even though the child's task-profile would otherwise re-add `delegate`.
	const CHILD_LOCKED = NO_SPAWN || CUR_DEPTH >= MAX_DEPTH;
	const CHILD_READONLY = PLAN_MODE_ENV; // plan-mode propagated → read-only allowlist
	if (CHILD_LOCKED || CHILD_READONLY) {
		pi.on("session_start", async () => {
			try {
				const all: string[] = pi.getAllTools?.()?.map((t: any) => t?.name ?? t) ?? [];
				if (!all.length) {
					if (CHILD_LOCKED) pi.setActiveTools?.([]);
					return;
				}
				let keep = all;
				if (CHILD_READONLY) keep = keep.filter((t) => READONLY_TOOLS.includes(t)); // read-only allowlist
				keep = keep.filter((t) => !SPAWN_TOOLS.includes(t)); // never keep spawn tools
				pi.setActiveTools?.(keep);
				try {
					pi.ui?.notify?.(
						`delegate: child spawn rights cleared${CHILD_READONLY ? " (plan-mode read-only)" : ` (depth ${CUR_DEPTH}/${MAX_DEPTH})`}`,
						"info",
					);
				} catch {}
			} catch {}
		});
		// Belt-and-suspenders: block spawn tools at the call seam too (in case the set
		// was mutated back, or a tool isn't in the active-set machinery).
		pi.on("tool_call", async (event: any) => {
			const name = event?.toolName ?? event?.name ?? "";
			if (SPAWN_TOOLS.includes(name)) {
				return {
					block: true,
					reason: CHILD_READONLY
						? `PLAN MODE (inherited): a delegated child of a planning session is read-only and cannot delegate further.`
						: `DELEGATION DEPTH CAP: this sub-agent is at recursion depth ${CUR_DEPTH}/${MAX_DEPTH} (KP_DELEGATE_MAX_DEPTH) — it cannot spawn further sub-agents.`,
				};
			}
		});
	}

	// Only advertise delegation to sessions that can actually delegate — a locked/
	// read-only child shouldn't be told it can spawn workers.
	const CAN_DELEGATE = !CHILD_LOCKED && !CHILD_READONLY;
	pi.on("before_agent_start", async (event: any) => ({
		systemPrompt: (event.systemPrompt ?? "") + (CAN_DELEGATE ? DELEGATION_POLICY : ""),
	}));

	// Gap B: plan-mode emits an approved plan's steps here → persist as a chain.
	// The step's `agent` (kind) already drives its tools+model+type in spawnWorker.
	try {
		pi.events?.on?.("plan:chain", (req: any) => {
			try {
				if (!req?.name || !Array.isArray(req.steps) || !req.steps.length) return;
				const safe = String(req.name).replace(/[^a-z0-9-]/gi, "-");
				writeChain(safe, req.steps, process.cwd(), req.task ? `plan: ${req.task}` : undefined);
				req.created = true;
			} catch {
				req.created = false;
			}
		});
	} catch {}

	// Completion guard (pi-subagents): an implementation-type stage that returned
	// text but changed NO files probably just planned instead of doing. Detect via
	// git diff before/after and flag it.
	const IMPL = /implement|fix|code|edit|write|build|refactor|apply/i;
	function gitDirty(cwd: string): string {
		try {
			return execSync("git status --porcelain 2>/dev/null || true", { cwd, encoding: "utf-8" });
		} catch {
			return "";
		}
	}

	async function runChainStages(
		stages: Stage[],
		task: string,
		cwd: string,
		orchestrated: boolean,
		log: (m: string) => void,
	) {
		let prior = "";
		const stuck: string[] = [];
		for (const s of stages) {
			const before = IMPL.test(s.agent) ? gitDirty(cwd) : "";
			let stageText = "";
			if (orchestrated || s.verify || s.assert) {
				const { text, passed } = await drive(
					{ ...s, model: resolveRoleModel(pi, s.model || "", s.agent, s.prompt) },
					task,
					prior,
					MAX_ITERS,
					cwd,
					log,
				);
				stageText = text;
				prior += `\n### ${s.agent}\n${text}`;
				if (!passed) stuck.push(s.agent);
			} else {
				log(`  ▶ ${s.agent}…`);
				const text = await spawnWorker(
					{
						prompt: `${s.prompt}\n\n## Task\n${task}${prior ? `\n\n## Prior\n${prior}` : ""}`,
						model: resolveRoleModel(pi, s.model || "", s.agent, s.prompt),
						thinking: s.thinking,
						agent: s.agent,
					},
					cwd,
				);
				stageText = text;
				prior += `\n### ${s.agent}\n${text}`;
			}
			// Auto-record the stage's result to the shared ledger so the NEXT stage
			// sees it (even if this stage never called dlc_note). A scope/explore stage
			// records `scope`; others record a `finding`.
			const kind = /scope|explore|understand|research|investigat/i.test(s.agent) ? "scope" : "finding";
			if (stageText.trim()) recordDlcNote(kind, s.agent, stageText.trim(), s.agent);
			if (IMPL.test(s.agent) && !s.verify) {
				const after = gitDirty(cwd);
				if (after === before) {
					log(`  ⚠ ${s.agent}: implementation stage changed no files — likely planned instead of doing`);
					stuck.push(`${s.agent}(no-op)`);
				}
			}
		}
		return { prior, stuck };
	}

	pi.registerTool({
		name: "delegate",
		label: "delegate",
		description:
			'Delegate work to isolated sub-agents (keeps your context thin). Call {action:"list"} first to see saved ' +
			"chains. Actions: run_agent (ephemeral worker; optional verify cmd auto-retries until it passes — nothing " +
			"saved), run_chain / orchestrate (run a saved chain; orchestrate drives to completion), create_chain (save a " +
			"reusable chain). Ephemeral run_agent for one-offs; create_chain only to persist a reusable pipeline. " +
			"pull (recover one field from a capped/spilled worker return by its handle).",
		promptSnippet:
			"delegate(action,…) — spawn isolated sub-agents: run_agent (ephemeral) / run_chain / orchestrate / create_chain / pull",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["run_agent", "run_chain", "orchestrate", "create_chain", "list", "pull"] },
				// run_agent
				prompt: { type: "string", description: "run_agent: what the ephemeral worker should do" },
				agent: {
					type: "string",
					description:
						"run_agent: the KIND of agent — reviewer | debugger | implementer | refactorer | explorer (fixes its tools+model at spawn). Omit to infer from the prompt.",
				},
				model: {
					type: "string",
					description: "run_agent: optional explicit model (overrides the kind's role-model)",
				},
				verify: {
					type: "string",
					description: "run_agent: optional shell command that must pass (auto-retries on failure)",
				},
				assert: {
					type: "string",
					description:
						"run_agent: semantic correctness gate — a claim the work must genuinely satisfy (or \"auto\" to just check it's not reward-hacked). Runs an adversarial audit of the diff; retries if GAMED/incomplete. Catches test-gaming that `verify` can't.",
				},
				max_iters: { type: "number", description: "run_agent: retry cap (default 4)" },
				// run_chain / orchestrate
				chain: { type: "string", description: "run_chain/orchestrate: saved chain name" },
				task: { type: "string", description: "run_chain/orchestrate: the task" },
				// create_chain
				name: { type: "string", description: "create_chain: chain id" },
				description: { type: "string" },
				steps: {
					type: "array",
					description:
						"create_chain: stages {agent, prompt, model?, verify?}. `agent` is the stage's KIND (reviewer|debugger|implementer|refactorer|explorer, or a custom name) — it fixes that stage's tools + model. model? overrides.",
					items: { type: "object" },
				},
				// pull — selectively recover from a capped/spilled worker return.
				handle: {
					type: "string",
					description: "pull: the handle from a capped worker return (shown in the [delegate: … Pull …] note)",
				},
				path: {
					type: "string",
					description:
						"pull: which slice to recover — a dotted json subpath (foo.bar.0) resolved against the spilled return, or /regex/ to grep matching lines. Omit for the whole (re-capped) spill.",
				},
			},
			required: ["action"],
		},
		async execute(_id: string, p: any) {
			const cwd = process.cwd();
			const noop = () => {};
			switch (p.action) {
				case "list": {
					const chains = discoverChains(cwd);
					const names = Object.keys(chains);
					return {
						content: [
							{
								type: "text",
								text:
									`delegate actions:\n` +
									`- run_agent {prompt, agent?, model?, verify?}  → ephemeral isolated worker; agent = its KIND (reviewer|debugger|implementer|refactorer|explorer) → fixes tools+model\n` +
									`- create_chain {name, steps:[{agent,prompt,model?,verify?}]}  → save a reusable chain (agent names each stage's KIND)\n` +
									`- run_chain / orchestrate {chain, task}  → run a saved chain (orchestrate drives to completion)\n` +
									`- pull {handle, path?}  → recover one field (json subpath or /regex/) from a capped worker return, on demand\n\n` +
									(names.length
										? `saved chains: ${names.map((n) => `${n}(${chains[n].steps.length})`).join(", ")}`
										: "no saved chains yet"),
							},
						],
					};
				}
				case "run_agent": {
					if (!p.prompt) return { content: [{ type: "text", text: "run_agent needs a prompt" }] };
					const { text, passed, iters } = await drive(
						{
							prompt: p.prompt,
							agent: p.agent,
							model: resolveRoleModel(pi, p.model || "", p.agent || "", p.prompt || ""),
							verify: p.verify,
							assert: p.assert,
						},
						"",
						"",
						p.max_iters || MAX_ITERS,
						cwd,
						noop,
					);
					return {
						content: [
							{
								type: "text",
								text:
									(p.verify ? `[${passed ? "verified" : `NOT verified after ${iters} tries`}] ` : "") + text,
							},
						],
					};
				}
				case "run_chain":
				case "orchestrate": {
					const chains = discoverChains(cwd);
					const chain = chains[p.chain];
					if (!chain)
						return { content: [{ type: "text", text: `no chain '${p.chain}' — delegate {action:"list"}` }] };
					const { prior, stuck } = await runChainStages(
						chain.steps,
						String(p.task ?? ""),
						cwd,
						p.action === "orchestrate",
						noop,
					);
					return {
						content: [{ type: "text", text: (stuck.length ? `[stuck: ${stuck.join(", ")}]\n` : "") + prior }],
					};
				}
				case "pull": {
					if (!p.handle)
						return {
							content: [
								{
									type: "text",
									text: "pull needs a handle (from a capped worker return's [delegate: … Pull …] note)",
								},
							],
						};
					return { content: [{ type: "text", text: pullHandle(String(p.handle), String(p.path ?? "")) }] };
				}
				case "create_chain": {
					const name = String(p.name || "").replace(/[^a-z0-9-]/gi, "-");
					if (!name || !Array.isArray(p.steps) || !p.steps.length)
						return { content: [{ type: "text", text: "create_chain needs name + steps" }] };
					writeChain(name, p.steps, cwd, p.description);
					return {
						content: [
							{
								type: "text",
								text: `saved chain '${name}' (${p.steps.length} stages). run: delegate {action:"orchestrate", chain:"${name}", task:"…"}`,
							},
						],
					};
				}
				default:
					return { content: [{ type: "text", text: 'unknown action — delegate {action:"list"}' }] };
			}
		},
	});

	// Thin command wrappers (commands don't cost prefix tokens — only tool schemas do).
	pi.registerCommand("delegate", {
		description: "Delegate: /delegate <chain> <task> (orchestrate a saved chain)",
		handler: async (args: string, ctx: any) => {
			const [chain, ...rest] = (args || "").trim().split(/\s+/);
			const task = rest.join(" ");
			if (!chain || !task) {
				const chains = discoverChains(process.cwd());
				ctx.ui.notify(
					`Usage: /delegate <chain> <task>. Saved: ${Object.keys(chains).join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			const chains = discoverChains(process.cwd());
			if (!chains[chain]) {
				ctx.ui.notify(`No chain '${chain}'.`, "warning");
				return;
			}
			ctx.ui.notify(`Orchestrating '${chain}'…`, "info");
			const { prior, stuck } = await runChainStages(chains[chain].steps, task, process.cwd(), true, (m) =>
				ctx.ui.notify(m, "info"),
			);
			ctx.ui.notify(
				stuck.length ? `Done, ${stuck.length} stuck: ${stuck.join(", ")}` : "✓ completed",
				stuck.length ? "warning" : "info",
			);
			return prior;
		},
	});
}
