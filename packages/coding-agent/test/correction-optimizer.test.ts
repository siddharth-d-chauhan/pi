import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
	type CorrectionRecord,
	distillCorrections,
	jaccard,
	keywords,
	parseJournal,
	type StandingInstruction,
} from "../../../extensions/lib/correction-optimizer.ts";

const DEMO = process.env.DEMO === "1";
const show = (label: string, obj: unknown) => {
	if (!DEMO) return;
	process.stderr.write(`\n${"═".repeat(72)}\n${label}\n${"─".repeat(72)}\n${obj}\n`);
};

test("keywords drops stopwords/short tokens; jaccard overlaps content words", () => {
	const k = keywords("Don't auto-merge on GitHub, we use Bitbucket");
	expect(k.has("github")).toBe(true);
	expect(k.has("bitbucket")).toBe(true);
	expect(k.has("merge")).toBe(true);
	expect(k.has("the")).toBe(false);
	expect(
		jaccard(keywords("use bitbucket not github for merges"), keywords("we merge on bitbucket github")),
	).toBeGreaterThan(0.4);
});

test("distill: a lesson recurring across DISTINCT sessions becomes a candidate", () => {
	const records: CorrectionRecord[] = [
		{ session: "s1", text: "no, don't auto-merge on github, we use bitbucket", source: "heuristic" },
		// same session repeat must NOT count as a second session
		{ session: "s1", text: "again, bitbucket not github for merges", source: "heuristic" },
		{ session: "s2", text: "stop trying to merge on github — it's bitbucket", source: "heuristic" },
		// an unrelated one-off correction
		{ session: "s3", text: "actually use tabs not spaces here", source: "heuristic" },
	];
	// bitbucket/github/merge cluster spans s1+s2 = 2 distinct sessions -> candidate.
	// tabs/spaces is one session -> not.
	const props = distillCorrections(records, [], 2);
	show("candidates", JSON.stringify(props, null, 2));
	expect(props.length).toBe(1);
	expect(props[0].text.toLowerCase()).toContain("bitbucket");
	expect(props[0].sessions).toBe(2);

	// an explicit /self note counts immediately (1 session)
	const withNote: CorrectionRecord[] = [
		{ session: "s9", text: "prefer pnpm over npm in this repo", source: "explicit" },
	];
	expect(distillCorrections(withNote, [], 2).length).toBe(1);

	// already-covered lessons are not re-proposed
	const existing: StandingInstruction[] = [{ text: "use bitbucket not github for merges", sessions: 2, version: 2 }];
	expect(distillCorrections(records, existing, 2).length).toBe(0);
});

test("parseJournal tolerates junk and normalizes source", () => {
	const j = [
		'{"session":"s1","text":"no do X","source":"explicit"}',
		"not json",
		'{"session":"s2","text":"stop Y"}',
	].join("\n");
	const recs = parseJournal(j);
	expect(recs.length).toBe(2);
	expect(recs[1].source).toBe("heuristic"); // default when absent
	mkdtempSync(`${tmpdir()}/x-`); // touch fs api to keep import shape parallel to siblings
});
