import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import compactPatch from "../../../extensions/compact-patch.ts";

interface RegisteredPatchTool {
	execute(
		toolCallId: string,
		params: { path: string; patch: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function register(active = ["read", "edit", "write", "apply_patch"]) {
	let tool: RegisteredPatchTool | undefined;
	let start: (() => Promise<void>) | undefined;
	let selected: string[] | undefined;
	compactPatch({
		registerTool(candidate: unknown) {
			tool = candidate as RegisteredPatchTool;
		},
		on(event: string, handler: () => Promise<void>) {
			if (event === "session_start") start = handler;
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			selected = names;
		},
	} as never);
	if (!tool || !start) throw new Error("compact patch extension did not register");
	return { tool, start, selected: () => selected };
}

test("replaces the verbose edit schema with a stable compact patch schema", async () => {
	const extension = register();
	await extension.start();
	expect(extension.selected()).toEqual(["read", "write", "apply_patch"]);
});

test("applies strict single-file unified hunks", async () => {
	const extension = register();
	const root = mkdtempSync(join(tmpdir(), "compact-patch-"));
	const path = join(root, "example.ts");
	writeFileSync(path, "const one = 1;\nconst two = 2;\n", "utf8");
	const result = await extension.tool.execute(
		"patch-1",
		{
			path: "example.ts",
			patch: "@@ -1,2 +1,2 @@\n const one = 1;\n-const two = 2;\n+const two = 3;\n",
		},
		undefined,
		undefined,
		{ cwd: root },
	);
	expect(readFileSync(path, "utf8")).toBe("const one = 1;\nconst two = 3;\n");
	expect(result.content[0].text).toContain("Applied patch");
	rmSync(root, { recursive: true });
});

test("resolves multiple bare hunks from exact current-file context", async () => {
	const extension = register();
	const root = mkdtempSync(join(tmpdir(), "compact-patch-"));
	const path = join(root, "example.ts");
	writeFileSync(path, "import { one } from './one';\n\nconst first = 1;\nconst second = 2;\n", "utf8");
	await extension.tool.execute(
		"patch-1",
		{
			path: "example.ts",
			patch: "@@\n import { one } from './one';\n+import { two } from './two';\n@@\n const first = 1;\n-const second = 2;\n+const second = 3;\n",
		},
		undefined,
		undefined,
		{ cwd: root },
	);
	expect(readFileSync(path, "utf8")).toBe(
		"import { one } from './one';\nimport { two } from './two';\n\nconst first = 1;\nconst second = 3;\n",
	);
	rmSync(root, { recursive: true });
});

test("resolves a bare hunk after a numbered hunk", async () => {
	const extension = register();
	const root = mkdtempSync(join(tmpdir(), "compact-patch-"));
	const path = join(root, "example.ts");
	writeFileSync(path, "const one = 1;\nconst two = 2;\nconst three = 3;\n", "utf8");
	await extension.tool.execute(
		"patch-1",
		{
			path: "example.ts",
			patch: "@@ -1,1 +1,2 @@\n const one = 1;\n+const inserted = true;\n@@\n const two = 2;\n-const three = 3;\n+const three = 4;\n",
		},
		undefined,
		undefined,
		{ cwd: root },
	);
	expect(readFileSync(path, "utf8")).toBe(
		"const one = 1;\nconst inserted = true;\nconst two = 2;\nconst three = 4;\n",
	);
	rmSync(root, { recursive: true });
});

test("rejects ambiguous bare context without changing the file", async () => {
	const extension = register();
	const root = mkdtempSync(join(tmpdir(), "compact-patch-"));
	const path = join(root, "example.ts");
	const original = "const value = 1;\nconst value = 1;\n";
	writeFileSync(path, original, "utf8");
	await expect(
		extension.tool.execute(
			"patch-1",
			{ path: "example.ts", patch: "@@\n-const value = 1;\n+const value = 2;\n" },
			undefined,
			undefined,
			{ cwd: root },
		),
	).rejects.toThrow("ambiguous");
	expect(readFileSync(path, "utf8")).toBe(original);
	rmSync(root, { recursive: true });
});

test("rejects stale hunks without changing the file", async () => {
	const extension = register();
	const root = mkdtempSync(join(tmpdir(), "compact-patch-"));
	const path = join(root, "example.ts");
	const original = "const value = 1;\n";
	writeFileSync(path, original, "utf8");
	await expect(
		extension.tool.execute(
			"patch-1",
			{ path: "example.ts", patch: "@@ -1 +1 @@\n-const value = 2;\n+const value = 3;\n" },
			undefined,
			undefined,
			{ cwd: root },
		),
	).rejects.toThrow("did not match");
	expect(readFileSync(path, "utf8")).toBe(original);
	rmSync(root, { recursive: true });
});
