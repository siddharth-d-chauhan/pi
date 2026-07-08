/**
 * todo.ts — a live task checklist pi maintains for itself (self-managed todo list).
 *
 * For multi-step work, the model benefits from an explicit checklist it writes once and
 * checks off as it goes — it keeps long tasks on track and makes progress legible. pi has
 * no built-in todo tool and neither did we (dlc-context has a `plan` KIND but that's a
 * cross-stage discovery ledger, not a live check-off list). This adds the missing tier.
 *
 * Knowledge-first / don't-rebuild: todos are persisted THROUGH dlc-context's ledger
 * (kind "todo"), NOT a parallel store — so a delegated sub-agent sees the same list via
 * dlc_context(), and there's one source of truth.
 *
 * KV-cache discipline: the checklist is injected via the `context` hook as a SINGLE
 * trailing block that is only rebuilt when the list actually CHANGES (a write/check bumps
 * a revision counter). On turns where nothing changed, the exact same bytes are re-emitted
 * → the injected tail is byte-identical → KV prefix stays warm. The block is a stable
 * whole-list render (not append-only deltas), and it only moves when the list moves, which
 * is the correct time for the tail to change.
 *
 * Tools:
 *   todo_write(items)      → set/replace the checklist (each item: {step, status?}).
 *   todo_check(step|index) → mark one item done (or set its status).
 *   todo_read()            → current checklist.
 * Command: /todo shows it.
 *
 * Config: KP_TODO_ENABLED=0 disable · KP_TODO_INJECT=0 keep the tools but don't auto-inject.
 */

import { readLedger, recordNote } from "./dlc-context.ts";
import { wrapInjection } from "./kp-sentinel.ts"; // provenance sentinel

const ENABLED = process.env.KP_TODO_ENABLED !== "0";
const INJECT = process.env.KP_TODO_INJECT !== "0";

type Status = "pending" | "in_progress" | "done";
type Item = { step: string; status: Status };

const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" };
const LEDGER_KEY = "checklist";

function normalizeStatus(s: any): Status {
	const v = String(s ?? "pending").toLowerCase();
	if (v === "done" || v === "complete" || v === "completed" || v === "x") return "done";
	if (v === "in_progress" || v === "active" || v === "doing" || v === "wip") return "in_progress";
	return "pending";
}

// Todos live in the dlc ledger (kind "todo", key "checklist") as a JSON array — one source
// of truth, visible to sub-agents. Read/write go through dlc-context's exported helpers.
function loadItems(): Item[] {
	try {
		const note = readLedger().find((n) => n.kind === "todo" && n.key === LEDGER_KEY);
		if (!note) return [];
		const arr = JSON.parse(note.text);
		return Array.isArray(arr)
			? arr
					.map((i: any) => ({ step: String(i.step ?? "").slice(0, 300), status: normalizeStatus(i.status) }))
					.filter((i) => i.step)
			: [];
	} catch {
		return [];
	}
}
function saveItems(items: Item[]): boolean {
	// recordNote dedupes by kind+key (last write wins) — so this replaces the list in place.
	return recordNote("todo", LEDGER_KEY, JSON.stringify(items), process.env.A2A_ID || "parent");
}

function render(items: Item[]): string {
	if (!items.length || items.every((i) => i.status === "done")) return ""; // FIX: suppress kp:todo echo entirely when every item is done — the items are still stored (todo_read works); just no token cost in context.
	const done = items.filter((i) => i.status === "done").length;
	const lines = items.map((i) => `${MARK[i.status]} ${i.step}`);
	return `## Task checklist (${done}/${items.length} done — keep it current with todo_write/todo_check):\n${lines.join("\n")}`;
}

export default function (pi: any) {
	if (!ENABLED) return;

	// Revision counter: bumped on every mutation. The context hook only rebuilds the injected
	// string when the revision changes — otherwise it re-emits the cached bytes verbatim so
	// the KV prefix stays warm (per our cache discipline).
	let revision = 0;
	let cachedRev = -1;
	let cachedBlock = "";

	function currentBlock(): string {
		if (revision !== cachedRev) {
			cachedBlock = render(loadItems());
			cachedRev = revision;
		}
		return cachedBlock;
	}

	pi.registerTool({
		name: "todo_write",
		label: "todo",
		description:
			"Set or replace your task checklist for multi-step work — write it once up front, then keep it current. " +
			"items = array of {step, status?} where status ∈ pending|in_progress|done (default pending). Replaces the " +
			"whole list. Use for any task of ~3+ steps so progress stays legible and nothing is dropped.",
		promptSnippet:
			"todo_write(items) — set your task checklist ({step,status?}); todo_check to tick items off as you go",
		parameters: {
			type: "object",
			properties: {
				items: {
					type: "array",
					description: "the checklist, in order",
					items: {
						type: "object",
						properties: {
							step: { type: "string", description: "what to do (short, imperative)" },
							status: {
								type: "string",
								enum: ["pending", "in_progress", "done"],
								description: "default pending",
							},
						},
						required: ["step"],
					},
				},
			},
			required: ["items"],
		},
		async execute(_id: string, p: any) {
			const items: Item[] = (Array.isArray(p?.items) ? p.items : [])
				.map((i: any) => ({ step: String(i?.step ?? "").slice(0, 300), status: normalizeStatus(i?.status) }))
				.filter((i: Item) => i.step);
			if (!items.length)
				return {
					content: [{ type: "text", text: "no items — pass a non-empty array of {step, status?}" }],
					isError: true,
				};
			const ok = saveItems(items);
			revision++;
			return {
				content: [{ type: "text", text: ok ? render(items) : "couldn't save checklist (ledger unwritable)" }],
				isError: !ok,
			};
		},
	});

	pi.registerTool({
		name: "todo_check",
		label: "todo check",
		description:
			"Tick a checklist item off (or set its status). Identify the item by its 1-based index or by a substring of its " +
			"step text. status defaults to done. Call this as you finish each step so the checklist reflects reality.",
		promptSnippet: "todo_check(item, status?) — mark a checklist item done (item = index or step substring)",
		parameters: {
			type: "object",
			properties: {
				item: { type: "string", description: '1-based index (e.g. "2") or a substring of the step' },
				status: { type: "string", enum: ["pending", "in_progress", "done"], description: "default done" },
			},
			required: ["item"],
		},
		async execute(_id: string, p: any) {
			const items = loadItems();
			if (!items.length)
				return {
					content: [{ type: "text", text: "no checklist yet — create one with todo_write" }],
					isError: true,
				};
			const sel = String(p?.item ?? "").trim();
			const status = normalizeStatus(p?.status ?? "done");
			let idx = -1;
			if (/^\d+$/.test(sel)) idx = Number(sel) - 1;
			else idx = items.findIndex((i) => i.step.toLowerCase().includes(sel.toLowerCase()));
			if (idx < 0 || idx >= items.length)
				return { content: [{ type: "text", text: `no item matches "${sel}"` }], isError: true };
			items[idx].status = status;
			const ok = saveItems(items);
			revision++;
			return { content: [{ type: "text", text: ok ? render(items) : "couldn't update checklist" }], isError: !ok };
		},
	});

	pi.registerTool({
		name: "todo_read",
		label: "todo read",
		description: "Read your current task checklist.",
		promptSnippet: "todo_read() — your current task checklist",
		parameters: { type: "object", properties: {} },
		async execute() {
			const items = loadItems();
			return {
				content: [
					{ type: "text", text: items.length ? render(items) : "(no checklist — create one with todo_write)" },
				],
			};
		},
	});

	// Inject the checklist as a cache-safe trailing block. Byte-stable while the list is
	// unchanged (currentBlock() re-emits cached bytes until a mutation bumps the revision),
	// so the KV prefix stays warm; the tail only changes when the list actually changes.
	if (INJECT) {
		pi.on("context", async (event: any) => {
			const block = currentBlock();
			if (!block) return;
			const messages = event?.messages;
			if (!Array.isArray(messages)) return;
			return {
				messages: [...messages, { role: "user", content: [{ type: "text", text: wrapInjection("todo", block) }] }],
			};
		});
	}

	pi.registerCommand("todo", {
		description: "Show the current task checklist",
		handler: async (_args: string, ctx: any) => {
			const items = loadItems();
			ctx.ui.notify(
				items.length ? render(items) : "No checklist yet. The model creates one with todo_write.",
				"info",
			);
		},
	});
}
