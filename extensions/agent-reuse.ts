import {
	type BackgroundProcessSnapshot,
	type ExtensionAPI,
	getBackgroundProcessRegistry,
} from "@earendil-works/pi-coding-agent";

const MAX_REUSABLE_AGENTS = 8;
const MAX_SCOPE_CHARS = 180;

function compactScope(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > MAX_SCOPE_CHARS ? `${compact.slice(0, MAX_SCOPE_CHARS - 1)}…` : compact;
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function reusableAgentContext(snapshots: BackgroundProcessSnapshot[], parentId: string): string | undefined {
	const reusable = snapshots
		.filter(
			(entry) =>
				entry.kind === "subagent" &&
				(entry.status === "idle" || entry.status === "parked") &&
				entry.parentId === parentId &&
				entry.canSteer,
		)
		.slice(0, MAX_REUSABLE_AGENTS);
	if (reusable.length === 0) return undefined;

	const rows = reusable.map((entry) => {
		const type = escapeXml(entry.agentType ?? "agent");
		const scope = escapeXml(compactScope(entry.summary ?? entry.label));
		return `- id=${entry.id} type=${type} status=${entry.status} prior-scope="${scope}"`;
	});
	return [
		"<reusable-agents>",
		"These subagents already retain their prior task context:",
		...rows,
		"Before spawning, use agent_message with the existing id when its prior scope matches the new work. Reuse is based on scope, not agent type alone. Spawn a fresh agent for unrelated work or when independent fresh eyes are required.",
		"</reusable-agents>",
	].join("\n");
}

export default function agentReuse(pi: ExtensionAPI): void {
	pi.on("context", async (event, ctx) => {
		const parentId = ctx.sessionManager.getSessionId();
		const block = reusableAgentContext(getBackgroundProcessRegistry().list(), parentId);
		if (!block) return;
		return {
			messages: [
				...event.messages,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: block }],
					timestamp: Date.now(),
				},
			],
		};
	});
}
