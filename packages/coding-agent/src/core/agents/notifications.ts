import type { AgentSession } from "../agent-session.ts";
import type { CustomMessage } from "../messages.ts";

/** Deliver an asynchronous agent event visibly and to the model. */
export async function deliverAgentNotification<T>(
	session: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options: { triggerWhenIdle?: boolean } = {},
): Promise<void> {
	if (session.isStreaming) {
		await session.sendCustomMessage(message, { deliverAs: "followUp" });
		return;
	}
	await session.sendCustomMessage(message, { triggerTurn: options.triggerWhenIdle ?? true });
}
