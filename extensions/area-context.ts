/**
 * Area Context — follow the work INSIDE a repo, not just across repos.
 *
 * Repos have areas (licensing, broker, billing, ...). Working on licensing
 * should inject licensing context only; when the work drifts into another
 * area MID-TURN (a tool touches broker files), that area's packet is fetched
 * from the knowledge platform (pi.context_area) and steered into the running
 * turn — append-only, once per area per epoch, KV-cache friendly.
 *
 * Area resolution is deterministic and repo-owned: `.pi/context-areas.json`
 * in the repo root maps area names to path prefixes/substrings:
 *
 *   { "areas": {
 *       "licensing": ["src/licensing/", "lic/"],
 *       "broker":    ["extensions/context-broker.ts", "extensions/knowledge.ts"]
 *   } }
 *
 * No map file -> the extension is inert for that repo. `/areas` shows the map
 * and what has been injected this session.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { copper, heatLine } from "./lib/card.ts";
import { callKp, extractPaths, isDelivered, markDelivered } from "./lib/kp-bridge.ts";

const AREA_TIMEOUT_MS = Number(process.env.PI_KP_AREA_TIMEOUT_MS ?? 4_000);
const AREA_MAX_ITEMS = Number(process.env.PI_KP_AREA_MAX_ITEMS ?? 8);
const BLOCK_MAX_CHARS = 1_200;

interface AreaPacket {
	candidates?: Array<{ memory?: { fact_id?: string; kind?: string; text?: string; inject_role?: string } }>;
	freshness?: { area?: string };
}

interface AreaMap {
	areas: Record<string, string[]>;
}

function loadAreaMap(cwd: string): AreaMap | undefined {
	const path = join(cwd, ".pi", "context-areas.json");
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed && typeof parsed.areas === "object" && parsed.areas !== null) {
			return { areas: parsed.areas as Record<string, string[]> };
		}
	} catch {
		// malformed map -> inert (surfaced via /areas)
	}
	return undefined;
}

/** Which areas do these paths belong to, per the repo's map? */
function resolveAreas(map: AreaMap, paths: string[]): Set<string> {
	const hit = new Set<string>();
	for (const [area, prefixes] of Object.entries(map.areas)) {
		for (const prefix of prefixes) {
			if (paths.some((p) => p.includes(prefix))) {
				hit.add(area);
				break;
			}
		}
	}
	return hit;
}

function renderAreaBlock(area: string, packet: AreaPacket): string {
	const lines: string[] = [`<area-context area="${area}">`];
	for (const c of packet.candidates ?? []) {
		if (!c.memory?.text) continue;
		const role = c.memory.inject_role === "must_follow" ? "!" : "·";
		lines.push(`${role} [${c.memory.kind ?? "fact"}] ${c.memory.text}`);
	}
	lines.push("</area-context>");
	let text = lines.join("\n");
	if (text.length > BLOCK_MAX_CHARS) text = `${text.slice(0, BLOCK_MAX_CHARS - 20)}\n</area-context>`;
	return text;
}

export default function (pi: ExtensionAPI) {
	const state = {
		map: undefined as AreaMap | undefined,
		mapLoadedFor: "",
		/** areas already injected, keyed `${epoch}:${area}` */
		injected: new Set<string>(),
		inFlight: new Set<string>(),
	};

	const currentEpoch = (): number => {
		const wf = (globalThis as Record<string, unknown>).__pi_workframe__ as { epoch?: number } | undefined;
		return wf?.epoch ?? 0;
	};

	const ensureMap = (cwd: string): AreaMap | undefined => {
		if (state.mapLoadedFor !== cwd) {
			state.map = loadAreaMap(cwd);
			state.mapLoadedFor = cwd;
		}
		return state.map;
	};

	async function injectArea(area: string, cwd: string): Promise<void> {
		const key = `${currentEpoch()}:${area}`;
		if (state.injected.has(key) || state.inFlight.has(key)) return;
		state.inFlight.add(key);
		try {
			const packet = await callKp<AreaPacket>(
				"pi.context_area",
				{ repository: basename(cwd), area, max_memory_items: AREA_MAX_ITEMS },
				AREA_TIMEOUT_MS,
			);
			if (!packet) return;
			// Cross-channel dedup: drop facts the boot/task channels already
			// delivered this session, and register what WE deliver.
			packet.candidates = (packet.candidates ?? []).filter((c) => c.memory?.text && !isDelivered(c.memory.fact_id));
			const items = packet.candidates.length;
			if (items === 0) {
				// Nothing filed under this area — remember that so we don't
				// re-query on every subsequent touch.
				state.injected.add(key);
				return;
			}
			state.injected.add(key);
			markDelivered(packet.candidates.map((c) => c.memory?.fact_id));
			pi.sendMessage(
				{
					customType: "area-context",
					content: renderAreaBlock(area, packet),
					display: true,
					details: { area, items },
				},
				// Steer: the work ALREADY drifted here — the running turn should
				// see this area's facts now, not next turn.
				{ deliverAs: "steer" },
			);
		} catch {
			// fail-open: area context is an optimization, never a blocker
		} finally {
			state.inFlight.delete(key);
		}
	}

	pi.on("tool_execution_start", async (event) => {
		const cwd = process.cwd();
		const map = ensureMap(cwd);
		if (!map) return;
		const areas = resolveAreas(map, extractPaths(event.args));
		for (const area of areas) {
			void injectArea(area, cwd);
		}
	});

	// New session / direction change: epoch key changes naturally; nothing to
	// clear eagerly, but a fresh session must not inherit the old set.
	pi.on("session_start", async () => {
		state.injected.clear();
		state.inFlight.clear();
	});

	pi.registerMessageRenderer<{ area?: string; items?: number }>("area-context", (message, options, theme) => {
		const d = message.details;
		const head =
			`${copper("▎")} ⌘ ${theme.fg("text", `area context: ${d?.area ?? "?"}`)} ` +
			`${theme.fg("muted", `· ${d?.items ?? 0} item(s)`)}${options.expanded ? "" : ` ${theme.fg("dim", "· ctrl+o to inspect")}`}`;
		const body = typeof message.content === "string" ? message.content : "";
		return new Text(
			options.expanded ? `${head}\n${heatLine(46)}\n${theme.fg("dim", body)}` : `${head}\n${heatLine(46)}`,
			0,
			0,
		);
	});

	pi.registerCommand("areas", {
		description: "Show the repo's context-area map and which areas were injected this session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const map = ensureMap(ctx.cwd);
			if (!map) {
				ctx.ui.notify(
					"No .pi/context-areas.json in this repo — create one to enable area-scoped context:\n" +
						'{ "areas": { "licensing": ["src/licensing/"], "broker": ["src/broker/"] } }',
					"info",
				);
				return;
			}
			const injected = [...state.injected].map((k) => k.split(":").slice(1).join(":"));
			const lines = Object.entries(map.areas).map(
				([area, prefixes]) => `${injected.includes(area) ? "● " : "  "}${area} — ${prefixes.join(", ")}`,
			);
			ctx.ui.notify(`context areas (● = injected this session):\n${lines.join("\n")}`, "info");
		},
	});
}
