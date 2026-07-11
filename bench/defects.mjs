#!/usr/bin/env node
/**
 * Defect-catch benchmark — does the shipped 3-lens review catch bugs a generic
 * review misses? Runs a reviewer over each planted-defect fixture in two modes,
 * measuring catch rate. This is the test that decides whether the verification
 * lens work (Wave 4) is worth it for a capable model.
 *
 *   node bench/defects.mjs [--only <name>] [--repeats N] [--json]
 *
 * A "catch" = the reviewer returns VERDICT: buggy AND names the specific defect
 * (its output matches the fixture tripwire). A wrong-verdict or a vague/incorrect
 * finding does not count. Reviewer only reads the file; nothing is executed.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const repeats = args.includes("--repeats") ? Number(args[args.indexOf("--repeats") + 1]) : 1;
const PI_BIN = process.env.BENCH_PI || "pi";
const alog = (m) => process.stderr.write(`${m}\n`);

const genericPrompt = (file, intent) =>
	`Read the file ${file} in this directory. Its intended behavior: ${intent}\n\n` +
	`Review the implementation for CORRECTNESS. Decide whether it is correct or has a bug. ` +
	`End your reply with a line "VERDICT: correct" or "VERDICT: buggy"; if buggy, state the exact defect in one sentence.`;

const lensesPrompt = (file, intent) =>
	`Read the file ${file} in this directory. Its intended behavior: ${intent}\n\n` +
	`Review it for CORRECTNESS by applying THREE distinct lenses, each as a separate pass:\n` +
	`(1) CORRECTNESS — inverted/wrong conditions, off-by-one, boundary and edge cases, unhandled inputs, broken logic.\n` +
	`(2) SAFETY — crash, NaN, data loss, unhandled empty/null.\n` +
	`(3) REPRODUCE — pick a concrete input, trace it line by line through the code, and check the output actually matches the intended behavior.\n\n` +
	`End with "VERDICT: correct" or "VERDICT: buggy"; if buggy, state the exact defect in one sentence.`;

const MODES = [
	{ key: "generic", prompt: genericPrompt },
	{ key: "lenses", prompt: lensesPrompt },
];

function finalText(jsonlines) {
	let text = "";
	for (const line of jsonlines.split("\n")) {
		if (!line.trim()) continue;
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "message_end" && e.message?.role === "assistant") {
			const t = (e.message.content || [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			if (t.trim()) text = t;
		}
	}
	return text;
}

function runReview(cwd, prompt) {
	return new Promise((res) => {
		let out = "";
		let proc;
		try {
			proc = spawn(PI_BIN, ["-p", "--mode", "json", "--no-session", "--approve", prompt], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			return res("");
		}
		const timer = setTimeout(() => proc.kill(), 180_000);
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

function scoreReview(text, tripwireSrc) {
	const buggy = /verdict:\s*buggy/i.test(text);
	const named = new RegExp(tripwireSrc, "i").test(text);
	return { caught: buggy && named, buggy, named };
}

async function run() {
	const { fixtures } = JSON.parse(readFileSync(join(HERE, "defects.json"), "utf-8"));
	const suite = only ? fixtures.filter((f) => f.name === only) : fixtures;
	alog(`\n  Defect-catch benchmark — ${PI_BIN} · ${suite.length} defects × ${MODES.length} modes × ${repeats} run(s)\n`);
	const rows = [];
	for (const fx of suite) {
		const rec = { name: fx.name, modes: {} };
		for (const mode of MODES) {
			let caught = 0;
			let buggy = 0;
			const samples = [];
			for (let r = 0; r < repeats; r++) {
				const dir = mkdtempSync(join(tmpdir(), `defect-${mode.key}-`));
				writeFileSync(join(dir, fx.file), fx.content);
				const out = await runReview(dir, mode.prompt(fx.file, fx.intent));
				const text = finalText(out);
				const s = scoreReview(text, fx.tripwire);
				if (s.caught) caught++;
				if (s.buggy) buggy++;
				samples.push(text.replace(/\s+/g, " ").slice(0, 200));
			}
			rec.modes[mode.key] = { caught, buggy, repeats, sample: samples[0] };
			alog(`  ${fx.name.padEnd(22)} ${mode.key.padEnd(8)} caught ${caught}/${repeats} · buggy-verdict ${buggy}/${repeats}`);
		}
		rows.push(rec);
	}
	report(rows);
}

function report(rows) {
	if (asJson) {
		console.log(JSON.stringify({ bench: "defect-catch", model: PI_BIN, repeats, rows }, null, 2));
		return;
	}
	const pad = (s, n) => String(s).padEnd(n);
	console.log("\n  Defect-catch rate — generic review vs shipped 3-lens review\n");
	console.log(`  ${pad("defect", 24)}${pad("generic", 12)}${pad("lenses", 12)}`);
	console.log(`  ${"─".repeat(48)}`);
	for (const r of rows) {
		const c = (m) => `${r.modes[m].caught}/${r.modes[m].repeats}`;
		console.log(`  ${pad(r.name, 24)}${pad(c("generic"), 12)}${pad(c("lenses"), 12)}`);
	}
	console.log(`  ${"─".repeat(48)}`);
	for (const m of ["generic", "lenses"]) {
		const caught = rows.reduce((a, r) => a + r.modes[m].caught, 0);
		const total = rows.reduce((a, r) => a + r.modes[m].repeats, 0);
		console.log(`  ${pad(m.toUpperCase(), 24)}${caught}/${total} defects caught (${Math.round((caught / total) * 100)}%)`);
	}
	console.log("");
}

await run();
