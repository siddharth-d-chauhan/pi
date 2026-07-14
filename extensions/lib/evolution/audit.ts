import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSnapshot } from "./contracts.ts";
import { evolutionRoot, listMutationIds, loadActiveTaskManifest, loadLedger } from "./store.ts";
import { promptVersionOf, readCurrentBaseline } from "./workflow.ts";

export interface EvolutionAudit {
	configured: boolean;
	currentSnapshotId: string;
	promptVersion: number;
	standingSteps: number;
	activeTaskManifest?: string;
	tasks: number;
	mutations: number;
	proposed: number;
	evaluated: number;
	promotable: number;
	rejected: number;
	promoted: number;
	rolledBack: number;
	traces: number;
}

export function auditEvolution(cwd: string): EvolutionAudit {
	const steps = readCurrentBaseline(cwd);
	const version = promptVersionOf(steps);
	const current = createSnapshot(steps, version);
	const tasks = loadActiveTaskManifest(cwd);
	const ledger = loadLedger(cwd);
	const byMutation = new Map<string, typeof ledger>();
	for (const event of ledger) {
		const events = byMutation.get(event.mutationId) ?? [];
		events.push(event);
		byMutation.set(event.mutationId, events);
	}
	let traces = 0;
	try {
		traces = readFileSync(join(evolutionRoot(cwd), "traces", "runs.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean).length;
	} catch {
		// no traces yet
	}
	const states = [...byMutation.values()].map((events) => {
		const lastEvaluation = [...events].reverse().find((event) => event.type === "evaluated");
		const lastLifecycle = [...events]
			.reverse()
			.find((event) => event.type === "promoted" || event.type === "rolled_back");
		const eventTypes = events.map((event) => event.type);
		return {
			evaluated: Boolean(lastEvaluation),
			decision: lastEvaluation?.details?.decision,
			promoted: lastLifecycle?.type === "promoted",
			rolledBack: lastLifecycle?.type === "rolled_back",
			needsReevaluation:
				lastLifecycle?.type === "rolled_back" &&
				eventTypes.lastIndexOf("rolled_back") > eventTypes.lastIndexOf("evaluated"),
		};
	});
	return {
		configured: Boolean(tasks),
		currentSnapshotId: current.snapshotId,
		promptVersion: version,
		standingSteps: steps.length,
		activeTaskManifest: tasks?.manifestId,
		tasks: tasks?.tasks.length ?? 0,
		mutations: listMutationIds(cwd).length,
		proposed: states.filter((state) => !state.evaluated).length,
		evaluated: states.filter((state) => state.evaluated).length,
		promotable: states.filter((state) => state.decision === "promote" && !state.promoted && !state.needsReevaluation)
			.length,
		rejected: states.filter((state) => state.decision === "reject").length,
		promoted: states.filter((state) => state.promoted).length,
		rolledBack: states.filter((state) => state.rolledBack).length,
		traces,
	};
}
