import { describe as ddescribe, expect, it } from "vitest";
import {
	buildDigest,
	clip,
	extractResultText,
	keywordsOf,
	relevance,
	serialize,
	describe as toc,
} from "../../../extensions/kp-offload.ts";

ddescribe("kp-offload serialization", () => {
	it("clip keeps short strings verbatim and head+tails long ones", () => {
		expect(clip("hello", 100)).toBe("hello");
		const long = "x".repeat(1000);
		const out = clip(long, 100);
		expect(out.length).toBeLessThan(200);
		expect(out).toContain("chars elided");
		expect(out.startsWith("x")).toBe(true);
		expect(out.endsWith("x")).toBe(true);
	});

	it("serialize renders text, tool calls, and tool results faithfully", () => {
		const msgs = [
			{ role: "user", content: "fix the guard" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading it" },
					{ type: "toolCall", toolName: "read", input: { path: "guard.ts" } },
				],
			},
			{ role: "tool", content: [{ type: "toolResult", text: "export function guard() {}" }] },
		];
		const out = serialize(msgs);
		expect(out).toContain("### user");
		expect(out).toContain("fix the guard");
		expect(out).toContain("→ read(");
		expect(out).toContain("guard.ts");
		expect(out).toContain("← export function guard");
	});

	it("serialize truncates oversized tool results head+tail", () => {
		const huge = "L".repeat(20_000);
		const out = serialize([{ role: "tool", content: [{ type: "toolResult", text: huge }] }]);
		expect(out.length).toBeLessThan(6_000);
		expect(out).toContain("chars elided");
	});

	it("describe emits a typed TOC with read/write census and superseded reads", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "toolCall", toolName: "read", input: { path: "a.ts" } }] },
			{ role: "assistant", content: [{ type: "toolCall", toolName: "edit", input: { path: "a.ts" } }] },
		];
		const d = toc(msgs);
		expect(d).toContain("2 msgs");
		expect(d).toContain("1 reads");
		expect(d).toContain("1 writes");
		expect(d).toContain("superseded: a.ts"); // read then edited → stale
	});

	it("serialize skips empty messages", () => {
		expect(serialize([{ role: "assistant", content: [] }])).toBe("");
	});

	it("buildDigest extracts user intent, assistant conclusions, and errors VERBATIM", () => {
		const msgs = [
			{ role: "user", content: "add exponentiation to the calculator" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "let me look" },
					{ type: "toolCall", toolName: "read", input: { path: "calc.ts" } },
					{ type: "text", text: "added ** operator, right-associative" },
				],
			},
			{ role: "tool", content: [{ type: "toolResult", text: "npm test\nError: 2**3**2 expected 512 got 64" }] },
			{ role: "assistant", content: [{ type: "toolCall", toolName: "edit", input: { path: "calc.ts" } }] },
		];
		const d = buildDigest(msgs);
		// verbatim intent + conclusion (not paraphrased)
		expect(d).toContain("user: add exponentiation to the calculator");
		expect(d).toContain("did: added ** operator, right-associative");
		// error line lifted verbatim
		expect(d).toContain("Error: 2**3**2 expected 512 got 64");
		// typed activity line
		expect(d).toContain("activity:");
		expect(d).toContain("reads");
		// the digest must be far smaller than the full serialized transcript
		expect(d.length).toBeLessThan(serialize(msgs).length + 200);
	});

	it("keywordsOf keeps salient content words and drops stopwords", () => {
		const kw = keywordsOf("The auth guard must validate service tokens and reject expired tokens with a 401");
		expect(kw.has("tokens")).toBe(true);
		expect(kw.has("guard")).toBe(true);
		expect(kw.has("validate")).toBe(true);
		expect(kw.has("with")).toBe(false); // stopword
		expect(kw.has("the")).toBe(false); // stopword
	});

	it("relevance scores direction↔block term overlap", () => {
		const block = keywordsOf("refactor the auth guard to allow service tokens without breaking sessions");
		const near = new Set("now fix the auth guard token validation".match(/[a-z][a-z0-9_]{3,}/g) ?? []);
		const far = new Set("unrelated database migration for billing".match(/[a-z][a-z0-9_]{3,}/g) ?? []);
		expect(relevance(near, block)).toBeGreaterThanOrEqual(2); // guard, auth (token vs tokens differ)
		expect(relevance(far, block)).toBe(0);
	});

	it("extractResultText handles content blocks, strings, and objects", () => {
		expect(extractResultText("hello")).toBe("hello");
		expect(extractResultText({ content: [{ type: "text", text: "shift to auth" }] })).toBe("shift to auth");
		expect(extractResultText({ new_request: "x" })).toContain("new_request");
	});
});
