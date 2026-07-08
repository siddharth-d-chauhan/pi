/**
 * gates.ts — harness-enforced gate policy (CLAUDE.md "Gates": no auto-commit,
 * no auto-post; state mutations are draft → confirm).
 *
 * pi deliberately ships no permission popups; the sanctioned seam is the
 * tool_call event, which can block a call before execution. This enforces the
 * gate in the harness rather than trusting prompt discipline: a blocked call
 * returns a reason instructing the model to present a draft and ask the user,
 * who re-runs with the confirm marker.
 */

const GATED_BASH = [
	/\bgit\s+(commit|push|tag|reset\s+--hard|rebase)\b/,
	/\bgh\s+(pr|issue|release)\s+(create|merge|edit|close)\b/,
	/\b(pip|npm|uv|yarn|pnpm)\s+(install|add|remove|uninstall)\b/,
	/\bdocker\s+(rm|rmi|compose\s+down)\b/,
];

// MCP proxy mutation classifier — must match mcp.ts's MUTATING regex, since a
// generic MCP tool has no formal read/write flag. Name implies state change → gate.
const MCP_MUTATING =
	/(^|_)(create|update|delete|add|remove|set|write|edit|put|post|patch|transition|move|assign|close|merge|purge|drop|insert|upsert|rename|archive|restore|revoke|grant|send|publish|comment|worklog)(_|$)/i;

// KP mutating tools (only mounted when KP_PI_ALLOW_WRITE=1) are gated too.
const GATED_TOOL_PREFIXES = [
	"knowledge_ingest",
	"knowledge_remember",
	"knowledge_correct",
	"knowledge_reject",
	"knowledge_remove",
	"knowledge_register_repo",
	"knowledge_update_repo",
];

// Accept BOTH "CONFIRM foo" and "CONFIRM:foo". The user-facing message
// used to say "prefixed with CONFIRM" but the code only matched the colon
// form, so users who typed `CONFIRM cmd` silently re-hit the gate. The
// gate itself is unchanged; only the marker recognition is colon-optional.
const CONFIRM_RE = /^\s*CONFIRM:?\s+/i;
const CONFIRM_DISPLAY = "CONFIRM (or CONFIRM: cmd)";

// Secrets must never reach persistence (brain writes). Pure-code scan, no LLM.
const SECRET_PATTERNS: [string, RegExp][] = [
	["API key", /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/],
	["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
	["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i],
	["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
	["generic secret assignment", /\b(?:api[_-]?key|secret|token|password)\b\s*[=:]\s*['"][^'"]{12,}['"]/i],
];

function findSecret(value: unknown): string | null {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) return label;
	return null;
}

export default function (pi: any) {
	pi.on("tool_call", async (event: any) => {
		const { toolName, input } = event;

		if (toolName === "bash") {
			const cmd: string = input?.command ?? "";
			if (CONFIRM_RE.test(cmd)) {
				// Strip the marker and let it through — user has confirmed.
				event.input.command = cmd.replace(CONFIRM_RE, "").trim();
				return;
			}
			if (GATED_BASH.some((re) => re.test(cmd))) {
				return {
					block: true,
					reason:
						`Gated action. Show the user exactly what would run and why, as a draft. ` +
						`Only after the user explicitly approves, re-run the command prefixed with ${CONFIRM_DISPLAY}`,
				};
			}
		}

		// Secret scan on ANY brain write — even a confirmed one never persists a credential.
		if (toolName.startsWith("knowledge_")) {
			const hit = findSecret(input);
			if (hit) {
				return {
					block: true,
					reason: `Blocked: payload appears to contain a ${hit}. Secrets are never persisted to the brain — redact it and retry.`,
				};
			}
		}

		// knowledge_write proxy: every ACTUAL call is a mutation — gate on confirm.
		// A {list:true} discovery call isn't a mutation, so don't gate it.
		if (toolName === "knowledge_write" && !input?.list && input?.tool && !input?.confirm) {
			return {
				block: true,
				reason:
					"Gated brain mutation. Show the user the draft (tool + arguments); on explicit approval, retry the same call with confirm: true.",
			};
		}

		// Individually-mounted write tools (KP_PI_MOUNT=all) gate by name prefix.
		if (GATED_TOOL_PREFIXES.some((p) => toolName.startsWith(p)) && !input?.confirm) {
			return {
				block: true,
				reason:
					"Gated brain mutation. Present the draft payload to the user; on explicit approval, retry with confirm: true.",
			};
		}

		// MCP proxy (mcp.ts) mutating calls: a <server>_mcp call whose target tool name
		// implies a state change (create/update/delete/transition/comment/…) is an
		// external side effect — draft→confirm, same as everything else.
		if (/_mcp$/.test(toolName) && !input?.list && input?.tool && !input?.confirm && MCP_MUTATING.test(input.tool)) {
			return {
				block: true,
				reason:
					`Gated MCP mutation (${input.tool}). This writes to an external service. Show the user the draft ` +
					`(tool + arguments); on explicit approval, retry the same call with confirm: true.`,
			};
		}
	});
}

// # FIX_CONFIRM_RE
