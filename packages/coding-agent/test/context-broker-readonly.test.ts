import { expect, test } from "vitest";
import contextBroker from "../../../extensions/context-broker.ts";

const g = globalThis as Record<string, unknown>;

test("read-only bash commands skip the broker; mutating ones consult it", async () => {
	let connects = 0;
	g.__pi_kp__ = {
		timeoutMs: 2000,
		connect: async () => {
			connects++;
			return {
				callTool: async () => ({ isError: false, content: [{ type: "text", text: "{}" }] }),
			};
		},
	};
	const toolCallHandlers: Array<(e: unknown) => Promise<unknown>> = [];
	const pi = {
		on(e: string, h: (x: unknown) => Promise<unknown>) {
			if (e === "tool_call") toolCallHandlers.push(h);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		registerTool() {},
		sendMessage() {},
	};
	try {
		contextBroker(pi as never);
		const fire = async (command: string) => {
			for (const h of toolCallHandlers) await h({ toolName: "bash", toolCallId: "t1", input: { command } });
		};

		// the live incident: an OS check must not touch the broker at all
		await fire("uname -a && cat /etc/os-release 2>/dev/null | head -10");
		expect(connects).toBe(0);
		// read-only git and pipes stay silent too
		await fire("git status && git log --oneline -5 | head -3");
		expect(connects).toBe(0);
		// mutations consult the gate
		await fire("git push --force origin main");
		expect(connects).toBeGreaterThan(0);
		const afterPush = connects;
		// redirects count as mutations even with read-only binaries
		await fire("cat /etc/os-release > /tmp/os.txt");
		expect(connects).toBeGreaterThan(afterPush);
	} finally {
		delete g.__pi_kp__;
	}
});

test("advisories are injected on the next model step without blocking the tool call", async () => {
	g.__pi_kp__ = {
		timeoutMs: 2000,
		connect: async () => ({
			callTool: async (request: { name: string }) => {
				if (request.name === "pi.pre_action_gate") {
					return { isError: false, content: [{ type: "text", text: JSON.stringify({ decision: "allow" }) }] };
				}
				return {
					isError: false,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								packet_id: "packet-1",
								candidates: [{ memory: { text: "Preserve upstream formatting", inject_role: "advisory" } }],
							}),
						},
					],
				};
			},
		}),
	};
	const handlers = new Map<string, Array<(event: never) => Promise<unknown>>>();
	const pi = {
		on(event: string, handler: (value: never) => Promise<unknown>) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		registerTool() {},
		sendMessage() {},
	};
	try {
		contextBroker(pi as never);
		const outcomes = [];
		for (const handler of handlers.get("tool_call") ?? []) {
			outcomes.push(
				await handler({ toolName: "write", toolCallId: "write-1", input: { path: "/tmp/new-file" } } as never),
			);
		}
		expect(outcomes.every((outcome) => outcome === undefined)).toBe(true);

		let transformed: unknown;
		for (const handler of handlers.get("context") ?? []) {
			transformed = (await handler({ messages: [] } as never)) ?? transformed;
		}
		expect(JSON.stringify(transformed)).toContain("Preserve upstream formatting");
	} finally {
		delete g.__pi_kp__;
	}
});
