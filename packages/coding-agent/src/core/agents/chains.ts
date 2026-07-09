/**
 * Chains — declarative multi-agent orchestration.
 *
 * A chain is a YAML file describing stages that run subagents in a DAG:
 *
 *   name: feature-flow
 *   description: Plan → implement → review
 *   budget_usd: 0.50                 # optional cost ceiling for the run
 *   inputs:                          # optional named inputs
 *     topic: { description: "What to build" }
 *     area:  { default: "src" }
 *   stages:
 *     - id: plan
 *       agent: plan
 *       prompt: "Design an approach for: {{inputs.topic}} in {{inputs.area}}"
 *     - id: build
 *       agent: worker
 *       model: pi/slow               # optional per-stage model override
 *       prompt: "Implement this plan:\n{{plan.result}}"
 *       verify: "npm run check"      # shell gate; failure feeds back
 *       judge: "Does the diff actually implement the plan (not gamed)?"
 *       max_iters: 2                 # gate retries (default 2)
 *       on_fail: stop                # stop (default) | continue
 *     - id: fix-each
 *       agent: worker
 *       foreach: "{{plan.result}}"   # JSON array or one item per line
 *       max_items: 10
 *       prompt: "Handle this item: {{item}}"
 *     - id: review
 *       agent: reviewer
 *       needs: [build]               # deps; default = the previous stage
 *       prompt: "Review the diff. The plan was {{plan.handle}}."
 *
 * Interpolation: `{{input}}` (the raw input string), `{{inputs.name}}`
 * (named inputs — the run input may be a JSON object), `{{stage.result}}`
 * (inlined when small, substituted with the agent:// handle + note when
 * large), `{{stage.handle}}`, and `{{item}}` inside foreach stages.
 * Stages whose `needs` are all satisfied run in parallel.
 *
 * Gates run in a shared retry loop (verify first, then judge). Failures
 * do NOT respawn: the stage's agent is still idle (lifecycle keep-alive),
 * so the failure output/verdict is delivered to the SAME agent as a
 * message and the gates re-run — up to `max_iters` times. The judge is a
 * fresh read-only agent (fresh eyes — Claude Code's coordinator rule)
 * that must answer `VERDICT: PASS|FAIL`.
 *
 * Completed stages are reported through `onStageSettled`, which the chain
 * tool persists — a failed run can be resumed with the completed stages'
 * results seeded (`seedStages`).
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
import type { AgentDefinition, AgentDefinitionRegistry, AgentSpawnPolicy } from "./definitions.ts";
import { deliverToAgent } from "./lifecycle.ts";
import { type SpawnDeps, type SpawnResult, spawnAgent } from "./spawn.ts";

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ChainInputSpec {
	description?: string;
	default?: string;
}

export interface ChainStage {
	id: string;
	agent: string;
	prompt: string;
	model?: string;
	context?: string;
	needs: string[];
	verify?: string;
	judge?: string;
	foreach?: string;
	/** Run foreach items one at a time (safe for workspace-mutating agents). */
	serial: boolean;
	/** Per-stage isolation override (wins over the agent definition). */
	isolation?: "worktree" | "none";
	maxItems: number;
	maxIters: number;
	onFail: "stop" | "continue";
}

export interface ChainDefinition {
	name: string;
	description?: string;
	budgetUsd?: number;
	inputs: Record<string, ChainInputSpec>;
	stages: ChainStage[];
	source: "project" | "user";
	filePath: string;
}

/** Inline interpolation cap — larger stage results substitute their handle. */
const INLINE_RESULT_CAP = 2_000;
/** Verify command timeout. */
const VERIFY_TIMEOUT_MS = 300_000;
/** Tail of verify output / judge verdict fed back to the agent on failure. */
const GATE_FEEDBACK_CAP = 4_000;
/** Per-item inline cap when combining foreach results. */
const FOREACH_ITEM_CAP = 1_000;
/** Default foreach item ceiling. */
const DEFAULT_MAX_ITEMS = 10;

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

	const budgetRaw = root.budget_usd ?? root.budgetUsd;
	if (budgetRaw !== undefined && (typeof budgetRaw !== "number" || budgetRaw <= 0)) {
		throw new ChainValidationError(`${filePath}: budget_usd must be a positive number`);
	}

	const inputs: Record<string, ChainInputSpec> = {};
	const inputsRaw = asRecord(root.inputs);
	if (root.inputs !== undefined && !inputsRaw) {
		throw new ChainValidationError(`${filePath}: "inputs" must be a mapping of name → spec`);
	}
	for (const [key, specRaw] of Object.entries(inputsRaw ?? {})) {
		const spec = asRecord(specRaw) ?? {};
		inputs[key] = {
			description: typeof spec.description === "string" ? spec.description : undefined,
			default: typeof spec.default === "string" ? spec.default : undefined,
		};
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
		const maxItemsRaw = raw.max_items ?? raw.maxItems;
		const maxItems =
			maxItemsRaw === undefined
				? DEFAULT_MAX_ITEMS
				: typeof maxItemsRaw === "number" && maxItemsRaw > 0
					? Math.floor(maxItemsRaw)
					: -1;
		if (maxItems === -1) {
			throw new ChainValidationError(`${filePath}: stage "${id}" max_items must be a positive number`);
		}
		const foreach = typeof raw.foreach === "string" && raw.foreach.trim() ? raw.foreach : undefined;
		const serial = raw.serial === true;
		const isolationRaw = raw.isolation;
		if (isolationRaw !== undefined && isolationRaw !== "worktree" && isolationRaw !== "none") {
			throw new ChainValidationError(`${filePath}: stage "${id}" isolation must be "worktree" or "none"`);
		}
		const verify = typeof raw.verify === "string" && raw.verify.trim() ? raw.verify : undefined;
		const judge = typeof raw.judge === "string" && raw.judge.trim() ? raw.judge : undefined;
		if (foreach && (verify || judge)) {
			throw new ChainValidationError(
				`${filePath}: stage "${id}" cannot combine foreach with verify/judge gates (gate the next stage instead)`,
			);
		}
		stages.push({
			id,
			agent,
			prompt,
			model: typeof raw.model === "string" ? raw.model : undefined,
			context: typeof raw.context === "string" ? raw.context : undefined,
			needs,
			verify,
			judge,
			foreach,
			serial,
			isolation: isolationRaw as "worktree" | "none" | undefined,
			maxItems,
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
		budgetUsd: budgetRaw as number | undefined,
		inputs,
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
// Inputs
// ---------------------------------------------------------------------------

/**
 * Resolve the run input. The raw input may be a JSON object (named inputs)
 * or a plain string. Defaults are applied; missing required inputs throw
 * with a helpful list.
 */
export function resolveChainInputs(
	definition: ChainDefinition,
	rawInput: string,
): { input: string; inputs: Record<string, string> } {
	let named: Record<string, string> = {};
	const trimmed = rawInput.trim();
	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as Record<string, unknown>;
			for (const [key, value] of Object.entries(parsed)) {
				named[key] = typeof value === "string" ? value : JSON.stringify(value);
			}
		} catch {
			named = {};
		}
	}
	const specs = definition.inputs;
	const specKeys = Object.keys(specs);
	// A plain string fills the single declared input, when there is exactly one.
	if (Object.keys(named).length === 0 && specKeys.length === 1 && trimmed) {
		named[specKeys[0]] = rawInput;
	}
	for (const [key, spec] of Object.entries(specs)) {
		if (named[key] === undefined && spec.default !== undefined) {
			named[key] = spec.default;
		}
	}
	const missing = specKeys.filter((key) => named[key] === undefined);
	if (missing.length > 0) {
		const describe = missing
			.map((key) => `${key}${specs[key].description ? ` (${specs[key].description})` : ""}`)
			.join(", ");
		throw new ChainValidationError(
			`Chain "${definition.name}" is missing required input(s): ${describe}. ` +
				`Pass them as a JSON object, e.g. {"${missing[0]}": "…"}.`,
		);
	}
	return { input: rawInput, inputs: named };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ChainStageResult {
	id: string;
	agent: string;
	status: "pending" | "running" | "verifying" | "judging" | "completed" | "failed" | "skipped";
	registryId?: string;
	inline?: string;
	handle?: string;
	verifyAttempts: number;
	itemsDone?: number;
	itemsTotal?: number;
	tokens: number;
	costUsd: number;
	error?: string;
	durationMs: number;
}

export interface ChainRunTotals {
	tokens: number;
	costUsd: number;
	durationMs: number;
}

export interface ChainRunResult {
	chain: string;
	status: "completed" | "failed";
	stages: ChainStageResult[];
	totals: ChainRunTotals;
}

/** Seed for resuming: completed stages from a prior run. */
export type ChainSeedStages = Record<string, { inline: string; handle?: string }>;

export interface RunChainOptions {
	definition: ChainDefinition;
	input: string;
	parent: { session: AgentSession; depth: number; sessionFile?: string };
	parentType?: string;
	/** The parent's spawn policy — forwarded so chains work from subagents too. */
	spawns?: AgentSpawnPolicy;
	definitions: AgentDefinitionRegistry;
	deps: SpawnDeps;
	cwd: string;
	signal?: AbortSignal;
	/** Completed stages from a prior failed run (their spawns are skipped). */
	seedStages?: ChainSeedStages;
	/** Cost ceiling override (falls back to the definition's budget_usd). */
	budgetUsd?: number;
	/** Fired on every stage state change (streaming UI). */
	onUpdate?: (stages: ChainStageResult[]) => void;
	/** Fired when a stage completes — the tool persists this for resume. */
	onStageSettled?: (stage: ChainStageResult) => void;
}

interface InterpolationContext {
	input: string;
	inputs: Record<string, string>;
	results: Map<string, SpawnResult>;
	item?: string;
}

function interpolate(template: string, ctx: InterpolationContext): string {
	return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?\s*\}\}/g, (match, ref, field) => {
		if (ref === "input" && field === undefined) return ctx.input;
		if (ref === "item" && field === undefined) return ctx.item ?? match;
		if (ref === "inputs" && field) return ctx.inputs[field] ?? match;
		const result = ctx.results.get(ref);
		if (!result) return match;
		if (field === "handle") return result.handle ?? "(no handle — result was inline)";
		const inline = result.inline;
		if (inline.length > INLINE_RESULT_CAP && result.handle) {
			return `(result too large to inline — pull it with agent_pull from ${result.handle})`;
		}
		return inline;
	});
}

/** Split a foreach expression into items: JSON array, else non-empty lines. */
export function splitForeachItems(value: string, maxItems: number): string[] {
	const trimmed = value.trim();
	let items: string[] = [];
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown[];
			items = parsed.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
		} catch {
			items = [];
		}
	}
	if (items.length === 0) {
		items = trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}
	return items.slice(0, maxItems);
}

/** Fresh-eyes judge: a read-only one-shot definition, independent of the roster. */
function judgeDefinition(): AgentDefinition {
	return {
		name: "chain-judge",
		description: "Adversarial gate judge",
		systemPrompt:
			"You are an adversarial verification judge. Inspect the workspace to answer the question. " +
			"Be skeptical of gamed or superficial work. Your FINAL message MUST start with exactly " +
			"`VERDICT: PASS` or `VERDICT: FAIL`, followed by a one-paragraph reason.",
		tools: ["read", "grep", "find", "ls", "bash"],
		spawns: "none",
		thinkingLevel: "low",
		maxTurns: 10,
		background: false,
		isolation: "none",
		omitProjectContext: true,
		source: "bundled",
		permissionMode: "read-only",
	} as AgentDefinition;
}

const VERDICT_PATTERN = /VERDICT:\s*(PASS|FAIL)/i;

export async function runChain(opts: RunChainOptions): Promise<ChainRunResult> {
	const { definition, deps } = opts;
	const ordered = topologicalOrder(definition.stages);
	if (!ordered) throw new ChainValidationError(`${definition.name}: cycle in stage dependencies`);
	const { input, inputs } = resolveChainInputs(definition, opts.input);
	const budgetUsd = opts.budgetUsd ?? definition.budgetUsd;
	const startedAt = Date.now();

	const stageResults = new Map<string, ChainStageResult>(
		definition.stages.map((stage) => [
			stage.id,
			{
				id: stage.id,
				agent: stage.agent,
				status: "pending" as const,
				verifyAttempts: 0,
				tokens: 0,
				costUsd: 0,
				durationMs: 0,
			},
		]),
	);
	const spawnResults = new Map<string, SpawnResult>();
	let totalTokens = 0;
	let totalCostUsd = 0;
	const emit = () => opts.onUpdate?.(definition.stages.map((stage) => ({ ...stageResults.get(stage.id)! })));
	const registry = getBackgroundProcessRegistry();
	let failed = false;

	// Seed completed stages from a prior run (resume).
	for (const [id, seed] of Object.entries(opts.seedStages ?? {})) {
		const state = stageResults.get(id);
		if (!state) continue;
		state.status = "completed";
		state.inline = seed.inline;
		state.handle = seed.handle;
		spawnResults.set(id, {
			status: "completed",
			inline: seed.inline,
			handle: seed.handle,
			usage: { tokens: 0, costUsd: 0, requests: 0, durationMs: 0 },
			registryId: "",
		});
	}

	const trackUsage = (state: ChainStageResult, result: SpawnResult): void => {
		state.tokens += result.usage.tokens;
		state.costUsd += result.usage.costUsd;
		totalTokens += result.usage.tokens;
		totalCostUsd += result.usage.costUsd;
	};

	const overBudget = (): string | undefined =>
		budgetUsd !== undefined && totalCostUsd >= budgetUsd
			? `chain budget exhausted ($${totalCostUsd.toFixed(4)} of $${budgetUsd.toFixed(4)})`
			: undefined;

	const spawnStageAgent = async (
		stage: ChainStage,
		state: ChainStageResult,
		prompt: string,
		context: string | undefined,
		nameSuffix = "",
	): Promise<SpawnResult> => {
		const spawnDefinition = opts.definitions.get(stage.agent);
		if (!spawnDefinition) throw new Error(`unknown agent type "${stage.agent}"`);
		if (spawnDefinition.isolation === "worktree" && (stage.verify || stage.judge)) {
			throw new Error(
				`stage "${stage.id}": agent "${stage.agent}" uses worktree isolation, which cannot combine with ` +
					"verify/judge gates (the work lives in the worktree, not the checkout the gate inspects; " +
					"gate a follow-up stage after merging instead)",
			);
		}
		const result = await spawnAgent(
			{
				definition: spawnDefinition,
				prompt,
				context,
				parent: opts.parent,
				parentType: opts.parentType,
				spawns: opts.spawns,
				modelOverride: stage.model,
				background: false,
				name: `${definition.name}.${stage.id}${nameSuffix}`,
				group: definition.name,
				ephemeral: nameSuffix !== "",
				isolationOverride: stage.isolation,
				signal: opts.signal,
				onRegistered: (registryId) => {
					if (!nameSuffix) state.registryId = registryId;
					emit();
				},
			},
			deps,
		);
		trackUsage(state, result);
		if (result.status !== "completed") throw new Error(result.inline);
		return result;
	};

	const runGates = async (stage: ChainStage, state: ChainStageResult, result: SpawnResult): Promise<SpawnResult> => {
		let current = result;
		for (let attempt = 0; ; attempt++) {
			state.verifyAttempts = attempt + 1;
			let failure: string | undefined;

			if (stage.verify) {
				state.status = "verifying";
				emit();
				const verifyCommand = interpolate(stage.verify, { input, inputs, results: spawnResults });
				const verdict = await execCommand("sh", ["-c", verifyCommand], opts.cwd, {
					timeout: VERIFY_TIMEOUT_MS,
					signal: opts.signal,
				});
				if (verdict.code !== 0) {
					failure =
						`Your work failed verification (\`${verifyCommand}\`, exit ${verdict.code}).\n` +
						`Output tail:\n${(verdict.stderr || verdict.stdout).slice(-GATE_FEEDBACK_CAP)}`;
				}
			}

			if (!failure && stage.judge) {
				state.status = "judging";
				emit();
				const judgePrompt =
					`Question: ${stage.judge}\n\n` +
					`The work under judgment (stage "${stage.id}" of chain "${definition.name}"):\n` +
					`${current.inline.slice(0, GATE_FEEDBACK_CAP)}\n\n` +
					"Inspect the workspace as needed, then give your verdict.";
				const judgeResult = await spawnAgent(
					{
						definition: judgeDefinition(),
						prompt: judgePrompt,
						parent: opts.parent,
						parentType: opts.parentType,
						spawns: opts.spawns,
						background: false,
						name: `${definition.name}.${stage.id}.judge`,
						group: definition.name,
						ephemeral: true,
						signal: opts.signal,
					},
					deps,
				);
				trackUsage(state, judgeResult);
				const match = judgeResult.inline.match(VERDICT_PATTERN);
				// Unparseable verdicts fail open (logged) — a confused judge must
				// not livelock the chain.
				if (match && match[1].toUpperCase() === "FAIL") {
					failure = `An independent judge rejected the work.\nJudge question: ${stage.judge}\nJudge verdict:\n${judgeResult.inline.slice(0, GATE_FEEDBACK_CAP)}`;
				} else if (!match && state.registryId) {
					registry.appendLog(state.registryId, "[judge verdict unparseable — treated as PASS]");
				}
			}

			if (!failure) return current;
			if (attempt >= stage.maxIters) {
				throw new Error(`gates failed after ${attempt + 1} attempt(s): ${failure.split("\n")[0]}`);
			}
			if (!state.registryId) throw new Error("gate retry impossible: stage has no registry id");
			state.status = "running";
			emit();
			const budgetError = overBudget();
			if (budgetError) throw new Error(budgetError);
			const receipt = await deliverToAgent(state.registryId, `${failure}\nFix the problem, then stop.`, {
				from: `chain:${definition.name}`,
				awaitReply: true,
			});
			if (receipt.status === "failed") throw new Error(`gate retry delivery failed: ${receipt.reason}`);
			if (receipt.status === "replied") {
				current = { ...current, inline: receipt.reply };
				if (receipt.usage) {
					state.tokens += receipt.usage.tokens;
					state.costUsd += receipt.usage.costUsd;
					totalTokens += receipt.usage.tokens;
					totalCostUsd += receipt.usage.costUsd;
				}
			}
		}
	};

	const runStage = async (stage: ChainStage): Promise<void> => {
		const state = stageResults.get(stage.id)!;
		if (state.status === "completed") return; // seeded by resume
		const stageStartedAt = Date.now();
		state.status = "running";
		emit();
		try {
			const budgetError = overBudget();
			if (budgetError) throw new Error(budgetError);

			const baseCtx: InterpolationContext = { input, inputs, results: spawnResults };
			const context = stage.context ? interpolate(stage.context, baseCtx) : undefined;

			let result: SpawnResult;
			if (stage.foreach) {
				const items = splitForeachItems(interpolate(stage.foreach, baseCtx), stage.maxItems);
				if (items.length === 0) throw new Error("foreach produced no items");
				state.itemsTotal = items.length;
				state.itemsDone = 0;
				emit();
				const runItem = async (item: string, index: number): Promise<SpawnResult> => {
					const budgetErr = overBudget();
					if (budgetErr) throw new Error(budgetErr);
					const prompt = interpolate(stage.prompt, { ...baseCtx, item });
					const itemResult = await spawnStageAgent(stage, state, prompt, context, `[${index + 1}]`);
					state.itemsDone = (state.itemsDone ?? 0) + 1;
					emit();
					return itemResult;
				};
				let itemResults: SpawnResult[];
				if (stage.serial) {
					itemResults = [];
					for (let index = 0; index < items.length; index++) {
						itemResults.push(await runItem(items[index], index));
					}
				} else {
					itemResults = await Promise.all(items.map(runItem));
				}
				const combined = itemResults
					.map((itemResult, index) => {
						const body = itemResult.inline.replace(/\n*_agentId: [^\n]*_\s*$/, "");
						return `### item ${index + 1}\n${body.slice(0, FOREACH_ITEM_CAP)}`;
					})
					.join("\n\n");
				result = {
					status: "completed",
					inline: combined,
					usage: { tokens: 0, costUsd: 0, requests: 0, durationMs: Date.now() - stageStartedAt },
					registryId: state.registryId ?? "",
				};
			} else {
				const prompt = interpolate(stage.prompt, baseCtx);
				result = await spawnStageAgent(stage, state, prompt, context);
				result = await runGates(stage, state, result);
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
			state.durationMs = Date.now() - stageStartedAt;
			emit();
			opts.onStageSettled?.({ ...state });
		}
	};

	// Wave scheduling: all stages whose deps are satisfied run in parallel.
	const pending = new Map(definition.stages.map((stage) => [stage.id, stage]));
	for (const id of Object.keys(opts.seedStages ?? {})) pending.delete(id);
	while (pending.size > 0 && !failed && !opts.signal?.aborted) {
		const wave = [...pending.values()].filter((stage) =>
			stage.needs.every((dep) => stageResults.get(dep)?.status === "completed"),
		);
		if (wave.length === 0) break;
		for (const stage of wave) pending.delete(stage.id);
		await Promise.all(wave.map(runStage));
	}
	for (const stage of pending.values()) {
		const state = stageResults.get(stage.id)!;
		if (state.status === "pending") state.status = "skipped";
	}
	emit();

	const stages = definition.stages.map((stage) => stageResults.get(stage.id)!);
	return {
		chain: definition.name,
		status: stages.every((stage) => stage.status === "completed") ? "completed" : "failed",
		stages,
		totals: { tokens: totalTokens, costUsd: totalCostUsd, durationMs: Date.now() - startedAt },
	};
}
