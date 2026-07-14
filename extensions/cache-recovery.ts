import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MIN_PROMPT_TOKENS = Number(process.env.PI_CACHE_RECOVERY_MIN_PROMPT_TOKENS ?? 80_000);
const TASK_SHIFT_MIN_TOKENS = Number(process.env.PI_TASK_SHIFT_COMPACTION_MIN_TOKENS ?? 80_000);
const MIDRUN_CONTEXT_CEILING = Number(process.env.PI_MIDRUN_COMPACTION_TOKENS ?? 160_000);
const HEALTHY_CACHE_RATIO = Number(process.env.PI_CACHE_HEALTHY_RATIO ?? 0.5);
const COLLAPSED_CACHE_RATIO = Number(process.env.PI_CACHE_COLLAPSED_RATIO ?? 0.1);

interface CacheUsageMessage {
	role: string;
	stopReason?: string;
	usage?: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

function cacheRatio(message: CacheUsageMessage): { promptTokens: number; ratio: number } | undefined {
	const usage = message.usage;
	if (!usage) return undefined;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return { promptTokens, ratio: usage.cacheRead / promptTokens };
}

export default function cacheRecovery(pi: ExtensionAPI): void {
	let sawHealthyLargeCache = false;
	let recoveryPending: "cache_collapse" | "task_shift" | "context_ceiling" | undefined;
	let recoveryRunning = false;

	const reset = () => {
		sawHealthyLargeCache = false;
		recoveryPending = undefined;
		recoveryRunning = false;
	};

	pi.on("session_start", async () => reset());
	pi.on("session_compact", async () => reset());

	pi.on("message_end", async (event) => {
		const message = event.message as CacheUsageMessage;
		if (message.role !== "assistant") return;
		const cache = cacheRatio(message);
		if (!cache || cache.promptTokens < MIN_PROMPT_TOKENS) return;
		if (cache.ratio >= HEALTHY_CACHE_RATIO) {
			sawHealthyLargeCache = true;
			return;
		}
		if (
			sawHealthyLargeCache &&
			cache.ratio <= COLLAPSED_CACHE_RATIO &&
			message.stopReason === "toolUse" &&
			!recoveryRunning
		) {
			recoveryPending = "cache_collapse";
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "pi_context_shift" || event.isError || recoveryRunning) return;
		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && usage.tokens >= TASK_SHIFT_MIN_TOKENS && !recoveryPending) {
			recoveryPending = "task_shift";
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!recoveryPending && !recoveryRunning && MIDRUN_CONTEXT_CEILING > 0) {
			const usage = ctx.getContextUsage();
			if (usage?.tokens !== null && usage?.tokens !== undefined && usage.tokens >= MIDRUN_CONTEXT_CEILING) {
				recoveryPending = "context_ceiling";
			}
		}
		if (!recoveryPending || recoveryRunning) return;
		const reason = recoveryPending;
		recoveryPending = undefined;
		recoveryRunning = true;
		ctx.ui.setStatus(
			"cache-recovery",
			reason === "cache_collapse"
				? "prompt cache lost · compacting"
				: reason === "task_shift"
					? "task changed · compacting"
					: "context ceiling reached · compacting",
		);
		ctx.compact({
			customInstructions:
				reason === "cache_collapse"
					? "Prompt-cache continuity was lost during an active tool loop. Preserve the current task, verified findings, changed files, test results, and the next concrete action. Omit superseded discovery detail."
					: reason === "task_shift"
						? "The user changed task direction. Preserve completed work and any still-relevant constraints, but prioritize the new task and omit superseded discovery detail."
						: "The active tool loop reached the configured context ceiling. Preserve the current task, verified evidence, changed files, test results, unresolved blockers, and the next concrete action. Replace raw tool output and exploratory detail with concise findings so the resumed run does not rediscover them.",
			onComplete: () => {
				ctx.ui.setStatus("cache-recovery", undefined);
				sawHealthyLargeCache = false;
				recoveryRunning = false;
				pi.sendMessage(
					{
						customType: "cache-recovery",
						content:
							reason === "cache_collapse"
								? "Prompt cache continuity was lost, so Pi compacted the session before another full uncached request. Continue from the checkpoint without repeating completed discovery."
								: reason === "task_shift"
									? "The task direction changed, so Pi compacted superseded history. Continue with the new task from the checkpoint without repeating completed discovery."
									: "The active run reached its context ceiling, so Pi compacted and resumed from a concise checkpoint. Continue the same task without rereading completed evidence.",
						display: true,
					},
					{ triggerTurn: true, deliverAs: "nextTurn" },
				);
			},
			onError: (error) => {
				ctx.ui.setStatus("cache-recovery", undefined);
				recoveryRunning = false;
				ctx.ui.notify(`Cache recovery compaction failed: ${error.message}`, "warning");
			},
		});
	});
}
