/**
 * Deterministic offline loop-step distiller — pure functions.
 *
 * The online adapter (in loop.ts) teaches ONE run from its own repeated
 * failures. This distills across ALL runs: a lesson the online system had to
 * re-invent in many separate loops should be promoted into the BASE prompt
 * permanently, so future loops start pre-loaded instead of re-learning it the
 * hard way. The online learned-steps are the training corpus; promotion is the
 * optimization; and because every run records the prompt version it used, the
 * effect is MEASURABLE — a promoted failure class should recur less afterward.
 */

export interface RunRecord {
	schemaVersion?: 1;
	taskId?: string;
	traceId?: string;
	snapshotId?: string;
	goal: string;
	/** base-prompt version this run used (bumped by each evaluated promotion). */
	promptVersion: number;
	rounds: number;
	rejections: number;
	completed: boolean;
	/** learned steps the ONLINE optimizer minted during this run. */
	learned: Array<{ cls: string; text: string }>;
}

export interface BaselineStep {
	cls: string;
	/** canonical instruction (run-specific evidence stripped). */
	text: string;
	/** distinct runs that had to learn this before it was promoted. */
	runs: number;
	/** prompt version at which it was promoted. */
	version: number;
}

export interface Proposal {
	cls: string;
	text: string;
	runs: number;
	sampleGoals: string[];
}

/** One scalar per run: completed dominates; rounds and rejected claims are
 *  costs. Used to trend prompt versions against each other. */
export function scoreRun(r: RunRecord): number {
	return (r.completed ? 1 : 0) - 0.05 * r.rounds - 0.15 * r.rejections;
}

/** Strip the run-specific "(learned: … — evidence)" tail so per-class steps
 *  from different runs collapse to one canonical instruction. */
export function canonicalize(text: string): string {
	return text.replace(/\s*\(learned:[^)]*\)\s*$/i, "").trim();
}

export function parseJournal(text: string): RunRecord[] {
	const out: RunRecord[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const r = JSON.parse(t) as RunRecord;
			if (r && typeof r.goal === "string" && Array.isArray(r.learned)) out.push(r);
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

/** Group learned steps by failure class; a class recurring across >= minRuns
 *  DISTINCT runs (and not already promoted) is a promotion candidate. */
export function distill(runs: RunRecord[], existing: BaselineStep[], minRuns = 3): Proposal[] {
	const promoted = new Set(existing.map((b) => b.cls));
	const byClass = new Map<string, { goals: Set<string>; text: string }>();
	for (const run of runs) {
		for (const step of run.learned) {
			if (promoted.has(step.cls)) continue;
			const entry = byClass.get(step.cls) ?? { goals: new Set<string>(), text: canonicalize(step.text) };
			entry.goals.add(run.goal);
			// keep the longest canonical wording seen for the class
			const canon = canonicalize(step.text);
			if (canon.length > entry.text.length) entry.text = canon;
			byClass.set(step.cls, entry);
		}
	}
	const proposals: Proposal[] = [];
	for (const [cls, entry] of byClass) {
		if (entry.goals.size >= minRuns) {
			proposals.push({ cls, text: entry.text, runs: entry.goals.size, sampleGoals: [...entry.goals].slice(0, 5) });
		}
	}
	return proposals.sort((a, b) => b.runs - a.runs);
}

/** Effect measurement for an already-promoted class: how often runs minted it
 *  BEFORE vs AFTER the promotion version. A working promotion drives the
 *  after-rate toward zero (the base prompt now prevents it). */
export function recurrence(runs: RunRecord[], step: BaselineStep): { before: string; after: string } {
	let beforeRuns = 0;
	let beforeHit = 0;
	let afterRuns = 0;
	let afterHit = 0;
	for (const run of runs) {
		const hit = run.learned.some((l) => l.cls === step.cls);
		if (run.promptVersion < step.version) {
			beforeRuns += 1;
			if (hit) beforeHit += 1;
		} else {
			afterRuns += 1;
			if (hit) afterHit += 1;
		}
	}
	const fmt = (h: number, n: number) => (n === 0 ? "—" : `${h}/${n}`);
	return { before: fmt(beforeHit, beforeRuns), after: fmt(afterHit, afterRuns) };
}

/** Mean score of the most recent runs per prompt version, oldest→newest. */
export function versionTrend(runs: RunRecord[]): Array<{ version: number; runs: number; meanScore: number }> {
	const byVersion = new Map<number, number[]>();
	for (const run of runs) {
		const arr = byVersion.get(run.promptVersion) ?? [];
		arr.push(scoreRun(run));
		byVersion.set(run.promptVersion, arr);
	}
	return [...byVersion.entries()]
		.map(([version, scores]) => ({
			version,
			runs: scores.length,
			meanScore: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
		}))
		.sort((a, b) => a.version - b.version);
}
