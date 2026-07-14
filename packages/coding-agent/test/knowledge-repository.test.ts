import { describe, expect, test } from "vitest";
import {
	constrainContextSchema,
	constrainRepositorySchema,
	normalizeContextArguments,
	resolveRegisteredRepository,
	summarizeKnowledgeResult,
} from "../../../extensions/knowledge.ts";

const repositories = [
	{ repository: "licensing-service", root: "/home/siddharth/projects/dev/licensing-service" },
	{
		repository: "miniorange-iam-frontend",
		root: "/home/siddharth/projects/dev/frontend/miniorange-iam-frontend",
	},
];

describe("knowledge code repository resolution", () => {
	test("keeps exact registered names", () => {
		expect(resolveRegisteredRepository("licensing-service", "allocation", "/tmp", repositories)).toBe(
			"licensing-service",
		);
	});

	test("normalizes an invented prefix only when it has one registered match", () => {
		expect(resolveRegisteredRepository("forked-licensing-service", "allocation", "/tmp", repositories)).toBe(
			"licensing-service",
		);
	});

	test("uses a repository named in the query before the current cwd", () => {
		expect(
			resolveRegisteredRepository(
				"monorepo-dev",
				"find LicenseAllocation in miniorange-iam-frontend",
				"/home/siddharth/projects/dev/licensing-service",
				repositories,
			),
		).toBe("miniorange-iam-frontend");
	});

	test("uses cwd only when no explicit repository was supplied", () => {
		expect(
			resolveRegisteredRepository(
				undefined,
				"find allocation",
				"/home/siddharth/projects/dev/frontend/miniorange-iam-frontend/src",
				repositories,
			),
		).toBe("miniorange-iam-frontend");
		expect(resolveRegisteredRepository("monorepo-dev", "find allocation", "/tmp", repositories)).toBeUndefined();
		expect(
			resolveRegisteredRepository(
				"monorepo-dev",
				"find allocation",
				"/home/siddharth/projects/dev/licensing-service",
				repositories,
			),
		).toBeUndefined();
	});

	test("constrains the model schema to authoritative names", () => {
		const schema = constrainRepositorySchema(
			{ type: "object", properties: { query: { type: "string" }, repository: { type: "string" } } },
			repositories,
		) as { properties: { repository: { enum: string[]; description: string } } };
		expect(schema.properties.repository.enum).toEqual(["licensing-service", "miniorange-iam-frontend"]);
		expect(schema.properties.repository.description).toContain("never invent an alias");
	});

	test("owns task cwd and project instead of trusting model arguments", () => {
		expect(
			normalizeContextArguments(
				"pi_context_task",
				{
					text: "change license allocation",
					project: "monorepo-dev",
					repository: "forked-licensing-service",
					cwd: "/wrong",
				},
				"/home/siddharth/projects/dev/licensing-service",
				repositories,
			),
		).toEqual({
			text: "change license allocation",
			repository: "licensing-service",
			cwd: "/home/siddharth/projects/dev/licensing-service",
		});
	});

	test("does not send unsupported cwd to context_code", () => {
		expect(
			normalizeContextArguments(
				"pi_context_code",
				{ query: "LicenseAllocationHandler", repository: "licensing-service" },
				"/home/siddharth/projects/dev/licensing-service",
				repositories,
			),
		).toEqual({ query: "LicenseAllocationHandler", repository: "licensing-service" });
	});

	test("removes project selection from task schemas", () => {
		const schema = constrainContextSchema("pi_context_task", {
			type: "object",
			properties: { text: { type: "string" }, project: { type: "string" } },
			required: ["text", "project"],
		}) as { properties: Record<string, unknown>; required: string[] };
		expect(schema.properties.project).toBeUndefined();
		expect(schema.required).toEqual(["text"]);
	});

	test("renders typed failures as degraded instead of successful summaries", () => {
		const summary = summarizeKnowledgeResult("pi_context_code", [
			{
				type: "text",
				text: JSON.stringify({
					found: false,
					error: { code: "INDEX_STALE", message: "refresh the codemap" },
				}),
			},
		]);
		expect(summary).toContain("DEGRADED");
		expect(summary).toContain("INDEX_STALE");
	});
});
