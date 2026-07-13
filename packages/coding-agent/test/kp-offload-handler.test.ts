import { afterEach, beforeEach, describe, expect, it } from "vitest";
import kpOffload from "../../../extensions/kp-offload.ts";

// The extension reads KP_OFFLOAD at registration time; set it before import-use.
const g = globalThis as Record<string, unknown>;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type ToolDef = { name: string; execute: (id: string, input: unknown) => Promise<{ content: Array<{ text: string }> }> };

interface MockPi {
	handlers: Map<string, Handler>;
	tools: Map<string, ToolDef>;
	commands: Map<string, unknown>;
	on(event: string, handler: Handler): void;
	registerTool(def: ToolDef): void;
	registerCommand(name: string, def: unknown): void;
}

function mockPi(): MockPi {
	const p: MockPi = {
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		on(event, handler) {
			p.handlers.set(event, handler);
		},
		registerTool(def) {
			p.tools.set(def.name, def);
		},
		registerCommand(name, def) {
			p.commands.set(name, def);
		},
	};
	return p;
}

// Canned KP: ingest returns a blob_ref envelope; fetch_blob returns the stored text.
function mockKp() {
	const store = new Map<string, string>();
	let n = 0;
	g.__pi_kp__ = {
		timeoutMs: 1000,
		connect: async () => ({
			callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
				if (name === "knowledge.ingest") {
					const ref = `blob://deadbeef${n++}`;
					store.set(ref, String(args.text));
					return { content: [{ type: "text", text: JSON.stringify({ blob_ref: ref, ok: true }) }] };
				}
				if (name === "knowledge.fetch_blob") {
					const text = store.get(String(args.locator)) ?? "";
					return {
						content: [{ type: "text", text: JSON.stringify({ text, truncated: false, byte_size: text.length }) }],
					};
				}
				return { content: [] };
			},
		}),
	};
	return { store };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("kp-offload compaction wiring", () => {
	beforeEach(() => {
		process.env.KP_OFFLOAD = "1";
	});
	afterEach(() => {
		delete process.env.KP_OFFLOAD;
		delete g.__pi_kp__;
	});

	it("archives verbatim, cancels the blind compaction, and re-compacts with a pointer", async () => {
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);

		const handler = pi.handlers.get("session_before_compact");
		expect(handler).toBeDefined();

		const compactCalls: Array<{ customInstructions?: string }> = [];
		const event = {
			preparation: {
				messagesToSummarize: [
					{ role: "user", content: "fix the auth guard" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "reading it" },
							{ type: "toolCall", toolName: "read", input: { path: "guard.ts" } },
						],
					},
				],
			},
		};
		const ctx = { compact: (opts: { customInstructions?: string }) => compactCalls.push(opts) };

		const result = (await handler!(event, ctx)) as { cancel?: boolean };
		expect(result?.cancel).toBe(true); // blind compaction cancelled
		await flush(); // let the deferred re-compact fire

		expect(compactCalls).toHaveLength(1);
		const instr = compactCalls[0].customInstructions ?? "";
		expect(instr).toContain("archived VERBATIM");
		expect(instr).toContain("context_recall");
		expect(instr).toMatch(/A1/); // the block id
		expect(instr).toContain("1 reads"); // typed TOC from describe()
	});

	it("context_recall lists blocks, then returns the exact archived text (envelope decoded)", async () => {
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);
		const handler = pi.handlers.get("session_before_compact")!;

		const original = "VERBATIM decision: service tokens bypass the user check\nline-4000 END";
		const event = { preparation: { messagesToSummarize: [{ role: "assistant", content: original }] } };
		await handler(event, { compact: () => {} });
		await flush();

		const recall = pi.tools.get("context_recall")!;

		// no id → list
		const list = await recall.execute("t", {});
		expect(list.content[0].text).toContain("A1");

		// id → exact text, envelope decoded to raw content
		const got = await recall.execute("t", { id: "A1" });
		expect(got.content[0].text).toContain("VERBATIM decision: service tokens bypass the user check");
		expect(got.content[0].text).toContain("line-4000 END");
	});

	it("does not register anything when KP_OFFLOAD is unset", async () => {
		delete process.env.KP_OFFLOAD;
		const pi = mockPi();
		kpOffload(pi as never);
		expect(pi.handlers.size).toBe(0);
		expect(pi.tools.size).toBe(0);
	});

	it("fails open (no cancel) when there are no messages to archive", async () => {
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);
		const handler = pi.handlers.get("session_before_compact")!;
		const result = await handler({ preparation: { messagesToSummarize: [] } }, { compact: () => {} });
		expect(result).toBeUndefined(); // let pi compact normally
	});
});
