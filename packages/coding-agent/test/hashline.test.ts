import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import hashline from "../../../extensions/hashline.ts";

// Collect the tools hashline registers, then drive them directly.
type Tool = {
	name: string;
	execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};
const tools = new Map<string, Tool>();
const pi = {
	on() {},
	registerTool(t: Tool) {
		tools.set(t.name, t);
	},
	registerCommand() {},
	registerShortcut() {},
	registerFlag() {},
};

let dir: string;
let origCwd: string;

beforeAll(() => {
	hashline(pi as never);
	origCwd = process.cwd();
	dir = mkdtempSync(join(tmpdir(), "hashline-"));
	process.chdir(dir);
});
afterAll(() => process.chdir(origCwd));

const call = (name: string, params: unknown) => tools.get(name)!.execute("t", params);
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

test("hread returns HASH│content and hedit replaces a range by anchor", async () => {
	writeFileSync(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
	const read = await call("hread", { path: "a.ts" });
	const lines = text(read).split("\n");
	// each shown line is `HASH│content`
	expect(lines[0]).toMatch(/^.{3}│const a = 1;$/);
	const hashOf = (s: string) => s.split("│")[0];
	const h1 = hashOf(lines[1]); // const b = 2;

	const edit = await call("hedit", { path: "a.ts", changes: [{ from: h1, to: h1, lines: ["const b = 20;"] }] });
	expect(edit.isError).toBeFalsy();
	expect(readFileSync(join(dir, "a.ts"), "utf-8")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
});

test("stale anchor is rejected (E_STALE), never a silent wrong-line edit", async () => {
	writeFileSync(join(dir, "b.ts"), "line one\nline two\n");
	const read = await call("hread", { path: "b.ts" });
	const h1 = text(read).split("\n")[0].split("│")[0]; // anchor for "line one" (seen)
	// File changes underneath: line one's content changes, so its hash no longer
	// matches — a seen anchor that is now stale. Must 404, not edit the wrong line.
	writeFileSync(join(dir, "b.ts"), "line ONE edited\nline two\n");
	const r = await call("hedit", { path: "b.ts", changes: [{ from: h1, to: h1, lines: ["x"] }] });
	expect(r.isError).toBe(true);
	expect(text(r)).toContain("[E_STALE]");
	// file untouched by the rejected edit
	expect(readFileSync(join(dir, "b.ts"), "utf-8")).toBe("line ONE edited\nline two\n");
});

test("seen-lines guard rejects an anchor hread never showed (E_UNSEEN)", async () => {
	writeFileSync(join(dir, "c.ts"), "aaa\nbbb\nccc\nddd\n");
	// only read the first 2 lines
	const read = await call("hread", { path: "c.ts", offset: 1, limit: 2 });
	const shownHashes = text(read)
		.split("\n")
		.map((l) => l.split("│")[0]);
	// grab a real hash for line 4 (never shown) via a full read on a twin file
	writeFileSync(join(dir, "c2.ts"), "aaa\nbbb\nccc\nddd\n");
	const full = await call("hread", { path: "c2.ts" });
	const h4 = text(full).split("\n")[3].split("│")[0];
	expect(shownHashes).not.toContain(h4);
	const r = await call("hedit", { path: "c.ts", changes: [{ from: h4, to: h4, lines: ["DDD"] }] });
	expect(r.isError).toBe(true);
	expect(text(r)).toContain("[E_UNSEEN]");
});

test("overlapping ranges in one hedit are rejected (E_OVERLAP)", async () => {
	writeFileSync(join(dir, "d.ts"), "l1\nl2\nl3\nl4\n");
	const read = await call("hread", { path: "d.ts" });
	const h = text(read)
		.split("\n")
		.map((l) => l.split("│")[0]);
	const r = await call("hedit", {
		path: "d.ts",
		changes: [
			{ from: h[0], to: h[2], lines: ["x"] },
			{ from: h[1], to: h[3], lines: ["y"] },
		],
	});
	expect(r.isError).toBe(true);
	expect(text(r)).toContain("[E_OVERLAP]");
});

test("hedit_block replaces a whole brace construct by its start anchor (JS fallback path)", async () => {
	writeFileSync(join(dir, "e.ts"), "function foo() {\n  return 1;\n}\nconst after = 9;\n");
	const read = await call("hread", { path: "e.ts" });
	const startHash = text(read).split("\n")[0].split("│")[0]; // `function foo() {`
	const r = await call("hedit_block", { path: "e.ts", from: startHash, lines: ["function foo() { return 42; }"] });
	expect(r.isError).toBeFalsy();
	expect(readFileSync(join(dir, "e.ts"), "utf-8")).toBe("function foo() { return 42; }\nconst after = 9;\n");
});
