/**
 * a2a.ts — agent-to-agent messaging: subagents talk to each other and the parent.
 *
 * oh-my-pi's contact_supervisor mailbox, generalized to peer-to-peer. Your
 * delegate subagents were isolated (spawn → return result). This lets a running
 * agent send a message to another agent (a peer child or the parent) and poll for
 * replies mid-run — coordination, not just fan-out-and-collect.
 *
 * Mechanism (file mailbox, no server): all agents in one delegation share a run
 * directory keyed by A2A_RUN (env, set by the parent and inherited by spawned
 * children). Each agent has an identity A2A_ID (default "parent"; children get
 * their stage name). send_message writes a JSON line to <run>/<to>.inbox;
 * check_messages reads+clears <run>/<self>.inbox. broadcast writes to a shared
 * bus all agents can read.
 *
 * For a child to block-wait on a reply (the supervisor pattern), it polls
 * check_messages with wait_ms.
 *
 * The parent (main pi) sets A2A_RUN on session_start if unset, so the mailbox
 * exists; delegate passes A2A_RUN + A2A_ID into each spawned child (see delegate).
 *
 * Config: KP_A2A_ENABLED=0 disable.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.KP_A2A_ENABLED !== "0";
const A2A_BASE = join(homedir(), ".pi", "agent", "pi-harness", "a2a");

function runDir(): string {
	const run = process.env.A2A_RUN || "default";
	const d = join(A2A_BASE, run);
	try {
		mkdirSync(d, { recursive: true });
	} catch {}
	return d;
}
const selfId = () => process.env.A2A_ID || "parent";
const inbox = (id: string) => join(runDir(), `${id}.inbox.jsonl`);
const busPath = () => join(runDir(), "bus.jsonl");

function send(to: string, from: string, text: string): boolean {
	try {
		appendFileSync(inbox(to), `${JSON.stringify({ from, to, text, ts: new Date().toISOString() })}\n`);
		return true;
	} catch {
		return false;
	}
}
function drain(id: string): any[] {
	const p = inbox(id);
	if (!existsSync(p)) return [];
	try {
		const msgs = readFileSync(p, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		writeFileSync(p, "");
		return msgs;
	} catch {
		return [];
	}
}
function agents(): string[] {
	try {
		return readdirSync(runDir())
			.filter((f) => f.endsWith(".inbox.jsonl"))
			.map((f) => f.replace(".inbox.jsonl", ""));
	} catch {
		return [];
	}
}

export default function (pi: any) {
	if (!ENABLED) return;

	// Parent establishes the run mailbox if none inherited (so peers share it).
	pi.on("session_start", async () => {
		if (!process.env.A2A_RUN) process.env.A2A_RUN = `run-${process.pid}`;
		// register self so peers can discover us
		try {
			if (!existsSync(inbox(selfId()))) writeFileSync(inbox(selfId()), "");
		} catch {}
	});

	pi.registerTool({
		name: "send_message",
		label: "a2a send",
		description:
			"Send a message to another agent in this delegation — a peer subagent by name or 'parent' (the orchestrator). " +
			"Use to coordinate: ask a peer for info, report a blocker to the parent, hand off a finding. " +
			"Pair with check_messages to receive. See a2a_agents for who's reachable.",
		promptSnippet: "send_message(to, text) — message a peer subagent or 'parent'",
		parameters: {
			type: "object",
			properties: {
				to: { type: "string", description: "recipient agent id ('parent' or a peer's name), or '*' to broadcast" },
				text: { type: "string" },
			},
			required: ["to", "text"],
		},
		async execute(_id: string, p: any) {
			const from = selfId();
			if (p.to === "*") {
				try {
					appendFileSync(busPath(), `${JSON.stringify({ from, text: p.text, ts: new Date().toISOString() })}\n`);
				} catch {}
				return { content: [{ type: "text", text: `broadcast sent from ${from}` }] };
			}
			const ok = send(p.to, from, String(p.text ?? ""));
			return {
				content: [
					{
						type: "text",
						text: ok ? `sent to ${p.to}` : `send failed (is ${p.to} a valid agent? see a2a_agents)`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "check_messages",
		label: "a2a recv",
		description:
			"Check for messages sent to you by other agents (and the broadcast bus). Optionally block-wait up to wait_ms " +
			"for a reply (the supervisor pattern: send a question to 'parent', then check_messages with wait_ms). " +
			"Returns and clears your inbox.",
		promptSnippet: "check_messages(wait_ms?) — receive messages from peers/parent",
		parameters: {
			type: "object",
			properties: { wait_ms: { type: "number", description: "block up to this long for a message (default 0)" } },
		},
		async execute(_id: string, p: any) {
			const id = selfId();
			const deadline = Date.now() + (p.wait_ms || 0);
			let msgs = drain(id);
			while (!msgs.length && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 400));
				msgs = drain(id);
			}
			// include any new broadcast messages
			let bus: any[] = [];
			try {
				if (existsSync(busPath()))
					bus = readFileSync(busPath(), "utf-8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l))
						.slice(-5)
						.filter((m) => m.from !== id);
			} catch {}
			const all = [...msgs, ...bus.map((b) => ({ ...b, to: "*" }))];
			return {
				content: [
					{
						type: "text",
						text: all.length
							? all.map((m) => `[from ${m.from}${m.to === "*" ? " (broadcast)" : ""}] ${m.text}`).join("\n")
							: "(no messages)",
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "a2a_agents",
		label: "a2a agents",
		description: "List the agents reachable in this delegation (peers + parent) that you can send_message to.",
		parameters: { type: "object", properties: {} },
		async execute() {
			const list = agents().filter((a) => a !== selfId());
			return {
				content: [
					{
						type: "text",
						text: list.length
							? `You are '${selfId()}'. Reachable: ${list.join(", ")}`
							: `You are '${selfId()}'. No other agents yet.`,
					},
				],
			};
		},
	});
}
