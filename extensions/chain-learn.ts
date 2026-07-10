/**
 * Chain-Learn Extension — feed chain gate outcomes into the knowledge
 * platform as machine-labeled writeback evidence (plan §22.9 gate lane).
 *
 * A chain stage that PASSES a `verify` gate is a verified result: its work
 * is real, proven by a command. A stage that runs a `judge` and the chain
 * still completes is human-adjacent evidence. Both are exactly the
 * "supported" evidence class the broker's writeback wants — so when a chain
 * finishes, its passing gated stages are written back as verified_fix
 * memories (machine evidence -> supported -> eligible for future recall).
 *
 * Strictly opt-in-by-signal and fail-open: only stages with an explicitly
 * configured and successfully completed gate are recorded; no KP = no-op.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface KpShared {
	connect: () => Promise<{
		callTool: (
			req: { name: string; arguments: Record<string, unknown> },
			schema?: undefined,
			opts?: { timeout?: number },
		) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
	}>;
}

interface StageResult {
	id: string;
	agent: string;
	status?: string;
	gateConfigured?: boolean;
	gatePassed?: boolean;
	verifyAttempts?: number;
	inline?: string;
}

interface ChainDetails {
	chain?: string;
	status?: string;
	stages?: StageResult[];
}

const WRITE_TIMEOUT_MS = 4_000;

export default function (pi: ExtensionAPI) {
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== "chain") return;
		const shared = (globalThis as Record<string, unknown>).__pi_kp__ as KpShared | undefined;
		if (!shared) return;
		const details = (event.result as { details?: ChainDetails })?.details;
		if (!details || details.status !== "completed" || !Array.isArray(details.stages)) return;

		// Only explicitly configured, passing gates carry machine evidence.
		const gated = details.stages.filter(
			(stage) =>
				stage.status === "completed" && stage.gateConfigured === true && stage.gatePassed === true && stage.inline,
		);
		if (gated.length === 0) return;

		try {
			const client = await shared.connect();
			for (const stage of gated) {
				const summary = `chain "${details.chain}" stage "${stage.id}" (${stage.agent}) passed its gate`;
				const body = String(stage.inline)
					.replace(/\n*_agentId: [^\n]*_\s*$/, "")
					.slice(0, 800);
				await client.callTool(
					{
						name: "pi.memory_writeback",
						arguments: {
							kind: "verified_fix",
							summary,
							text: body,
							evidence: {
								gates: [
									`chain ${details.chain}.${stage.id} gate passed (verifyAttempts ${stage.verifyAttempts})`,
								],
							},
						},
					},
					undefined,
					{ timeout: WRITE_TIMEOUT_MS },
				);
			}
		} catch {
			// fail-open: learning is best-effort, never blocks the chain result
		}
	});
}
