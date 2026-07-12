#!/usr/bin/env node
/**
 * Multi-file defect-catch benchmark — the hard case a single-file review misses.
 *
 * Each fixture is 2 files whose bug is a CONTRACT MISMATCH across the boundary
 * (each file reads fine alone). We compare a generic DIRECT review against the
 * independent 3-lens PANEL (3 reviewers, one lens each, majority vote) to decide
 * whether the opt-in panel (PI_LOOP_REVIEW_LENSES>1) earns its keep on hard
 * defects that the now-default direct review might miss.
 *
 *   node bench/defects-multi.mjs [--only <name>] [--repeats N] [--json]
 *
 * generic catch = VERDICT buggy AND defect named (tripwire).
 * panel catch   = >=2 of 3 lens reviewers buggy AND defect named across them.
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

// Same lens briefs the loop panel uses (extensions/loop.ts REVIEW_LENSES).
const LENSES = [
	"CORRECTNESS — inverted/wrong conditions, off-by-one, boundary and edge cases, unhandled inputs, broken logic, and mismatched contracts between the files.",
	"SAFETY — crash, NaN, data loss, unhandled empty/null, shared-state mutation.",
	"REPRODUCE — pick a concrete input, trace it ACROSS both files line by line, and check the final output matches the intended behavior.",
];

const fileList = (fixture) => fixture.files.map((f) => f.path).join(", ");

const genericPrompt = (fixture) =>
	`Read these files in this directory: ${fileList(fixture)}. Intended behavior: ${fixture.intent}\n\n` +
	`Review for CORRECTNESS across the files — the interaction between them, not just each file alone. ` +
	`Decide if it is correct or has a bug. End with "VERDICT: correct" or "VERDICT: buggy"; if buggy, state the exact defect in one sentence.`;

const lensPrompt = (fixture, lens) =>
	`Read these files in this directory: ${fileList(fixture)}. Intended behavior: ${fixture.intent}\n\n` +
	`Review for CORRECTNESS through ONE lens only:\n${lens}\n\n` +
	`Focus on the interaction ACROSS the files. End with "VERDICT: correct" or "VERDICT: buggy"; if buggy, state the exact defect in one sentence.`;

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

const isBuggy = (text) => /verdict:\s*buggy/i.test(text);

function seed(fixture) {
	const dir = mkdtempSync(join(tmpdir(), "mdefect-"));
	for (const f of fixture.files) writeFileSync(join(dir, f.path), f.content);
	return dir;
}

async function trialGeneric(fixture, tripwire) {
	const dir = seed(fixture);
	const text = finalText(await runReview(dir, genericPrompt(fixture)));
	return isBuggy(text) && tripwire.test(text);
}

async function trialPanel(fixture, tripwire) {
	// 3 INDEPENDENT reviewers, one lens each (fresh dir/context per reviewer).
	let buggyVotes = 0;
	let named = false;
	for (const lens of LENSES) {
		const dir = seed(fixture);
		const text = finalText(await runReview(dir, lensPrompt(fixture, lens)));
		if (isBuggy(text)) buggyVotes++;
		if (tripwire.test(text)) named = true;
	}
	return buggyVotes >= 2 && named; // majority buggy AND the defect was named
}

async function run() {
	const { fixtures } = JSON.parse(readFileSync(join(HERE, "defects-multi.json"), "utf-8"));
	const suite = only ? fixtures.filter((f) => f.name === only) : fixtures;
	alog(`\n  Multi-file defect-catch — ${PI_BIN} · ${suite.length} defects × {generic, panel} × ${repeats} run(s)\n`);
	const rows = [];
	for (const fx of suite) {
		const tripwire = new RegExp(fx.tripwire, "i");
		let g = 0;
		let p = 0;
		for (let r = 0; r < repeats; r++) {
			if (await trialGeneric(fx, tripwire)) g++;
			if (await trialPanel(fx, tripwire)) p++;
		}
		rows.push({ name: fx.name, generic: g, panel: p, repeats });
		alog(`  ${fx.name.padEnd(24)} generic ${g}/${repeats} · panel ${p}/${repeats}`);
	}
	report(rows);
}

function report(rows) {
	if (asJson) {
		console.log(JSON.stringify({ bench: "defect-catch-multi", model: PI_BIN, repeats, rows }, null, 2));
		return;
	}
	const pad = (s, n) => String(s).padEnd(n);
	console.log("\n  Multi-file defect-catch — generic direct review vs independent 3-lens panel\n");
	console.log(`  ${pad("defect", 26)}${pad("generic", 12)}${pad("panel", 12)}`);
	console.log(`  ${"─".repeat(50)}`);
	for (const r of rows) {
		console.log(`  ${pad(r.name, 26)}${pad(`${r.generic}/${r.repeats}`, 12)}${pad(`${r.panel}/${r.repeats}`, 12)}`);
	}
	console.log(`  ${"─".repeat(50)}`);
	for (const m of ["generic", "panel"]) {
		const caught = rows.reduce((a, r) => a + r[m], 0);
		const total = rows.reduce((a, r) => a + r.repeats, 0);
		console.log(`  ${pad(m.toUpperCase(), 26)}${caught}/${total} caught (${Math.round((caught / total) * 100)}%)`);
	}
	console.log("");
}

await run();
