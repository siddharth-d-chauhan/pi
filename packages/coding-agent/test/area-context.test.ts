import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import areaContext from "../../../extensions/area-context.ts";

const g = globalThis as Record<string, unknown>;
const origCwd = process.cwd();

afterEach(() => {
	process.chdir(origCwd);
	delete g.__pi_kp__;
	delete g.__pi_workframe__;
});

test("area drift mid-turn injects that area's packet once per epoch", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/area-ctx-`);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "context-areas.json"),
		JSON.stringify({
			areas: {
				licensing: ["src/licensing/"],
				broker: ["src/broker/"],
			},
		}),
	);
	process.chdir(cwd);

	const kpCalls: Array<Record<string, unknown>> = [];
	g.__pi_kp__ = {
		timeoutMs: 4000,
		connect: async () => ({
			callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
				kpCalls.push({ name: req.name, ...req.arguments });
				const area = req.arguments.area as string;
				const candidates =
					area === "licensing"
						? [
								{
									memory: {
										kind: "Knowledge",
										text: "License grace period is 14 days.",
										inject_role: "advisory",
									},
								},
								{
									memory: {
										kind: "Pitfall",
										text: "Never cache entitlements across tenants.",
										inject_role: "must_follow",
									},
								},
							]
						: []; // broker area has nothing filed
				return {
					isError: false,
					content: [{ type: "text", text: JSON.stringify({ candidates, freshness: { area } }) }],
				};
			},
		}),
	};

	const sent: Array<{
		msg: { customType: string; content: string; details?: Record<string, unknown> };
		opts?: Record<string, unknown>;
	}> = [];
	const handlers = new Map<string, (e: unknown) => Promise<void>>();
	let areasCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: (e: unknown) => Promise<void>) {
			handlers.set(event, handler);
		},
		sendMessage(msg: never, opts?: Record<string, unknown>) {
			sent.push({ msg, opts });
		},
		registerMessageRenderer() {},
		registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			areasCommand = def.handler;
		},
	};
	areaContext(pi as never);
	const fire = async (args: unknown) => {
		await handlers.get("tool_execution_start")?.({ type: "tool_execution_start", toolName: "edit", args });
		await new Promise((r) => setTimeout(r, 30));
	};

	// touching a licensing file injects the licensing packet as a steer
	await fire({ file_path: `${cwd}/src/licensing/guard.ts` });
	expect(kpCalls.length).toBe(1);
	expect(kpCalls[0].area).toBe("licensing");
	expect(sent.length).toBe(1);
	expect(sent[0].msg.customType).toBe("area-context");
	expect(sent[0].msg.content).toContain("License grace period");
	expect(sent[0].msg.content).toContain("! [Pitfall]");
	expect(sent[0].opts?.deliverAs).toBe("steer");

	// same area again -> deduped, no new call
	await fire({ file_path: `${cwd}/src/licensing/api.ts` });
	expect(kpCalls.length).toBe(1);

	// drift into broker mid-session -> queried once; empty packet -> no message, cached
	await fire({ cmd: `cat ${cwd}/src/broker/packet.py` });
	expect(kpCalls.length).toBe(2);
	expect(kpCalls[1].area).toBe("broker");
	expect(sent.length).toBe(1);
	await fire({ file_path: `${cwd}/src/broker/other.py` });
	expect(kpCalls.length).toBe(2);

	// unmapped paths never query
	await fire({ file_path: `${cwd}/README.md` });
	expect(kpCalls.length).toBe(2);

	// direction change (new epoch) re-arms the areas
	g.__pi_workframe__ = { epoch: 2 };
	await fire({ file_path: `${cwd}/src/licensing/guard.ts` });
	expect(kpCalls.length).toBe(3);
	expect(sent.length).toBe(2);

	// /areas shows the map with injected markers
	const ctx = { cwd, ui: { notify: (t: string) => notifications.push(t) } };
	await areasCommand?.("", ctx);
	expect(notifications[0]).toContain("licensing");
	expect(notifications[0]).toContain("● licensing");
});

test("no map file -> extension is inert", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/area-ctx-empty-`);
	process.chdir(cwd);
	let called = 0;
	g.__pi_kp__ = {
		timeoutMs: 4000,
		connect: async () => ({
			callTool: async () => {
				called++;
				return { isError: false, content: [] };
			},
		}),
	};
	const handlers = new Map<string, (e: unknown) => Promise<void>>();
	const pi = {
		on(event: string, handler: (e: unknown) => Promise<void>) {
			handlers.set(event, handler);
		},
		sendMessage() {},
		registerMessageRenderer() {},
		registerCommand() {},
	};
	areaContext(pi as never);
	await handlers.get("tool_execution_start")?.({
		type: "tool_execution_start",
		toolName: "edit",
		args: { file_path: "src/licensing/x.ts" },
	});
	await new Promise((r) => setTimeout(r, 20));
	expect(called).toBe(0);
});
