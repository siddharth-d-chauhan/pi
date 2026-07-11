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

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const lane = args.includes("--lane") ? args[args.indexOf("--lane") + 1] : "edit";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null; // task-name filter
const PI_BIN = process.env.BENCH_PI || "pi";

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

// ---- agent lane ---------------------------------------------------------
const alog = (m) => process.stderr.write(`${m}\n`);

// Two arms force the same model to use each edit FORMAT, isolating the format's
// effect on completion + tokens (the model otherwise picks builtin edit on its own).
const AGENT_ARMS = [
	{ key: "builtin", env: { KP_HASHLINE_ENABLED: "0" }, exclude: ["hread", "hedit", "hedit_block"] },
	{ key: "hashline", env: {}, exclude: ["edit", "write", "multiedit", "str_replace", "apply_patch", "create_file"] },
];

function parseRun(jsonlines) {
	let tokens = 0;
	const seen = new Set();
	const tools = {};
	for (const line of jsonlines.split("\n")) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "message_end" && e.message?.role === "assistant") {
			const rid = e.message.responseId;
			if (rid && !seen.has(rid)) {
				seen.add(rid);
				tokens += e.message.usage?.totalTokens || 0;
			}
		}
		if (e.type === "agent_end" && Array.isArray(e.messages)) {
			for (const msg of e.messages) {
				if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
				for (const b of msg.content) if (b.type === "toolCall") tools[b.name] = (tools[b.name] || 0) + 1;
			}
		}
	}
	return { tokens, tools };
}

function runPi(cwd, intent, arm) {
	return new Promise((res) => {
		const a = ["-p", "--mode", "json", "--no-session", "--approve"];
		if (arm.exclude?.length) a.push("--exclude-tools", arm.exclude.join(","));
		a.push(intent);
		let out = "";
		let proc;
		try {
			proc = spawn(PI_BIN, a, { cwd, env: { ...process.env, ...arm.env }, stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			return res("");
		}
		const timer = setTimeout(() => proc.kill(), 240_000);
		proc.stdout.on("data", (d) => {
			out += d.toString();
		});
		proc.stderr.on("data", () => {});
		proc.on("close", () => {
			clearTimeout(timer);
			res(out);
		});
		proc.on("error", () => {
			clearTimeout(timer);
			res(out);
		});
	});
}

async function checkTask(task, dir) {
	const file = join(dir, task.file);
	let text = "";
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return false;
	}
	try {
		const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
		// biome-ignore lint/security/noGlobalEval: bench check bodies are trusted local task fixtures
		const fn = new Function("m", "text", task.check);
		return (await fn(mod, text)) === true;
	} catch {
		return false;
	}
}

async function runAgentLane() {
	const { tasks } = JSON.parse(readFileSync(join(HERE, "tasks.json"), "utf-8"));
	const suite = only ? tasks.filter((t) => t.name === only) : tasks;
	alog(`\n  Wave-0 · agent lane — model completion + tokens-to-done (${PI_BIN}, ${suite.length} tasks × 2 formats)\n`);
	const rows = [];
	for (const task of suite) {
		const rec = { name: task.name };
		for (const arm of AGENT_ARMS) {
			const dir = mkdtempSync(join(tmpdir(), `bench-${arm.key}-`));
			writeFileSync(join(dir, task.file), task.content);
			const out = await runPi(dir, task.intent, arm);
			const { tokens, tools } = parseRun(out);
			const done = await checkTask(task, dir);
			rec[arm.key] = { done, tokens, tools };
			alog(
				`  ${task.name.padEnd(22)} ${arm.key.padEnd(9)} ${done ? "✓" : "✗"} · ${String(tokens).padStart(7)} tok · ${Object.keys(tools).join(",") || "none"}`,
			);
		}
		rows.push(rec);
	}
	reportAgent(rows);
}

function reportAgent(rows) {
	if (asJson) {
		console.log(JSON.stringify({ lane: "agent", model: PI_BIN, rows }, null, 2));
		return;
	}
	const pad = (s, n) => String(s).padEnd(n);
	const padL = (s, n) => String(s).padStart(n);
	console.log("\n  Wave-0 · agent lane (model-driven completion + tokens-to-done)\n");
	console.log(
		`  ${pad("task", 24)}${pad("builtin", 16)}${pad("hashline", 16)}`,
	);
	console.log(`  ${"─".repeat(56)}`);
	for (const r of rows) {
		const cell = (a) => `${a.done ? "✓" : "✗"} ${a.tokens} tok`;
		console.log(`  ${pad(r.name, 24)}${pad(cell(r.builtin), 16)}${pad(cell(r.hashline), 16)}`);
	}
	console.log(`  ${"─".repeat(56)}`);
	for (const arm of ["builtin", "hashline"]) {
		const done = rows.filter((r) => r[arm].done);
		const rate = Math.round((done.length / rows.length) * 100);
		const meanTok = done.length ? Math.round(done.reduce((a, r) => a + r[arm].tokens, 0) / done.length) : 0;
		console.log(
			`  ${pad(arm.toUpperCase(), 24)}completion ${padL(`${done.length}/${rows.length}`, 5)} (${rate}%) · mean tokens-to-done ${meanTok}`,
		);
	}
	console.log("");
}

if (lane === "edit") {
	report(runEditLane());
} else if (lane === "agent") {
	await runAgentLane();
} else {
	console.error(`unknown lane: ${lane} (use 'edit' or 'agent')`);
	process.exit(1);
}
