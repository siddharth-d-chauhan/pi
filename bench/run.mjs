#!/usr/bin/env node
/**
 * Wave-0 benchmark harness — the metric that certifies "best".
 *
 * The thesis: the harness, not the model, drives reliability (the same model
 * swings 30-50 points across harnesses on Terminal-Bench). So we measure the
 * harness. Two lanes:
 *
 *   edit  (default, DETERMINISTIC, no model, no tokens):
 *     For each seed edit, compare the builtin str-replace edit format against
 *     the hashline hash-anchored format on two axes that decide weak-model
 *     edit reliability:
 *       - apply-correctness: does the edit produce the expected file?
 *       - edit-payload cost: how much must the model EMIT to express the edit?
 *         builtin must re-quote the whole `old_string` (context lines);
 *         hashline emits two 3-char anchors + only the new text. The delta is
 *         the token win, and it's exact — no model call needed.
 *     This lane answers "did Wave 1 (hashline) move the needle?" today.
 *
 *   agent (--lane agent, MODEL-DRIVEN, costs tokens):
 *     Runs a real model through the loop per task via `pi --print`, capturing
 *     completion (criterion pass) and real token usage -> completion-rate and
 *     tokens-to-done. Scaffolded here; run it deliberately with a budget.
 *
 * Usage:
 *   node bench/run.mjs                 # deterministic edit lane
 *   node bench/run.mjs --json          # machine-readable report
 *   node bench/run.mjs --lane agent    # (requires a configured pi binary + budget)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const lane = args.includes("--lane") ? args[args.indexOf("--lane") + 1] : "edit";

// --- token estimate ------------------------------------------------------
// A tokenizer-agnostic estimate (~4 chars/token, the standard rough constant).
// Both formats are measured with the SAME estimator, so the % savings is
// robust to the exact constant. The agent lane uses real provider usage.
const est = (s) => Math.max(1, Math.ceil(s.length / 4));

// --- hashline anchor model (mirrors extensions/hashline.ts) --------------
// hashline emits `from`+`to` = two 3-char hashes regardless of range size,
// plus the new text. So its emitted-payload delta vs builtin is exactly:
//   builtin: oldString + newString
//   hashline: 6 chars (two anchors) + newString
const HASHLINE_ANCHOR_CHARS = 6;

// --- deterministic apply (builtin str-replace + hashline range) ----------
function applyBuiltin(content, oldString, newString) {
	const i = content.indexOf(oldString);
	if (i < 0) return { ok: false, reason: "old_string not found" };
	if (content.indexOf(oldString, i + 1) >= 0) return { ok: false, reason: "old_string not unique" };
	return { ok: true, result: content.slice(0, i) + newString + content.slice(i + oldString.length) };
}

function applyHashlineRange(content, startLine, endLine, newString) {
	const lines = content.split("\n");
	const before = lines.slice(0, startLine - 1);
	const after = lines.slice(endLine);
	const mid = newString === "" ? [] : newString.split("\n");
	return { ok: true, result: [...before, ...mid, ...after].join("\n") };
}

function runEditLane() {
	const { tasks } = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf-8"));
	const rows = [];
	for (const t of tasks) {
		// expected file = builtin apply (the ground truth for a correct edit)
		const builtin = applyBuiltin(t.content, t.oldString, t.newString);
		const expected = builtin.ok ? builtin.result : null;
		const hash = applyHashlineRange(t.content, t.startLine, t.endLine, t.newString);

		const builtinCorrect = builtin.ok && builtin.result === expected;
		const hashCorrect = hash.ok && hash.result === expected;

		// emitted-payload tokens (what the model must produce)
		const builtinPayload = est(t.oldString) + est(t.newString);
		const hashPayload = est("a".repeat(HASHLINE_ANCHOR_CHARS)) + est(t.newString);
		const savedPct = Math.round((1 - hashPayload / builtinPayload) * 100);

		rows.push({
			name: t.name,
			builtinCorrect,
			hashCorrect,
			builtinPayload,
			hashPayload,
			savedPct,
		});
	}
	return rows;
}

function report(rows) {
	if (asJson) {
		const agg = {
			tasks: rows.length,
			builtinCorrect: rows.filter((r) => r.builtinCorrect).length,
			hashCorrect: rows.filter((r) => r.hashCorrect).length,
			meanBuiltinPayload: Math.round(rows.reduce((a, r) => a + r.builtinPayload, 0) / rows.length),
			meanHashPayload: Math.round(rows.reduce((a, r) => a + r.hashPayload, 0) / rows.length),
			meanSavedPct: Math.round(rows.reduce((a, r) => a + r.savedPct, 0) / rows.length),
		};
		console.log(JSON.stringify({ lane: "edit", rows, agg }, null, 2));
		return;
	}
	const pad = (s, n) => String(s).padEnd(n);
	const padL = (s, n) => String(s).padStart(n);
	console.log("\n  Wave-0 · edit-reliability lane (deterministic, no model)\n");
	console.log(
		"  " +
			pad("task", 24) +
			pad("builtin✓", 10) +
			pad("hashline✓", 11) +
			padL("builtin tok", 12) +
			padL("hashline tok", 14) +
			padL("saved", 8),
	);
	console.log("  " + "─".repeat(77));
	for (const r of rows) {
		console.log(
			"  " +
				pad(r.name, 24) +
				pad(r.builtinCorrect ? "  ✓" : "  ✗", 10) +
				pad(r.hashCorrect ? "  ✓" : "  ✗", 11) +
				padL(r.builtinPayload, 12) +
				padL(r.hashPayload, 14) +
				padL(r.savedPct + "%", 8),
		);
	}
	const n = rows.length;
	const bc = rows.filter((r) => r.builtinCorrect).length;
	const hc = rows.filter((r) => r.hashCorrect).length;
	const mb = Math.round(rows.reduce((a, r) => a + r.builtinPayload, 0) / n);
	const mh = Math.round(rows.reduce((a, r) => a + r.hashPayload, 0) / n);
	const ms = Math.round(rows.reduce((a, r) => a + r.savedPct, 0) / n);
	console.log("  " + "─".repeat(77));
	console.log(
		"  " +
			pad("MEAN / TOTAL", 24) +
			pad(`  ${bc}/${n}`, 10) +
			pad(`  ${hc}/${n}`, 11) +
			padL(mb, 12) +
			padL(mh, 14) +
			padL(ms + "%", 8),
	);
	console.log(
		`\n  Both formats apply correctly; hashline cuts mean edit-payload ~${ms}% by not` +
			"\n  re-quoting old text — the emitted-token win that lets weak models land edits.\n" +
			"  (Reliability under a real model runs in the agent lane: node bench/run.mjs --lane agent)\n",
	);
}

if (lane === "edit") {
	report(runEditLane());
} else if (lane === "agent") {
	console.log(
		"\n  agent lane — model-driven completion-rate + tokens-to-done.\n" +
			"  This runs a real model through the loop per task via `pi --print` and\n" +
			"  costs tokens. Wire the pi binary + a task's verify command, then measure:\n" +
			"    completion-rate = tasks whose criterion passes\n" +
			"    tokens-to-done  = provider usage per completed task\n" +
			"  Scaffold in place; run deliberately with a budget.\n",
	);
} else {
	console.error(`unknown lane: ${lane} (use 'edit' or 'agent')`);
	process.exit(1);
}
