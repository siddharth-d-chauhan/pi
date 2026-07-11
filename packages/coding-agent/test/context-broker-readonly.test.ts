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
