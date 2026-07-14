import { describe, expect, test } from "vitest";
import { formatThinkingSummary, formatToolCallSummary } from "../src/core/tool-call-summary.ts";

describe("formatToolCallSummary", () => {
	test("renders interactive-style find details", () => {
		expect(
			formatToolCallSummary(
				"find",
				{
					pattern: "*License*Allocation*",
					path: "/home/siddharth/projects/dev/frontend/miniorange-iam-frontend",
					limit: 100,
				},
				"/home/siddharth/pi",
			),
		).toBe("find *License*Allocation* in ~/projects/dev/frontend/miniorange-iam-frontend (limit 100)");
	});

	test("shows agent prompts but bounds large payloads", () => {
		const summary = formatToolCallSummary(
			"agent",
			{ tasks: [{ agent: "explore", background: true, prompt: "Trace the allocation flow" }] },
			"/tmp",
		);
		expect(summary).toBe("agent explore (background) Trace the allocation flow");
		expect(formatToolCallSummary("write", { path: "a.ts", content: "secret body" }, "/tmp")).toBe("write a.ts");
	});

	test("redacts credential-like generic fields", () => {
		expect(formatToolCallSummary("remote_call", { token: "abc", action: "list" }, "/tmp")).toBe(
			"remote_call token=<redacted> action=list",
		);
	});
});

test("thinking summaries are flattened and bounded", () => {
	expect(formatThinkingSummary("first\n\nsecond", 24)).toBe("first second");
	expect(formatThinkingSummary("x".repeat(100), 24)).toHaveLength(24);
});
