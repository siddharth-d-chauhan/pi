import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "../model-registry.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface ResolveAgentModelOptions {
	spec?: string;
	agentType?: string;
	parent: Model<Api>;
	registry: ModelRegistry;
	settings: SettingsManager;
}

export interface ResolvedAgentModel {
	model: Model<Api>;
	inherited: boolean;
}

const MAX_ALIAS_DEPTH = 4;

export function resolveAgentModel(options: ResolveAgentModelOptions): ResolvedAgentModel {
	const override = options.agentType
		? getRecordValue(options.settings.getAgentModelOverrides(), options.agentType)
		: undefined;
	return resolveModelSpec(override ?? options.spec, options, new Set(), 0);
}

function resolveModelSpec(
	spec: string | undefined,
	options: ResolveAgentModelOptions,
	seenAliases: Set<string>,
	depth: number,
): ResolvedAgentModel {
	if (!spec || spec === "inherit") {
		return { model: options.parent, inherited: true };
	}

	if (spec.startsWith("pi/")) {
		return resolveRoleAlias(spec.slice("pi/".length), options, seenAliases, depth);
	}

	const explicit = findExplicitModel(spec, options.registry);
	if (!explicit) {
		throw new Error(`Agent model not found: ${spec}`);
	}
	return { model: explicit, inherited: isSameModel(explicit, options.parent) };
}

function resolveRoleAlias(
	role: string,
	options: ResolveAgentModelOptions,
	seenAliases: Set<string>,
	depth: number,
): ResolvedAgentModel {
	const normalizedRole = role.toLowerCase();
	if (depth >= MAX_ALIAS_DEPTH) {
		throw new Error(`Agent model role alias depth exceeded at pi/${normalizedRole}`);
	}
	if (seenAliases.has(normalizedRole)) {
		throw new Error(`Agent model role alias cycle detected at pi/${normalizedRole}`);
	}

	const roles = options.settings.getAgentRoles();
	const chain = getRecordValue(roles, normalizedRole) ?? [];
	if (chain.length === 0) {
		return { model: options.parent, inherited: true };
	}

	const nextSeen = new Set(seenAliases);
	nextSeen.add(normalizedRole);
	for (const candidate of chain) {
		const resolved = candidate.startsWith("pi/")
			? resolveModelSpec(candidate, options, nextSeen, depth + 1)
			: resolveCandidate(candidate, options);
		if (resolved) return resolved;
	}

	return { model: options.parent, inherited: true };
}

function resolveCandidate(candidate: string, options: ResolveAgentModelOptions): ResolvedAgentModel | undefined {
	const model = findExplicitModel(candidate, options.registry);
	if (!model || !options.registry.hasConfiguredAuth(model)) return undefined;
	return { model, inherited: isSameModel(model, options.parent) };
}

function findExplicitModel(spec: string, registry: ModelRegistry): Model<Api> | undefined {
	const slashIndex = spec.indexOf("/");
	if (slashIndex > 0) {
		const provider = spec.slice(0, slashIndex);
		const modelId = spec.slice(slashIndex + 1);
		return registry.find(provider, modelId);
	}
	return registry.getAll().find((model) => model.id === spec);
}

function isSameModel(a: Model<Api>, b: Model<Api>): boolean {
	return a.provider === b.provider && a.id === b.id;
}

function getRecordValue(record: Record<string, string[]>, key: string): string[] | undefined;
function getRecordValue(record: Record<string, string>, key: string): string | undefined;
function getRecordValue(record: Record<string, string | string[]>, key: string): string | string[] | undefined {
	const exact = record[key];
	if (exact !== undefined) return exact;
	const normalized = key.toLowerCase();
	const matchedKey = Object.keys(record).find((candidate) => candidate.toLowerCase() === normalized);
	return matchedKey ? record[matchedKey] : undefined;
}
