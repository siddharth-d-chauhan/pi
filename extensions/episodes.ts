/**
 * Episodes — episodic memory close-out. The gap: sessions leave facts behind
 * only when something explicitly distilled them; the narrative ("what did we
 * work on, what changed") evaporated. This extension keeps a cheap mechanical
 * digest of the session and, on shutdown, writes it into the knowledge
 * platform as an `episode` (hot kind Episodic, machine evidence → supported),
 * where memory_search / recall / Graphiti mining can reach it later.
 *
 * Fail-open everywhere: no KP, no digest worth keeping (trivial sessions), or
 * a slow shutdown path must never block pi from exiting.
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callKp, extractPaths } from "./lib/kp-bridge.ts";

const WRITE_TIMEOUT_MS = Number(process.env.PI_KP_EPISODE_TIMEOUT_MS ?? 2_500);
/** Sessions with fewer meaningful signals than this are not worth an episode. */
const MIN_SIGNALS = Number(process.env.PI_EPISODE_MIN_SIGNALS ?? 3);

export default function (pi: ExtensionAPI) {
	const digest = {
		startedAt: Date.now(),
		prompts: [] as string[],
		files: new Set<string>(),
		toolCounts: new Map<string, number>(),
		written: false,
	};

	pi.on("before_agent_start", async (event) => {
		if (typeof event.prompt === "string" && event.prompt.trim() && !event.prompt.startsWith("/")) {
			if (digest.prompts.length < 12) digest.prompts.push(event.prompt.trim().slice(0, 140));
		}
	});

	pi.on("tool_execution_start", async (event) => {
		digest.toolCounts.set(event.toolName, (digest.toolCounts.get(event.toolName) ?? 0) + 1);
		if (digest.files.size < 25) {
			for (const p of extractPaths(event.args)) {
				// keep repo-relative-looking paths only; absolute noise stays out
				if (!p.startsWith("http") && p.length < 120) digest.files.add(p);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		if (digest.written) return;
		digest.written = true;
		const signals = digest.prompts.length + (digest.files.size > 0 ? 1 : 0);
		if (signals < MIN_SIGNALS) return; // trivial session — no episode
		const minutes = Math.max(1, Math.round((Date.now() - digest.startedAt) / 60_000));
		const repo = basename(process.cwd());
		const tools = [...digest.toolCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 6)
			.map(([n, c]) => `${n}×${c}`)
			.join(", ");
		const summary = `Session in ${repo} (${minutes}m): ${digest.prompts[0] ?? "(no prompt)"}`;
		const body = [
			`Asks (${digest.prompts.length}):`,
			...digest.prompts.map((p) => `- ${p}`),
			digest.files.size > 0 ? `Touched: ${[...digest.files].slice(0, 20).join(", ")}` : "",
			tools ? `Tools: ${tools}` : "",
		]
			.filter(Boolean)
			.join("\n");
		await callKp(
			"pi.memory_writeback",
			{
				kind: "episode",
				summary: summary.slice(0, 200),
				text: body.slice(0, 1_600),
				evidence: [{ kind: "command", command: "pi session digest (mechanical close-out)" }],
			},
			WRITE_TIMEOUT_MS,
		);
	});
}
