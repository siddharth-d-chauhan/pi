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
	sent: Array<{ customType?: string; content?: string }>;
	on(event: string, handler: Handler): void;
	registerTool(def: ToolDef): void;
	registerCommand(name: string, def: unknown): void;
	sendMessage(msg: { customType?: string; content?: string }, opts?: unknown): Promise<void>;
}

function mockPi(): MockPi {
	const p: MockPi = {
		handlers: new Map(),
		tools: new Map(),
		commands: new Map(),
		sent: [],
		on(event, handler) {
			p.handlers.set(event, handler);
		},
		registerTool(def) {
			p.tools.set(def.name, def);
		},
		registerCommand(name, def) {
			p.commands.set(name, def);
		},
		async sendMessage(msg) {
			p.sent.push(msg);
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

	it("archives verbatim and returns a DETERMINISTIC compaction (digest + pointer, no LLM)", async () => {
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);

		const handler = pi.handlers.get("session_before_compact");
		expect(handler).toBeDefined();

		const event = {
			preparation: {
				firstKeptEntryId: "entry-42",
				tokensBefore: 12345,
				messagesToSummarize: [
					{ role: "user", content: "fix the auth guard to allow service tokens" },
					{
						role: "assistant",
						content: [
							{ type: "text", text: "reading it" },
							{ type: "toolCall", toolName: "read", input: { path: "guard.ts" } },
							{ type: "text", text: "done — service tokens now bypass the user check" },
						],
					},
				],
			},
		};

		const result = (await handler!(event, {})) as {
			compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
			cancel?: boolean;
		};
		// deterministic path: returns a compaction, does NOT cancel/re-trigger
		expect(result?.cancel).toBeUndefined();
		expect(result?.compaction).toBeDefined();
		const comp = result.compaction!;
		expect(comp.firstKeptEntryId).toBe("entry-42"); // passed through from preparation
		expect(comp.tokensBefore).toBe(12345);
		// digest carries VERBATIM high-value spans + the recall pointer
		expect(comp.summary).toContain("fix the auth guard to allow service tokens"); // user intent, verbatim
		expect(comp.summary).toContain("service tokens now bypass the user check"); // assistant conclusion
		expect(comp.summary).toContain("context_recall");
		expect(comp.summary).toMatch(/A1/);
	});

	it("context_recall lists blocks, then returns the exact archived text (envelope decoded)", async () => {
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);
		const handler = pi.handlers.get("session_before_compact")!;

		const original = "VERBATIM decision: service tokens bypass the user check\nline-4000 END";
		const event = {
			preparation: {
				firstKeptEntryId: "e1",
				tokensBefore: 100,
				messagesToSummarize: [{ role: "assistant", content: original }],
			},
		};
		await handler(event, {});
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

	it("auto-recalls the relevant block on a pi_context_shift (no model call)", async () => {
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);

		// 1) create an archived block about the auth guard / service tokens
		const compact = pi.handlers.get("session_before_compact")!;
		await compact(
			{
				preparation: {
					firstKeptEntryId: "e1",
					tokensBefore: 500,
					messagesToSummarize: [
						{
							role: "user",
							content: "refactor the auth guard to allow service tokens without breaking sessions",
						},
						{
							role: "assistant",
							content: "done — service tokens now bypass the user check but keep the scope gate",
						},
					],
				},
			},
			{},
		);

		// 2) a direction shift whose text overlaps that block's keywords
		const shift = pi.handlers.get("tool_execution_end")!;
		await shift(
			{
				toolName: "pi_context_shift",
				result: { content: [{ type: "text", text: "now revisit the auth guard service tokens scope handling" }] },
			},
			{},
		);
		await flush();

		// harness injected the block's content — deterministically, no context_recall call
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0].customType).toBe("kp-auto-recall");
		expect(pi.sent[0].content).toContain("service tokens now bypass the user check");

		// 3) an UNRELATED shift injects nothing, and the same block isn't re-injected
		await shift(
			{
				toolName: "pi_context_shift",
				result: { content: [{ type: "text", text: "unrelated billing database migration" }] },
			},
			{},
		);
		await flush();
		expect(pi.sent).toHaveLength(1); // still just the one
	});

	it("does not auto-recall when KP_OFFLOAD_AUTORECALL=0", async () => {
		process.env.KP_OFFLOAD_AUTORECALL = "0";
		mockKp();
		const pi = mockPi();
		kpOffload(pi as never);
		const compact = pi.handlers.get("session_before_compact")!;
		await compact(
			{
				preparation: {
					firstKeptEntryId: "e1",
					tokensBefore: 500,
					messagesToSummarize: [{ role: "user", content: "auth guard service tokens scope" }],
				},
			},
			{},
		);
		const shift = pi.handlers.get("tool_execution_end")!;
		await shift(
			{
				toolName: "pi_context_shift",
				result: { content: [{ type: "text", text: "auth guard service tokens scope" }] },
			},
			{},
		);
		await flush();
		expect(pi.sent).toHaveLength(0);
		delete process.env.KP_OFFLOAD_AUTORECALL;
	});
});
