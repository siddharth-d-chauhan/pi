/**
 * agent_message — A2A messaging between the main session and subagents.
 *
 * Delivery goes through the lifecycle matrix (core/agents/lifecycle.ts):
 * running agents get the message queued as a follow-up, idle agents are
 * woken with a real turn (and their reply returned), parked agents are
 * revived from their session file first. Messages to "main" are injected
 * visibly and trigger/follow up the parent conversation.
 *
 * Completed agents stay addressable — prefer messaging an existing agent
 * that already has context over spawning a fresh one.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentSession } from "../agent-session.ts";
import {
	deliverToAgent,
	getAgentLifecycle,
	listLifecycleAgents,
	type QueuedDeliveryOutcome,
} from "../agents/lifecycle.ts";
import { deliverAgentNotification } from "../agents/notifications.ts";
import { getBackgroundProcessRegistry } from "../background-process-registry.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const agentMessageSchema = Type.Object({
	to: Type.String({
		description:
			'Recipient: a subagent registry id (bg-…, from spawn results/notifications) or "main" for your parent session.',
	}),
	message: Type.String({ description: "The message to deliver." }),
	wait: Type.Optional(
		Type.Boolean({
			description:
				"Wait for the recipient's reply (idle/parked agents only — busy agents always queue). Default true.",
		}),
	),
	requiresInput: Type.Optional(
		Type.Boolean({
			description:
				"Set true only when messaging main because work cannot continue without a user/parent answer. The question is shown prominently in the main transcript.",
		}),
	),
});

export type AgentMessageInput = Static<typeof agentMessageSchema>;

export interface AgentMessageDetails {
	to: string;
	receipt: "queued" | "replied" | "failed";
	reply?: string;
	reason?: string;
}

export interface CreateAgentMessageToolOptions {
	/** How this sender is identified to recipients (e.g. "main" or "reviewer(bg-…)"). */
	selfLabel: string;
	/** The spawner's session, when this instance belongs to a child agent. */
	parentSession?: AgentSession;
	/** Registry id of this child, used to expose an explicit input request. */
	selfRegistryId?: string;
	/** The session invoking this tool, used to return replies queued to busy agents. */
	senderSession?: AgentSession;
}

function gistOf(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

async function deliverQueuedReply(
	session: AgentSession,
	registryId: string,
	from: string,
	outcome: QueuedDeliveryOutcome,
): Promise<void> {
	const failed = "failed" in outcome;
	const body = failed ? `[queued message failed: ${outcome.failed}]` : outcome.reply || "(agent replied with no text)";
	await deliverAgentNotification(session, {
		customType: "agent-message",
		content:
			`<agent-message from="${from}" in-reply-to="queued">\n${body}\n</agent-message>\n\n` +
			"The background agent processed the queued message. Use this reply directly and continue the current task.",
		display: true,
		details: { from, registryId, status: failed ? "failed" : "replied" },
	});
}

export function createAgentMessageToolDefinition(
	opts: CreateAgentMessageToolOptions,
): ToolDefinition<typeof agentMessageSchema, AgentMessageDetails> {
	return {
		name: "agent_message",
		label: "message",
		description:
			"Send a message to a subagent or (from a subagent) to your parent session. " +
			"Idle and parked agents are woken/revived and run a turn; with wait=true (default) their reply is returned. " +
			"Busy agents get the message queued for their next step. " +
			"Prefer messaging an existing agent that already has context over spawning a new one.",
		promptSnippet: "Message a subagent (or your parent) — agents stay addressable after finishing",
		parameters: agentMessageSchema,
		async execute(_toolCallId, args: AgentMessageInput, signal?: AbortSignal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const to = args.to.trim();

			if (to === "main" || to === "parent") {
				if (!opts.parentSession) {
					throw new Error('You ARE the main session — use a subagent registry id (bg-…) as "to".');
				}
				if (args.requiresInput && opts.selfRegistryId) {
					getBackgroundProcessRegistry().update(opts.selfRegistryId, { inputRequest: args.message });
				}
				await deliverAgentNotification(
					opts.parentSession,
					{
						customType: args.requiresInput ? "agent-question" : "agent-message",
						content:
							`<agent-message from="${opts.selfLabel}">\n${args.message}\n</agent-message>\n\n` +
							(args.requiresInput
								? `The agent is waiting for input. Ask the user if necessary, then answer with agent_message to ${opts.selfRegistryId}.`
								: "Reply (if needed) with the agent_message tool."),
						display: true,
						details: { from: opts.selfLabel, registryId: opts.selfRegistryId, requiresInput: args.requiresInput },
					},
					{ triggerWhenIdle: !args.requiresInput },
				);
				return {
					content: [{ type: "text", text: "Message queued for the parent session's next turn." }],
					details: { to: "main", receipt: "queued" as const },
				};
			}

			const target = getAgentLifecycle(to);
			if (!target) {
				const known = listLifecycleAgents()
					.map((entry) => `${entry.registryId} (${entry.agentType}, ${entry.state})`)
					.join(", ");
				throw new Error(`Unknown agent "${to}". Known agents: ${known.length > 0 ? known : "none"}.`);
			}

			getBackgroundProcessRegistry().update(to, { inputRequest: undefined });
			const senderSession = opts.senderSession;
			const receipt = await deliverToAgent(to, args.message, {
				from: opts.selfLabel,
				awaitReply: args.wait !== false,
				onQueuedReply: senderSession
					? (outcome) => deliverQueuedReply(senderSession, to, `${target.agentType}(${to})`, outcome)
					: undefined,
			});
			switch (receipt.status) {
				case "replied":
					return {
						content: [{ type: "text", text: receipt.reply || "(agent replied with no text)" }],
						details: { to, receipt: "replied" as const, reply: receipt.reply },
					};
				case "queued":
					return {
						content: [
							{
								type: "text",
								text: `Message queued for ${to} (agent is busy — it will see it at its next step). Do not poll.`,
							},
						],
						details: { to, receipt: "queued" as const },
					};
				case "failed":
					throw new Error(`Delivery to ${to} failed: ${receipt.reason}`);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const target = getAgentLifecycle(args.to)?.agentType ?? args.to;
			text.setText(
				`${theme.fg("toolTitle", theme.bold("message"))} ${theme.fg("accent", "→")} ${theme.fg("accent", target)} ${theme.fg("dim", gistOf(args.message))}`,
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const details = result.details as AgentMessageDetails | undefined;
			if (details?.receipt === "replied" && details.reply) {
				const lines = details.reply.split("\n").slice(0, 8);
				text.setText(lines.map((line) => theme.fg("toolOutput", `  ${line}`)).join("\n"));
			} else {
				const fallback = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				text.setText(theme.fg("dim", fallback));
			}
			return text;
		},
	};
}

export function createAgentMessageTool(opts: CreateAgentMessageToolOptions): AgentTool<typeof agentMessageSchema> {
	return wrapToolDefinition(createAgentMessageToolDefinition(opts));
}
