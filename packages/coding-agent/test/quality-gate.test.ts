import { describe, expect, it } from "vitest";
import { bypassesCommitHooks, hasDebugDebris, isProtectedConfig } from "../../../extensions/quality-gate.ts";

describe("quality-gate detectors", () => {
	it("recognizes lint/format/ts configs and leaves ordinary files alone", () => {
		for (const path of [
			"/repo/biome.json",
			"/repo/tsconfig.json",
			"/repo/tsconfig.build.json",
			"/repo/.eslintrc.cjs",
			"/repo/eslint.config.mjs",
			"/repo/vitest.config.ts",
			"/repo/.prettierrc.yaml",
		]) {
			expect(isProtectedConfig(path), path).toBe(true);
		}
		for (const path of ["/repo/src/config.ts", "/repo/package.json", "/repo/settings.json", "/repo/tsconfig.md"]) {
			expect(isProtectedConfig(path), path).toBe(false);
		}
	});

	it("flags console.log/debugger debris only in production source", () => {
		expect(hasDebugDebris("/repo/src/service.ts", 'console.log("hi")')).toBe(true);
		expect(hasDebugDebris("/repo/src/service.ts", "debugger;\nrun()")).toBe(true);
		expect(hasDebugDebris("/repo/src/service.ts", 'logger.info("hi")')).toBe(false);
		expect(hasDebugDebris("/repo/test/service.test.ts", 'console.log("hi")')).toBe(false);
		expect(hasDebugDebris("/repo/scripts/tool.ts", 'console.log("hi")')).toBe(false);
		expect(hasDebugDebris("/repo/src/notes.md", "console.log")).toBe(false);
	});

	it("catches git commit --no-verify in compound commands", () => {
		expect(bypassesCommitHooks("git commit --no-verify -m x")).toBe(true);
		expect(bypassesCommitHooks("cd pkg && git add -A && git commit -m x --no-verify")).toBe(true);
		expect(bypassesCommitHooks("git commit -m 'use --no-verify never'")).toBe(true); // conservative: flag it
		expect(bypassesCommitHooks("git commit -m x")).toBe(false);
		expect(bypassesCommitHooks("git push origin main")).toBe(false);
	});
});
