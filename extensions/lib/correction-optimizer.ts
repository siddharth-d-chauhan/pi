/**
 * User-correction optimizer (pure functions) — the same journal→distill→
 * promote→measure engine as the loop optimizer, but the failure signal is the
 * USER correcting the agent, and the mutable surface is the agent's standing
 * instructions. Corrections are freeform text (unlike the loop's fixed failure
 * classes), so distillation clusters them by keyword overlap and promotes a
 * cluster only when it recurred across enough DISTINCT sessions.
 */

export interface CorrectionRecord {
	/** distinct-session key — a lesson must recur across sessions, not within one. */
	session: string;
	text: string;
	/** "heuristic" (auto-detected) or "explicit" (/self note). */
	source: "heuristic" | "explicit";
}

export interface StandingInstruction {
	text: string;
	/** distinct sessions that prompted it before promotion. */
	sessions: number;
	version: number;
}

export interface CorrectionProposal {
	text: string;
	sessions: number;
	samples: string[];
}

const STOPWORDS = new Set(
	(
		"the a an and or but not no dont don't do does did is are was were be been being to of in on for with " +
		"you your i me my we it this that these those they them he she use using used again anymore stop should " +
		"shouldn't need needs want wants please just always never when why what how instead of like get got make " +
		"made will would can could also too very really actually nope nah yeah ok okay if then than as at by from"
	).split(/\s+/),
);

/** Content-word set of a correction (lowercased, stopwords/short tokens dropped,
 *  crude plural-stemmed so "merge"/"merges" and "tab"/"tabs" collapse). */
export function keywords(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		const stem = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
		if (stem.length >= 3 && !STOPWORDS.has(stem)) out.add(stem);
	}
	return out;
}

/** Asymmetric containment: fraction of `inner`'s words present in `outer`. */
function containment(inner: Set<string>, outer: Set<string>): number {
	if (inner.size === 0) return 0;
	let hit = 0;
	for (const x of inner) if (outer.has(x)) hit += 1;
	return hit / inner.size;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const x of a) if (b.has(x)) n += 1;
	return n;
}

/** Two short corrections are "the same lesson" when they share enough salient
 *  content words. Absolute overlap (>=2 shared words) is more robust than a
 *  jaccard ratio here, because each phrasing adds its own filler that dilutes
 *  the ratio below any useful threshold; jaccard is the fallback for very short
 *  corrections where 2-word overlap is impossible. */
function sameLesson(a: Set<string>, b: Set<string>, sim: number): boolean {
	return sharedCount(a, b) >= 2 || jaccard(a, b) >= sim;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter += 1;
	return inter / (a.size + b.size - inter);
}

export function parseJournal(text: string): CorrectionRecord[] {
	const out: CorrectionRecord[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const r = JSON.parse(t) as CorrectionRecord;
			if (r && typeof r.session === "string" && typeof r.text === "string") {
				out.push({ session: r.session, text: r.text, source: r.source === "explicit" ? "explicit" : "heuristic" });
			}
		} catch {
			// skip malformed
		}
	}
	return out;
}

/** Greedy keyword-overlap clustering of corrections, then promote clusters that
 *  span >= minSessions distinct sessions and don't already match a standing
 *  instruction. An explicit /self note counts immediately (minSessions=1 for it). */
export function distillCorrections(
	records: CorrectionRecord[],
	existing: StandingInstruction[],
	minSessions = 2,
	sim = 0.5,
): CorrectionProposal[] {
	const existingKw = existing.map((e) => keywords(e.text));
	const clusters: Array<{ kw: Set<string>; texts: string[]; sessions: Set<string>; explicit: boolean }> = [];
	for (const rec of records) {
		const kw = keywords(rec.text);
		if (kw.size === 0) continue;
		let placed = false;
		for (const c of clusters) {
			if (sameLesson(kw, c.kw, sim)) {
				c.texts.push(rec.text);
				c.sessions.add(rec.session);
				c.explicit = c.explicit || rec.source === "explicit";
				for (const w of kw) c.kw.add(w);
				placed = true;
				break;
			}
		}
		if (!placed) {
			clusters.push({
				kw: new Set(kw),
				texts: [rec.text],
				sessions: new Set([rec.session]),
				explicit: rec.source === "explicit",
			});
		}
	}
	const proposals: CorrectionProposal[] = [];
	for (const c of clusters) {
		const threshold = c.explicit ? 1 : minSessions;
		if (c.sessions.size < threshold) continue;
		// already covered by a standing instruction? An existing rule covers this
		// cluster when most of the rule's OWN content words appear in it
		// (containment, not jaccard — the cluster's union of phrasings is larger
		// and would dilute a symmetric measure below any useful threshold).
		if (existingKw.some((e) => containment(e, c.kw) >= 0.6)) continue;
		// representative = the clearest (longest) phrasing in the cluster.
		const text = [...c.texts].sort((a, b) => b.length - a.length)[0];
		proposals.push({ text, sessions: c.sessions.size, samples: [...new Set(c.texts)].slice(0, 4) });
	}
	return proposals.sort((a, b) => b.sessions - a.sessions);
}
