/**
 * Card style state shared across extension module graphs (globalThis
 * channel, same pattern as lib/icons.ts): "border" draws omp-style rounded
 * line boxes (the default); "solid" paints full-width background blocks.
 * Persisted in <agentDir>/cards.json; /cards toggles it live.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type CardStyle = "solid" | "border";

interface StyleState {
	style?: CardStyle;
	listeners: Set<() => void>;
}

const GLOBAL_KEY = "__pi_card_style__";
const globalStore = globalThis as Record<string, unknown>;
if (!globalStore[GLOBAL_KEY]) {
	globalStore[GLOBAL_KEY] = { style: undefined, listeners: new Set() } satisfies StyleState;
}
const state = globalStore[GLOBAL_KEY] as StyleState;

function stateFile(): string {
	return join(getAgentDir(), "cards.json");
}

export function getCardStyle(): CardStyle {
	if (state.style) return state.style;
	try {
		const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { style?: string };
		state.style = saved.style === "solid" ? "solid" : "border";
	} catch {
		state.style = "border";
	}
	return state.style;
}

export function setCardStyle(next: CardStyle): void {
	state.style = next;
	try {
		writeFileSync(stateFile(), `${JSON.stringify({ style: next })}\n`);
	} catch {
		// persistence is best-effort
	}
	for (const listener of state.listeners) listener();
}

export function onCardStyleChange(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}
