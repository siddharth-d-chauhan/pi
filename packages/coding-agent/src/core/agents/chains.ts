/**
 * Chains — declarative multi-agent orchestration.
 *
 * A chain is a YAML file describing stages that run subagents in a DAG:
 *
 *   name: feature-flow
 *   description: Plan → implement → review
 *   stages:
 *     - id: plan
 *       agent: plan
 *       prompt: "Design an approach for: {{input}}"
 *     - id: build
 *       agent: worker
 *       model: pi/slow                 # optional per-stage model override
 *       prompt: "Implement this plan:\n{{plan.result}}"
 *       verify: "npm run check"        # shell gate; failure feeds back
 *       max_iters: 2                   # verify retries (default 2)
 *       on_fail: stop                  # stop (default) | continue
 *     - id: review
 *       agent: reviewer
 *       needs: [build]                 # deps; default = the previous stage
 *       prompt: "Review the diff. The plan was {{plan.handle}}."
 *
 * Interpolation: `{{input}}`, `{{stage.result}}` (inlined when small,
 * substituted with the agent:// handle + note when large), and
 * `{{stage.handle}}` (always the handle). Stages whose `needs` are all
 * satisfied run in parallel.
 *
 * Verify failures do NOT respawn: the stage's agent is still idle
 * (lifecycle keep-alive), so the failure output is delivered to the SAME
 * agent as a message and its fix is re-verified — up to `max_iters` times.
 *
 * Discovery: project `.pi/chains/*.yaml|yml` then user
 * `~/.pi/agent/chains/` (first name wins).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentSession } from "../agent-session.ts";
import { getBackgroundProcessRegistry } from "../background-process-registry.ts";
import { execCommand } from "../exec.ts";
import type { AgentDefinitionRegistry } from "./definitions.ts";
import { deliverToAgent } from "./lifecycle.ts";
import { type SpawnDeps, type SpawnResult, spawnAgent } from "./spawn.ts";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ChainStage {
	id: string;
	agent: string;
	prompt: string;
	model?: string;
	context?: string;
	needs: string[];
	verify?: string;
	maxIters: number;
	onFail: "stop" | "continue";
}

export interface ChainDefinition {
	name: string;
	description?: string;
	stages: ChainStage[];
	source: "project" | "user";
	filePath: string;
}

/** Inline interpolation cap — larger stage results substitute their handle. */
const INLINE_RESULT_CAP = 2_000;
/** Verify command timeout. */
const VERIFY_TIMEOUT_MS = 300_000;
/** Tail of verify output fed back to the agent on failure. */
const VERIFY_FEEDBACK_CAP = 4_000;

export class ChainValidationError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parse + validate one chain file. Throws ChainValidationError with a helpful message. */
export function parseChain(rawContent: string, filePath: string, source: ChainDefinition["source"]): ChainDefinition {
	let parsed: unknown;
	try {
		parsed = parseYaml(rawContent);
	} catch (err) {
		throw new ChainValidationError(`${filePath}: invalid YAML — ${(err as Error).message}`);
	}
	const root = asRecord(parsed);
	if (!root) throw new ChainValidationError(`${filePath}: chain file must be a YAML mapping`);
	const name = typeof root.name === "string" ? root.name.trim().toLowerCase() : "";
	if (!name) throw new ChainValidationError(`${filePath}: missing required "name"`);
	if (!Array.isArray(root.stages) || root.stages.length === 0) {
		throw new ChainValidationError(`${filePath}: "stages" must be a non-empty list`);
	}

	const stages: ChainStage[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < root.stages.length; i++) {
		const raw = asRecord(root.stages[i]);
		if (!raw) throw new ChainValidationError(`${filePath}: stage ${i + 1} must be a mapping`);
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) throw new ChainValidationError(`${filePath}: stage ${i + 1} is missing "id"`);
		if (seen.has(id)) throw new ChainValidationError(`${filePath}: duplicate stage id "${id}"`);
		seen.add(id);
		const agent = typeof raw.agent === "string" ? raw.agent.trim().toLowerCase() : "";
		if (!agent) throw new ChainValidationError(`${filePath}: stage "${id}" is missing "agent"`);
		const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
		if (!prompt.trim()) throw new ChainValidationError(`${filePath}: stage "${id}" is missing "prompt"`);
		const needsRaw = raw.needs;
		let needs: string[];
		if (needsRaw === undefined) {
			// Default: depend on the previous stage (sequential flow).
			needs = i > 0 ? [stages[i - 1].id] : [];
		} else if (Array.isArray(needsRaw) && needsRaw.every((n) => typeof n === "string")) {
			needs = (needsRaw as string[]).map((n) => n.trim());
		} else {
			throw new ChainValidationError(`${filePath}: stage "${id}" has an invalid "needs" (list of stage ids)`);
		}
		const onFail = raw.on_fail ?? raw.onFail ?? "stop";
		if (onFail !== "stop" && onFail !== "continue") {
			throw new ChainValidationError(`${filePath}: stage "${id}" on_fail must be "stop" or "continue"`);
		}
		const maxItersRaw = raw.max_iters ?? raw.maxIters;
		const maxIters =
			maxItersRaw === undefined ? 2 : typeof maxItersRaw === "number" && maxItersRaw >= 0 ? maxItersRaw : -1;
		if (maxIters === -1) {
			throw new ChainValidationError(`${filePath}: stage "${id}" max_iters must be a non-negative number`);
		}
		stages.push({
			id,
			agent,
			prompt,
			model: typeof raw.model === "string" ? raw.model : undefined,
			context: typeof raw.context === "string" ? raw.context : undefined,
			needs,
			verify: typeof raw.verify === "string" && raw.verify.trim() ? raw.verify : undefined,
			maxIters,
			onFail,
		});
	}

	// Unknown deps + cycle detection (topological order check).
	for (const stage of stages) {
		for (const dep of stage.needs) {
			if (!seen.has(dep)) {
				throw new ChainValidationError(`${filePath}: stage "${stage.id}" needs unknown stage "${dep}"`);
			}
			if (dep === stage.id) {
				throw new ChainValidationError(`${filePath}: stage "${stage.id}" cannot depend on itself`);
			}
		}
	}
	if (topologicalOrder(stages) === undefined) {
		throw new ChainValidationError(`${filePath}: stage dependencies contain a cycle`);
	}

	return {
		name,
		description: typeof root.description === "string" ? root.description : undefined,
		stages,
		source,
		filePath,
	};
}

function topologicalOrder(stages: ChainStage[]): ChainStage[] | undefined {
	const remaining = new Map(stages.map((stage) => [stage.id, stage]));
	const done = new Set<string>();
	const ordered: ChainStage[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((stage) => stage.needs.every((dep) => done.has(dep)));
		if (ready.length === 0) return undefined; // cycle
		for (const stage of ready) {
			ordered.push(stage);
			done.add(stage.id);
			remaining.delete(stage.id);
		}
	}
	return ordered;
}

export interface LoadChainsOptions {
	cwd: string;
	agentDir: string;
}

export interface LoadChainsResult {
	chains: Map<string, ChainDefinition>;
	/** Per-file parse errors (bad user files never break loading). */
	errors: string[];
}

function chainFilesIn(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
			.map((name) => join(dir, name))
			.sort();
	} catch {
		return [];
	}
}

export function loadChains(opts: LoadChainsOptions): LoadChainsResult {
	const chains = new Map<string, ChainDefinition>();
	const errors: string[] = [];
	const sources: Array<{ dir: string; source: ChainDefinition["source"] }> = [
		{ dir: join(opts.cwd, ".pi", "chains"), source: "project" },
		{ dir: join(opts.agentDir, "chains"), source: "user" },
	];
	for (const { dir, source } of sources) {
		for (const filePath of chainFilesIn(dir)) {
			try {
				const chain = parseChain(readFileSync(filePath, "utf8"), filePath, source);
				if (!chains.has(chain.name)) chains.set(chain.name, chain);
			} catch (err) {
				errors.push((err as Error).message);
			}
		}
	}
	return { chains, errors };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ChainStageResult {
	id: string;
	agent: string;
	status: "pending" | "running" | "verifying" | "completed" | "failed" | "skipped";
	registryId?: string;
	inline?: string;
	handle?: string;
	verifyAttempts: number;
	error?: string;
	durationMs: number;
}

export interface ChainRunResult {
	chain: string;
	status: "completed" | "failed";
	stages: ChainStageResult[];
}

export interface RunChainOptions {
	definition: ChainDefinition;
	input: string;
	parent: { session: AgentSession; depth: number; sessionFile?: string };
	parentType?: string;
	definitions: AgentDefinitionRegistry;
	deps: SpawnDeps;
	cwd: string;
	signal?: AbortSignal;
	/** Fired on every stage state change (streaming UI). */
	onUpdate?: (stages: ChainStageResult[]) => void;
}

function interpolate(template: string, input: string, results: Map<string, SpawnResult>): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)(?:\.(result|handle))?\s*\}\}/g, (match, ref, field) => {
		if (ref === "input") return input;
		const result = results.get(ref);
		if (!result) return match; // unresolved (validation prevents forward refs at runtime)
		if (field === "handle") return result.handle ?? "(no handle — result was inline)";
		const inline = result.inline;
		if (inline.length > INLINE_RESULT_CAP && result.handle) {
			return `(result too large to inline — pull it with agent_pull from ${result.handle})`;
		}
		return inline;
	});
}

export async function runChain(opts: RunChainOptions): Promise<ChainRunResult> {
	const { definition, input, deps } = opts;
	const ordered = topologicalOrder(definition.stages);
	if (!ordered) throw new ChainValidationError(`${definition.name}: cycle in stage dependencies`);

	const stageResults = new Map<string, ChainStageResult>(
		definition.stages.map((stage) => [
			stage.id,
			{ id: stage.id, agent: stage.agent, status: "pending" as const, verifyAttempts: 0, durationMs: 0 },
		]),
	);
	const spawnResults = new Map<string, SpawnResult>();
	const emit = () => opts.onUpdate?.(definition.stages.map((stage) => ({ ...stageResults.get(stage.id)! })));
	const registry = getBackgroundProcessRegistry();
	let failed = false;

	const runStage = async (stage: ChainStage): Promise<void> => {
		const state = stageResults.get(stage.id)!;
		const startedAt = Date.now();
		state.status = "running";
		emit();
		try {
			const prompt = interpolate(stage.prompt, input, spawnResults);
			const context = stage.context ? interpolate(stage.context, input, spawnResults) : undefined;
			const spawnDefinition = opts.definitions.get(stage.agent);
			if (!spawnDefinition) throw new Error(`unknown agent type "${stage.agent}"`);

			let result = await spawnAgent(
				{
					definition: spawnDefinition,
					prompt,
					context,
					parent: opts.parent,
					parentType: opts.parentType,
					modelOverride: stage.model,
					background: false,
					name: `${definition.name}.${stage.id}`,
					signal: opts.signal,
					onRegistered: (registryId) => {
						state.registryId = registryId;
						emit();
					},
				},
				deps,
			);
			if (result.status !== "completed") {
				throw new Error(result.inline);
			}

			// Verify ladder: shell gate; failures feed back to the SAME agent.
			if (stage.verify) {
				for (let attempt = 0; ; attempt++) {
					state.status = "verifying";
					state.verifyAttempts = attempt + 1;
					emit();
					const verdict = await execCommand("sh", ["-c", stage.verify], opts.cwd, {
						timeout: VERIFY_TIMEOUT_MS,
						signal: opts.signal,
					});
					if (verdict.code === 0) break;
					if (attempt >= stage.maxIters) {
						throw new Error(
							`verify "${stage.verify}" failed after ${attempt + 1} attempt(s):\n${(verdict.stderr || verdict.stdout).slice(-VERIFY_FEEDBACK_CAP)}`,
						);
					}
					if (!state.registryId) throw new Error("verify retry impossible: stage has no registry id");
					state.status = "running";
					emit();
					const feedback =
						`Your work failed verification (\`${stage.verify}\`, exit ${verdict.code}).\n` +
						`Output tail:\n${(verdict.stderr || verdict.stdout).slice(-VERIFY_FEEDBACK_CAP)}\n` +
						"Fix the problem, then stop.";
					const receipt = await deliverToAgent(state.registryId, feedback, {
						from: `chain:${definition.name}`,
						awaitReply: true,
					});
					if (receipt.status === "failed") {
						throw new Error(`verify retry delivery failed: ${receipt.reason}`);
					}
					if (receipt.status === "replied") {
						result = { ...result, inline: receipt.reply };
					}
				}
			}

			spawnResults.set(stage.id, result);
			state.status = "completed";
			state.inline = result.inline;
			state.handle = result.handle;
			if (state.registryId) registry.appendLog(state.registryId, `chain stage ${stage.id} completed`);
		} catch (err) {
			state.status = "failed";
			state.error = (err as Error).message;
			if (stage.onFail === "stop") failed = true;
		} finally {
			state.durationMs = Date.now() - startedAt;
			emit();
		}
	};

	// Wave scheduling: all stages whose deps are satisfied run in parallel.
	const done = new Set<string>();
	const pending = new Map(definition.stages.map((stage) => [stage.id, stage]));
	while (pending.size > 0 && !failed && !opts.signal?.aborted) {
		const wave = [...pending.values()].filter((stage) =>
			stage.needs.every((dep) => stageResults.get(dep)?.status === "completed"),
		);
		// Deps failed with on_fail: continue → dependents can never run; skip them.
		if (wave.length === 0) break;
		for (const stage of wave) pending.delete(stage.id);
		await Promise.all(wave.map(runStage));
		for (const stage of wave) {
			if (stageResults.get(stage.id)?.status === "completed") done.add(stage.id);
		}
	}
	for (const stage of pending.values()) {
		const state = stageResults.get(stage.id)!;
		if (state.status === "pending") {
			state.status = "skipped";
		}
	}
	emit();

	const stages = definition.stages.map((stage) => stageResults.get(stage.id)!);
	return {
		chain: definition.name,
		status: stages.every((stage) => stage.status === "completed") ? "completed" : "failed",
		stages,
	};
}
