#!/usr/bin/env node
/**
 * Wave-0 benchmark harness — measure the harness, not the model.
 *
 * The thesis: the harness, not the model, drives how far a run gets (the same
 * model swings 30-50 points across harnesses on Terminal-Bench). So we measure
 * completion + cost of a real model through pi on a fixed task suite.
 *
 * Agent lane (costs tokens): runs the configured model through `pi -p` per task,
 * captures completion (a behavioral check on the edited file) and tokens-to-done.
 * A reusable baseline for testing whether a harness change actually helps —
 * flip an env (KP_ADVISOR=1, PI_LOOP_REVIEW_LENSES=3, KP_EVICTION=0, …) and
 * compare runs.
 *
 * Usage:
 *   node bench/run.mjs [--only <task>] [--json]
 *
 * (An earlier builtin-vs-hashline edit-format A/B lived here; hashline was
 *  removed — it only helped weak models and cost capable ones ~18% more tokens.
 *  See RESULTS.md.)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const PI_BIN = process.env.BENCH_PI || "pi";
const alog = (m) => process.stderr.write(`${m}\n`);

/** Sum assistant tokens (deduped by responseId) and tally tool calls from a json-mode run. */
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

function runPi(cwd, intent) {
	return new Promise((res) => {
		const a = ["-p", "--mode", "json", "--no-session", "--approve", intent];
		let out = "";
		let proc;
		try {
			proc = spawn(PI_BIN, a, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
	alog(`\n  Wave-0 · agent lane — completion + tokens-to-done (${PI_BIN}, ${suite.length} tasks)\n`);
	const rows = [];
	for (const task of suite) {
		const dir = mkdtempSync(join(tmpdir(), "bench-"));
		writeFileSync(join(dir, task.file), task.content);
		const out = await runPi(dir, task.intent);
		const { tokens, tools } = parseRun(out);
		const done = await checkTask(task, dir);
		rows.push({ name: task.name, done, tokens, tools });
		alog(
			`  ${task.name.padEnd(24)} ${done ? "✓" : "✗"} · ${String(tokens).padStart(7)} tok · ${Object.keys(tools).join(",") || "none"}`,
		);
	}
	report(rows);
}

function report(rows) {
	if (asJson) {
		console.log(JSON.stringify({ lane: "agent", model: PI_BIN, rows }, null, 2));
		return;
	}
	const pad = (s, n) => String(s).padEnd(n);
	console.log("\n  Wave-0 · agent lane (model completion + tokens-to-done)\n");
	console.log(`  ${pad("task", 26)}${pad("done", 6)}${pad("tokens", 10)}tools`);
	console.log(`  ${"─".repeat(60)}`);
	for (const r of rows) {
		console.log(`  ${pad(r.name, 26)}${pad(r.done ? "✓" : "✗", 6)}${pad(r.tokens, 10)}${Object.keys(r.tools).join(",") || "none"}`);
	}
	const done = rows.filter((r) => r.done);
	const rate = rows.length ? Math.round((done.length / rows.length) * 100) : 0;
	const meanTok = done.length ? Math.round(done.reduce((a, r) => a + r.tokens, 0) / done.length) : 0;
	console.log(`  ${"─".repeat(60)}`);
	console.log(`  completion ${done.length}/${rows.length} (${rate}%) · mean tokens-to-done ${meanTok}\n`);
}

await runAgentLane();
