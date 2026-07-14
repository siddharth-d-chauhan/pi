import { afterEach, expect, test, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	...(await import("../src/core/background-process-registry.ts")),
}));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	notify: vi.fn(),
}));

import agentNotify from "../../../extensions/agent-notify.ts";
import {
	getBackgroundProcessRegistry,
	resetForTests as resetRegistry,
} from "../src/core/background-process-registry.ts";

afterEach(() => resetRegistry());

test("ACP receives background agent activity and completion metrics", async () => {
	const handlers = new Map<string, (event: never, context: never) => Promise<void>>();
	agentNotify({
		on(event: string, handler: (event: never, context: never) => Promise<void>) {
			handlers.set(event, handler);
		},
		registerMessageRenderer() {},
	} as never);
	const notify = vi.fn();
	await handlers.get("session_start")?.({} as never, { mode: "rpc", ui: { notify } } as never);

	const registry = getBackgroundProcessRegistry();
	const id = registry.register({
		kind: "subagent",
		label: "explore · inspect allocation",
		agentType: "explore",
	});
	registry.appendLog(id, "↳ find *License*Allocation* in ~/projects/dev/frontend (limit 100)");
	registry.update(id, { metrics: { tokens: 2_400, costUsd: 0.0123, requests: 4 }, resultHandle: "agent://result" });
	registry.setStatus(id, "idle");

	expect(notify).toHaveBeenCalledWith("explore: ↳ find *License*Allocation* in ~/projects/dev/frontend (limit 100)");
	expect(notify).toHaveBeenCalledWith(expect.stringContaining("2400 tok | $0.0123 | 4 req"), "info");
	expect(notify).toHaveBeenCalledWith(expect.stringContaining("result: agent://result"), "info");
	await handlers.get("session_shutdown")?.({} as never, {} as never);
});
