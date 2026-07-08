/**
 * context-economy.ts — mechanical guard against tool-output context bloat.
 *
 * The prompt policy (knowledge.ts) asks the model to filter output at the
 * source; this extension enforces the ceiling when it doesn't. Any tool result
 * whose text exceeds the cap is externalized to a file; what enters context is a
 * head+tail excerpt plus the path and recovery instructions (rg / bounded read).
 *
 * IMPORTANT — deliberate reads aren't gutted: a file you CHOSE to read (read/
 * hread/cat/view) gets a much higher cap (READ_MAX) than incidental tool spew
 * (bash dumps etc., MAX_CHARS). Below that higher cap a read passes through whole.
 * When anything IS capped, the excerpt LOUDLY warns that the middle was elided
 * and how to recover it — so a "the answer was in the middle" case is visible,
 * never silent. Knowledge bundles and edit/write are fully exempt.
 *
 * Config: KP_ECON_MAX (incidental cap, default 30k) · KP_ECON_READ_MAX (deliberate
 *   read cap, default 120k ~30k tok) · KP_ECON_OFF=1 disable.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OFF = process.env.KP_ECON_OFF === "1";
const MAX_CHARS = Number(process.env.KP_ECON_MAX || 30_000); // incidental output (~7.5k tok)
const READ_MAX = Number(process.env.KP_ECON_READ_MAX || 120_000); // deliberate file reads (~30k tok)
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 4_000;
// Fully exempt: brain bundles (compact by design) + edit/write (UI/session logic).
const EXEMPT = /^(knowledge_|edit$|write$)/;
// Deliberate file reads — a file you CHOSE to open. Gets the generous READ_MAX cap.
const IS_READ = /(^|_)(read|hread|cat|view|open|fetch_content|get_search_content)$/i;

const DIR = join(tmpdir(), "pi-externalized");

export default function (pi: any) {
	if (OFF) return;
	pi.on("tool_result", async (event: any) => {
		if (EXEMPT.test(event.toolName)) return;
		const content = event.content ?? [];
		const total = content.filter((b: any) => b.type === "text").reduce((n: number, b: any) => n + b.text.length, 0);
		// Deliberate reads get the much larger budget so real files aren't gutted.
		const cap = IS_READ.test(event.toolName || "") ? READ_MAX : MAX_CHARS;
		if (total <= cap) return;

		const full = content
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("\n");
		mkdirSync(DIR, { recursive: true });
		const path = join(DIR, `${createHash("sha1").update(full).digest("hex").slice(0, 12)}.txt`);
		writeFileSync(path, full);

		const lines = full.split("\n").length;
		const elided = total - HEAD_CHARS - TAIL_CHARS;
		const excerpt =
			`⚠ [context-economy] TRUNCATED: ${total.toLocaleString()} chars / ${lines.toLocaleString()} lines → showing head+tail only; ` +
			`the MIDDLE (~${Math.max(0, elided).toLocaleString()} chars) is NOT shown. Full content at ${path}.\n` +
			`If what you need isn't in the head/tail below, DON'T assume it's absent — rg '<pattern>' ${path}, or read ${path} with offset/limit to get the middle. ` +
			`For a LOT of processing (scan the whole thing, extract many things), delegate an explore sub-agent to read ${path} so its full content never floods YOUR context — delegate({action:"run_agent", agent:"explorer", prompt:"read ${path} and <what you need>"}).\n` +
			`--- head (first ${HEAD_CHARS} chars) ---\n${full.slice(0, HEAD_CHARS)}\n` +
			`--- … middle elided — recover from ${path} … ---\n` +
			`--- tail (last ${TAIL_CHARS} chars) ---\n${full.slice(-TAIL_CHARS)}`;

		return {
			content: [{ type: "text", text: excerpt }, ...content.filter((b: any) => b.type !== "text")],
		};
	});
}
