/**
 * dlc-context.ts — a shared discovery ledger so agents don't rediscover things.
 *
 * The DLC's weakness once it fans out: each delegated stage is isolated and
 * re-discovers what an earlier stage already found — re-scopes the same files,
 * re-reads the same code, re-derives the plan. delegate passes prior TEXT OUTPUT
 * between stages, but not the discovered ARTIFACTS. This adds a run-scoped ledger
 * every stage in one delegation shares (keyed by A2A_RUN, same dir as the a2a
 * mailbox), so discovery is written once and read by all.
 *
 * What goes in the ledger (append-only, deduped by key):
 *   - scope:   the relevant files/symbols a scope step found
 *   - plan:    the agreed steps
 *   - read:    a file already read + its gist (don't re-read)
 *   - finding: a fact discovered (a bug's location, an API's shape, a decision)
 *   - verify:  a verification verdict (so a later stage trusts it, not re-runs it)
 *
 * Two tools:
 *   dlc_context()            → the accumulated ledger for this run (call FIRST —
 *                              it tells you what's already known so you skip it).
 *   dlc_note(kind, key, text)→ record a discovery for later stages.
 *
 * delegate injects the current ledger into each child's prompt at spawn (see
 * delegate.ts), and records scope results automatically — so even an agent that
 * never calls dlc_context still starts hydrated.
 *
 * Config: KP_DLC_CONTEXT_ENABLED=0 disable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.KP_DLC_CONTEXT_ENABLED !== "0";
const BASE = join(homedir(), ".pi", "agent", "pi-harness", "a2a"); // same base as a2a run dirs

function runDir(): string {
	const run = process.env.A2A_RUN || `run-${process.pid}`;
	const d = join(BASE, run);
	try {
		mkdirSync(d, { recursive: true });
	} catch {}
	return d;
}
const ledgerPath = () => join(runDir(), "dlc-ledger.jsonl");

type Note = { kind: string; key: string; text: string; by: string; ts: string };
const KINDS = new Set(["scope", "plan", "read", "finding", "verify"]);

export function recordNote(kind: string, key: string, text: string, by = "parent"): boolean {
	try {
		const note: Note = {
			kind,
			key: String(key).slice(0, 200),
			text: String(text).slice(0, 4000),
			by,
			ts: new Date().toISOString(),
		};
		appendFileSync(ledgerPath(), `${JSON.stringify(note)}\n`);
		return true;
	} catch {
		return false;
	}
}

export function readLedger(): Note[] {
	const p = ledgerPath();
	if (!existsSync(p)) return [];
	try {
		const notes = readFileSync(p, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as Note);
		// dedupe by kind+key, last write wins
		const byKey = new Map<string, Note>();
		for (const n of notes) byKey.set(`${n.kind}:${n.key}`, n);
		return [...byKey.values()];
	} catch {
		return [];
	}
}

// A compact rendering of the ledger for injection into a stage's prompt.
export function renderLedger(notes = readLedger()): string {
	if (!notes.length) return "";
	const order = ["scope", "plan", "read", "finding", "verify"];
	const grouped = order.map((k) => [k, notes.filter((n) => n.kind === k)] as const).filter(([, v]) => v.length);
	if (!grouped.length) return "";
	const lines: string[] = [];
	for (const [kind, ns] of grouped) {
		lines.push(`### ${kind} (already known — do NOT rediscover)`);
		for (const n of ns)
			lines.push(
				`- ${n.key}: ${n.text.length > 300 ? `${n.text.slice(0, 300)}…` : n.text}${n.by !== "parent" ? ` [${n.by}]` : ""}`,
			);
	}
	return `## Shared discovery ledger for this task (from earlier stages)\n${lines.join("\n")}`;
}

export default function (pi: any) {
	if (!ENABLED) return;
	const self = () => process.env.A2A_ID || "parent";

	pi.registerTool({
		name: "dlc_context",
		label: "dlc context",
		description:
			"The shared discovery ledger for this task — what earlier stages already scoped, planned, read, found, and " +
			"verified. Call this FIRST on a delegated task so you DON'T rediscover files/context someone already found. " +
			"Returns scope + plan + reads + findings + verifications recorded so far.",
		promptSnippet: "dlc_context() — what's already been discovered this task (call first; skip rediscovery)",
		parameters: { type: "object", properties: {} },
		async execute() {
			const notes = readLedger();
			if (!notes.length)
				return {
					content: [
						{
							type: "text",
							text: "(discovery ledger empty — you're the first stage; record what you find with dlc_note so later stages skip it.)",
						},
					],
				};
			return { content: [{ type: "text", text: renderLedger(notes) }] };
		},
	});

	pi.registerTool({
		name: "dlc_note",
		label: "dlc note",
		description:
			"Record a discovery for later stages so they don't redo it. kind ∈ scope|plan|read|finding|verify; key = a " +
			"short label (e.g. a file path or symbol); text = the detail. e.g. dlc_note('read','auth/login.py','handles " +
			"JWT; the bug is the missing exp check on line 40'). Later stages see it via dlc_context.",
		promptSnippet: "dlc_note(kind, key, text) — record a discovery (scope/plan/read/finding/verify) for later stages",
		parameters: {
			type: "object",
			properties: {
				kind: { type: "string", description: "scope | plan | read | finding | verify" },
				key: { type: "string", description: "short label (file path, symbol, step name)" },
				text: { type: "string", description: "the detail worth not rediscovering" },
			},
			required: ["kind", "key", "text"],
		},
		async execute(_id: string, p: any) {
			const kind = String(p?.kind ?? "").toLowerCase();
			if (!KINDS.has(kind))
				return {
					content: [{ type: "text", text: `kind must be one of: ${[...KINDS].join(", ")}` }],
					isError: true,
				};
			const ok = recordNote(kind, String(p?.key ?? ""), String(p?.text ?? ""), self());
			return {
				content: [{ type: "text", text: ok ? `recorded ${kind}: ${p.key}` : "couldn't record note" }],
				isError: !ok,
			};
		},
	});
}
