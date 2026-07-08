/**
 * permissions.ts — glob-granular allow/ask/deny + doom-loop guard.
 *
 * Closes the permission-granularity gap (opencode's standout: per-input glob rules
 * + a runaway-loop guard, finer than our coarse gates). Rules match against a
 * "tool:input-signature" string with globs; first matching rule wins:
 *   deny  → block outright (never runs)
 *   ask   → block with a draft→confirm reason (like our gates)
 *   allow → explicitly permit (short-circuits later deny — an allowlist)
 *
 * This LAYERS UNDER guardrails/gates: those handle the semantic safety cases
 * (secrets, destructive ops, brain writes); this adds user-configurable
 * fine-grained policy on top, plus the loop guard neither had.
 *
 * Declared read/write/exec TIER (rank 22): the DEFAULT layer UNDER the glob rules.
 * Every tool is classified read | write | exec by verb/annotation; the tier says
 * which classes need confirm (default: write+exec gated, read free). This closes
 * the hole where gates.ts's MCP_MUTATING regex misses a mutating tool whose verb
 * isn't listed — here an UNKNOWN/unannotated tool defaults to write/exec = gated
 * (fail-closed). Explicit glob rules (allow/ask/deny) still WIN over the tier, so
 * you can allowlist a safe tool the classifier is conservative about. Confirmed
 * calls (confirm:true) and read-class tools pass. Gate: KP_PERM_TIER=0 to disable.
 *
 * Config: .pi/permissions.json (project) over ~/.pi/agent/pi-harness/permissions.json:
 *   {
 *     "rules": [
 *       {"match": "bash:* rm -rf *", "action": "deny"},
 *       {"match": "bash:git push*",  "action": "ask"},
 *       {"match": "bash:npm test*",  "action": "allow"},
 *       {"match": "write:*.env",     "action": "deny"}
 *     ],
 *     "doomLoop": 5
 *   }
 * match = "<tool>:<signature>" glob; signature = command (bash) / path (file tools)
 * / JSON of input (others). In-pi editable: /perm add|list|remove.
 *
 * Config env: KP_PERM_ENABLED=0 disable.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Layered gating. The rule-driven guards are opt-in (zero-friction), BUT the declared
// read/write/exec tier is ON by default and DOES gate out of the box:
//   declared tier (KP_PERM_TIER, default ON) → write/exec-class tools with no matching
//     rule require a draft→confirm; read-class passes; unknown/unannotated tools default
//     to write (fail-closed). Explicit rules override the tier. Disable with KP_PERM_TIER=0.
//   rules: []           → your allow/ask/deny (opt-in per rule; run BEFORE the tier)
//   doomLoop: 0         → loop guard OFF (default); set N to enable
//   externalDir: false  → external-dir bash guard OFF (default); true to enable
// (The tier self-suppresses in a headless delegate child so it never wedges on an
//  unconfirmable ask — DENY still applies there.)
const ENABLED = process.env.KP_PERM_ENABLED !== "0";
// Declared tier default-ON; the tier only ADDS gating for write/exec-class tools
// that no explicit rule covered. Off → pre-tier behavior (rules + guards only).
// A headless DELEGATE child (A2A_ID set, no TTY) would WEDGE on a tier ask it can't
// confirm — and editing IS its job, already vetted at delegation — so the tier
// self-suppresses there. DENY rules still apply in the child (they hard-block, no
// confirm needed), so deny inheritance is preserved. KP_PERM_TIER_CHILD=1 forces
// the tier back on in children if you really want it.
const IS_DELEGATE_CHILD = !!process.env.A2A_ID && !process.stdout.isTTY;
const TIER = process.env.KP_PERM_TIER !== "0" && (!IS_DELEGATE_CHILD || process.env.KP_PERM_TIER_CHILD === "1");
const USER_CFG = join(homedir(), ".pi", "agent", "pi-harness", "permissions.json");

type Action = "allow" | "ask" | "deny";
type Rule = { match: string; action: Action; re?: RegExp };
type Config = { rules: Rule[]; doomLoop: number; externalDir: boolean };

// --- declared read/write/exec tier ---------------------------------------------
type TierClass = "read" | "write" | "exec";

// Known-safe READ tools (harness + common MCP verbs): never gated by the tier.
const READ_TOOLS =
	/^(read|hread|glob|grep|ls|find|scope|codemap_|knowledge_(search|ask|code_search|find_code|trace|neighbors|resolve|coverage|gaps|timeline|list|facts|episode|document|community|members|stale|converse)|check_file|find_references|tokens|context|cache|list|get|show|view|search|read_|fetch|inspect|describe|status|diff|log)/i;
// Known WRITE-class tools (mutate state): gated unless confirmed / rule-allowed.
const WRITE_TOOLS =
	/^(write|edit|hedit|multiedit|apply_patch|str_replace|create_file|rename_symbol|delete|remove|knowledge_(remember|ingest|correct|confirm|reject|link|register|update|index|remove|resolve_|relate|set_|build_|map_))/i;
// EXEC-class: runs commands / spawns. Always gated by the tier unless confirmed.
const EXEC_TOOLS = /^(bash|shell|exec|run|delegate|sandbox|a2a)/i;
// MCP proxy verbs that mutate — same discipline as gates.ts's MCP_MUTATING, but
// used here as the fail-closed DEFAULT: a proxy tool whose verb ISN'T clearly
// read-only is treated as write. (verbs like create/update/delete/send/publish/…)
const MCP_MUTATING =
	/(^|_)(create|update|delete|add|remove|set|write|edit|put|post|patch|transition|move|assign|close|merge|purge|drop|insert|upsert|rename|archive|restore|revoke|grant|send|publish|comment|worklog|ingest|index|build|link|register|reject|confirm|correct)(_|$)/i;
const MCP_READONLY =
	/(^|_)(get|list|search|read|fetch|show|view|describe|inspect|status|find|query|resolve|ask|trace|coverage|gaps|timeline|neighbors)(_|$)/i;

// Classify a tool call into read | write | exec. Fail-closed: anything not clearly
// read (unknown / unannotated) is treated as write so it gets gated by default.
function classify(toolName: string, input: any): TierClass {
	const t = toolName || "";
	if (EXEC_TOOLS.test(t)) return "exec";
	// MCP proxy call ({tool, arguments}) — classify by the proxied verb.
	if (/_mcp$/.test(t) && input?.tool) {
		if (input?.list) return "read"; // catalog listing
		const v = String(input.tool);
		if (MCP_MUTATING.test(v)) return "write";
		if (MCP_READONLY.test(v)) return "read";
		return "write"; // unannotated MCP verb → fail-closed to write
	}
	if (WRITE_TOOLS.test(t)) return "write";
	if (READ_TOOLS.test(t)) return "read";
	// Annotation hint if pi/MCP surfaced one; else fail-closed to write.
	if (input?.readOnlyHint === true) return "read";
	return "write";
}

function globToRe(glob: string): RegExp {
	// tool:signature glob — * = any run of chars (incl. spaces/paths), ? = one char.
	let re = "";
	for (const ch of glob) {
		if (ch === "*") re += ".*";
		else if (ch === "?") re += ".";
		else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

function loadConfig(cwd: string): Config {
	// Zero-friction defaults: no rules, guards OFF. You opt in.
	const cfg: Config = { rules: [], doomLoop: 0, externalDir: false };
	for (const p of [USER_CFG, join(cwd, ".pi", "permissions.json")]) {
		try {
			const raw = JSON.parse(readFileSync(p, "utf-8"));
			if (Array.isArray(raw.rules))
				for (const r of raw.rules) if (r.match && r.action) cfg.rules.push({ match: r.match, action: r.action });
			if (typeof raw.doomLoop === "number") cfg.doomLoop = raw.doomLoop;
			if (typeof raw.externalDir === "boolean") cfg.externalDir = raw.externalDir;
		} catch {}
	}
	for (const r of cfg.rules) r.re = globToRe(r.match);
	return cfg;
}

// build the "<tool>:<signature>" string a rule matches against
function signature(toolName: string, input: any): string {
	let sig: string;
	if (toolName === "bash") sig = String(input?.command ?? "");
	else if (input?.path || input?.file_path) sig = String(input.path ?? input.file_path);
	else if (input?.tool)
		sig = `${input.tool} ${JSON.stringify(input.arguments ?? {})}`; // proxy calls
	else sig = JSON.stringify(input ?? {});
	return `${toolName}:${sig}`;
}

export default function (pi: any) {
	if (!ENABLED) return;

	let cfg = loadConfig(process.cwd());
	const recent: string[] = []; // rolling window of signatures for doom-loop
	let denied = 0,
		asked = 0,
		looped = 0,
		tiered = 0;
	// A confirmed call clears the tier gate for the same signature within a session,
	// so a child that retried with confirm:true isn't re-gated on identical repeats.
	const tierConfirmed = new Set<string>();

	pi.on("session_start", async () => {
		cfg = loadConfig(process.cwd());
	});

	pi.on("tool_call", async (event: any) => {
		const sig = signature(event.toolName, event.input);

		// --- doom-loop guard (OFF by default; set doomLoop:N to enable). Beats
		// opencode's naive exact-3: catches identical repeats AND A/B/A/B alternation. ---
		if (cfg.doomLoop > 0) {
			recent.push(sig);
			if (recent.length > cfg.doomLoop * 2 + 2) recent.shift();
			const N = cfg.doomLoop;
			const tailN = recent.slice(-N);
			const identical = tailN.length === N && tailN.every((s) => s === sig);
			const tail2N = recent.slice(-N * 2);
			const distinct = new Set(tail2N);
			const alternating = tail2N.length >= N * 2 && distinct.size <= 2 && distinct.has(sig);
			if (identical || alternating) {
				looped++;
				recent.length = 0; // reset so a deliberate retry isn't instantly re-blocked
				return {
					block: true,
					reason:
						`Doom-loop guard: ${identical ? `the same call (${event.toolName}) ran ${N}× identically` : `you're cycling between the same ${distinct.size} calls`} — not making progress. ` +
						`Change approach, or tell the user you're stuck (ask_user).`,
				};
			}
		}

		// --- external_directory boundary (OFF by default; externalDir:true to enable).
		// A bash command touching a path OUTSIDE the workspace raises a distinct ask. ---
		if (cfg.externalDir && event.toolName === "bash" && !event.input?.confirm) {
			const cmd = String(event.input?.command ?? "");
			const cwd = process.cwd();
			// path-like tokens that escape cwd (absolute paths not under cwd, or ../ climbs)
			const escapes = [...cmd.matchAll(/(?:^|\s)((?:\/|~\/|\.\.\/)[^\s"';|&]+)/g)]
				.map((m) => m[1])
				.filter((p) => {
					const abs = p.startsWith("~") ? p.replace("~", homedir()) : p.startsWith("/") ? p : join(cwd, p);
					return (
						!abs.startsWith(cwd) &&
						!abs.startsWith("/tmp") &&
						!abs.startsWith("/var/folders") &&
						!abs.startsWith("/dev/null") &&
						!abs.startsWith("/usr") &&
						!abs.startsWith("/bin")
					);
				});
			if (escapes.length) {
				return {
					block: true,
					reason: `External-directory access: this bash command touches paths outside the workspace (${escapes.slice(0, 2).join(", ")}). Confirm it's intended; retry with confirm:true.`,
				};
			}
		}

		// --- rule matching: first match wins (explicit rules override the tier) ---
		for (const r of cfg.rules) {
			if (!r.re!.test(sig)) continue;
			if (r.action === "allow") return; // explicit allow short-circuits
			if (r.action === "deny") {
				denied++;
				return { block: true, reason: `Permission DENY rule '${r.match}' — this call is not allowed here.` };
			}
			if (r.action === "ask" && !event.input?.confirm) {
				asked++;
				return {
					block: true,
					reason: `Permission ASK rule '${r.match}'. Show the user what this does; on approval retry with confirm:true.`,
				};
			}
			return; // ask + confirmed → allow
		}

		// --- declared read/write/exec TIER (DEFAULT layer, under the glob rules) ---
		// No explicit rule matched. Classify the call; write/exec-class tools are gated
		// (ask-tier) unless already confirmed — read-class passes. Unknown/unannotated
		// tools fail closed to write, so a mutating tool the MCP_MUTATING regex misses
		// is STILL gated here. Fires only in headless/non-confirmed; a TUI confirm or a
		// confirm:true retry clears it. Never wedges: it's a one-shot draft→confirm
		// block (same contract as gates/ask rules), and the doom-loop guard above
		// catches infinite identical retries.
		if (TIER) {
			const klass = classify(event.toolName, event.input);
			if (klass !== "read") {
				if (event.input?.confirm) {
					tierConfirmed.add(sig);
					return;
				}
				if (tierConfirmed.has(sig)) return; // already approved this exact call
				tiered++;
				return {
					block: true,
					reason:
						`Permission tier: '${event.toolName}' is ${klass}-class (mutates/executes) and no allow rule covers it. ` +
						`This is the fail-closed default for un-allowlisted write/exec tools. Show the user what it will do; ` +
						`on approval retry the SAME call with confirm:true — or add an allow rule: /perm add allow ${event.toolName}:*`,
				};
			}
		}
	});

	pi.registerCommand("perm", {
		description: "Permission rules: /perm list · /perm add <allow|ask|deny> <tool:glob> · /perm remove <n>",
		handler: async (args: string, ctx: any) => {
			const [sub, action, ...rest] = (args || "").trim().split(/\s+/);
			const path = join(process.cwd(), ".pi", "permissions.json");
			if (!sub || sub === "list") {
				ctx.ui.notify(
					(cfg.rules.length
						? "Rules (first match wins):\n" +
							cfg.rules.map((r, i) => `  ${i}. ${r.action.toUpperCase().padEnd(5)} ${r.match}`).join("\n")
						: "No rules.") +
						`\ntier: ${TIER ? "ON (write/exec gated by default, read free)" : "off"} · doom-loop: ${cfg.doomLoop}×` +
						`\nthis session: ${denied} denied, ${asked} asked, ${tiered} tier-gated, ${looped} loop-blocked\n` +
						`explicit rules override the tier; all layers under guardrails/gates. Config: ${path}`,
					"info",
				);
				return;
			}
			if (sub === "add") {
				const match = rest.join(" ");
				if (!["allow", "ask", "deny"].includes(action) || !match) {
					ctx.ui.notify(
						"Usage: /perm add <allow|ask|deny> <tool:glob>  e.g. /perm add deny bash:* rm -rf *",
						"warning",
					);
					return;
				}
				let raw: any = {};
				try {
					raw = JSON.parse(readFileSync(path, "utf-8"));
				} catch {}
				raw.rules ??= [];
				raw.rules.push({ match, action });
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
				cfg = loadConfig(process.cwd());
				ctx.ui.notify(`Added: ${action.toUpperCase()} ${match}`, "info");
				return;
			}
			if (sub === "remove") {
				const n = Number(action);
				try {
					const raw = JSON.parse(readFileSync(path, "utf-8"));
					if (raw.rules?.[n]) {
						const [rm] = raw.rules.splice(n, 1);
						writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
						cfg = loadConfig(process.cwd());
						ctx.ui.notify(`Removed: ${rm.action} ${rm.match}`, "info");
					} else ctx.ui.notify(`No rule ${n}.`, "warning");
				} catch {
					ctx.ui.notify("No permissions.json.", "warning");
				}
				return;
			}
			ctx.ui.notify("Usage: /perm list · /perm add <allow|ask|deny> <tool:glob> · /perm remove <n>", "warning");
		},
	});
}
