import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import {
	type CorrectionRecord,
	cosine,
	distillCorrections,
	distillCorrectionsSemantic,
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

test("semantic distill: paraphrases with NO shared words still cluster by vector", () => {
	// Two ways of saying the same thing with disjoint vocabulary + one unrelated.
	// (unit vectors; a/b near-parallel, c orthogonal-ish — what the KP embedder gives)
	const records: CorrectionRecord[] = [
		{ session: "s1", text: "wrap external calls in a retry", source: "heuristic" },
		{ session: "s2", text: "add backoff around network requests", source: "heuristic" },
		{ session: "s3", text: "the button should be blue", source: "heuristic" },
	];
	const vectors = [
		[1, 0.05, 0],
		[0.98, 0.2, 0], // ~0.96 cosine with the first -> same cluster
		[0, 0, 1], // unrelated
	];
	expect(cosine(vectors[0], vectors[1])).toBeGreaterThan(0.9);
	// no keyword overlap between the two retry phrasings
	expect(jaccard(keywords(records[0].text), keywords(records[1].text)).valueOf()).toBeLessThan(0.2);
	// keyword distill FAILS to group them (each its own 1-session cluster)
	expect(distillCorrections(records, [], 2).length).toBe(0);
	// semantic distill groups the two paraphrases across 2 sessions -> 1 candidate
	const props = distillCorrectionsSemantic(records, vectors, [], 2, 0.78);
	expect(props.length).toBe(1);
	expect(props[0].sessions).toBe(2);
	// coverage: an existing instruction whose vector is near the cluster is skipped
	expect(distillCorrectionsSemantic(records, vectors, [[0.99, 0.1, 0]], 2, 0.78).length).toBe(0);
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
