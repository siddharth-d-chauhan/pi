/**
 * Models Extension — lets pi query which models it can actually use, and
 * what each can do, before spawning a subagent with `model`/`effort`.
 *
 *   `models` tool (model-facing): list available models with capabilities
 *     (effort/thinking support + which levels, context window, cost, image
 *     input). Optionally include unavailable ones with the reason (no auth),
 *     so pi knows what it CAN'T use too.
 *   /models command (you): the same, printed to the notification area.
 *
 * Reads the live ModelRegistry from the extension context — no core edits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ModelLike = {
	id: string;
	name?: string;
	provider: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, unknown>;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number };
};

type RegistryLike = {
	getAll?: () => ModelLike[];
	getAvailable?: () => ModelLike[];
	hasConfiguredAuth?: (model: ModelLike) => boolean;
};

/** Which effort levels a model supports (thinkingLevelMap null = unsupported). */
function supportedEfforts(model: ModelLike): string[] {
	if (!model.reasoning) return [];
	const map = model.thinkingLevelMap;
	if (!map) return [...EFFORT_LEVELS]; // reasoning model, no explicit map = all levels
	return EFFORT_LEVELS.filter((level) => map[level] !== null);
}

function describe(model: ModelLike, available: boolean): Record<string, unknown> {
	const efforts = supportedEfforts(model);
	return {
		ref: `${model.provider}/${model.id}`,
		name: model.name ?? model.id,
		available,
		...(available ? {} : { reason: "no configured credentials for this provider" }),
		effort: efforts.length > 0 ? efforts : "none (no reasoning/thinking support)",
		context_window: model.contextWindow,
		max_output: model.maxTokens,
		image_input: (model.input ?? []).includes("image"),
		cost_per_mtok: model.cost ? { in: model.cost.input, out: model.cost.output } : undefined,
	};
}

const modelsSchema = Type.Object({
	q: Type.Optional(
		Type.String({ description: "case-insensitive filter over model ref/name (e.g. 'minimax', 'gpt')" }),
	),
	include_unavailable: Type.Optional(
		Type.Boolean({ description: "also list models with no credentials (so you know what you CAN'T use)" }),
	),
	reasoning_only: Type.Optional(Type.Boolean({ description: "only models that support effort/thinking levels" })),
});

type ModelsInput = Static<typeof modelsSchema>;

export default function (pi: ExtensionAPI) {
	function collect(input: ModelsInput, registry: RegistryLike): Record<string, unknown>[] {
		const available = new Set((registry.getAvailable?.() ?? []).map((m) => `${m.provider}/${m.id}`));
		const all = input.include_unavailable ? (registry.getAll?.() ?? []) : (registry.getAvailable?.() ?? []);
		const q = input.q?.trim().toLowerCase();
		return all
			.map((m) => describe(m, available.has(`${m.provider}/${m.id}`)))
			.filter((row) => {
				if (
					input.reasoning_only &&
					(row.effort === "none (no reasoning/thinking support)" || (row.effort as string[]).length === 0)
				)
					return false;
				if (q && !`${row.ref} ${row.name}`.toLowerCase().includes(q)) return false;
				return true;
			})
			.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
	}

	pi.registerTool({
		name: "models",
		label: "models",
		description:
			"List available models and their capabilities (effort levels, context window, image input, cost). " +
			"Use before choosing `model`/`effort` for a subagent.",
		promptSnippet: "Discover available models + capabilities before choosing model/effort for a subagent",
		parameters: modelsSchema,
		async execute(_id: string, input: ModelsInput, _signal, _onUpdate, ctx) {
			const registry = ctx?.modelRegistry as unknown as RegistryLike | undefined;
			if (!registry?.getAvailable) {
				return { content: [{ type: "text", text: "model registry unavailable" }], details: undefined };
			}
			const rows = collect(input, registry);
			return {
				content: [{ type: "text", text: JSON.stringify({ count: rows.length, models: rows }, null, 2) }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("models", {
		description: "List available models and capabilities: /models [filter]",
		handler: async (args, ctx) => {
			const registry = ctx.modelRegistry as unknown as RegistryLike;
			const rows = collect({ q: (args ?? "").trim() || undefined, include_unavailable: true }, registry);
			const lines = rows.map((r) => {
				const eff = Array.isArray(r.effort) ? r.effort.join("/") : "no-effort";
				const mark = r.available ? "●" : "○";
				const ctx = r.context_window ? `${Math.round(Number(r.context_window) / 1000)}k` : "?";
				return `${mark} ${r.ref}  [${eff}]  ctx ${ctx}${r.image_input ? " · img" : ""}`;
			});
			ctx.ui.notify(lines.join("\n") || "No models found.", "info");
		},
	});
}
