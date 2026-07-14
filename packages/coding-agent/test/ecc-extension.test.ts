import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRules, fillArguments, frontmatterDescription, searchLibrary } from "../../../extensions/ecc.ts";

describe("ecc markdown plumbing", () => {
	it("extracts the frontmatter description", () => {
		const source = "---\ndescription: Code review — local or PR\nargument-hint: [pr]\n---\n\n# Body";
		expect(frontmatterDescription(source)).toBe("Code review — local or PR");
		expect(frontmatterDescription("# no frontmatter")).toBe("");
	});

	it("substitutes $ARGUMENTS everywhere, with a placeholder when empty", () => {
		expect(fillArguments("review $ARGUMENTS now: $ARGUMENTS", "PR 42")).toBe("review PR 42 now: PR 42");
		expect(fillArguments("review $ARGUMENTS", "")).toBe("review (none)");
	});

	it("appends args as input when the playbook has no placeholder", () => {
		expect(fillArguments("# Fixed playbook", "extra scope")).toBe("# Fixed playbook\n\n**Input**: extra scope");
		expect(fillArguments("# Fixed playbook", "")).toBe("# Fixed playbook");
	});
});

// Real-library smoke: runs only where the central install exists.
const home = process.env.PI_ECC_HOME ?? join(homedir(), ".pi", "ecc");
describe.skipIf(!existsSync(join(home, "commands")))("ecc library smoke (real checkout)", () => {
	it("finds the code-review command by search", () => {
		const hits = searchLibrary(home, "code review");
		expect(hits.some((hit) => hit.startsWith("command code-review"))).toBe(true);
	});

	it("collects common + language rules, name-tagged and size-capped", () => {
		const rules = collectRules(home, "typescript");
		expect(rules).toContain("## rules/common/coding-style.md");
		expect(rules).toContain("## rules/typescript/coding-style.md");
		expect(rules.length).toBeLessThanOrEqual(60_000);
	});
});
