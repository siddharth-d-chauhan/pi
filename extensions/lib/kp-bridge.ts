/**
 * Shared plumbing for extensions that talk to the knowledge platform or
 * coordinate context injection. One implementation of:
 *   - callKp(): the shared MCP client seam (fail-open)
 *   - the delivered-facts registry (cross-channel dedup: boot, task packets,
 *     area packets, recall must not inject the same fact twice per session)
 *   - extractPaths(): path-looking tokens from tool args (area/intent triggers)
 */

export interface KpShared {
	connect: () => Promise<{
		callTool: (
			req: { name: string; arguments: Record<string, unknown> },
			schema?: undefined,
			opts?: { timeout?: number },
		) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
	}>;
	timeoutMs: number;
}

/** Call a KP MCP tool through the shared client; parsed-JSON result or
 *  undefined on any failure (extensions treat KP as an optimization). */
export async function callKp<T = Record<string, unknown>>(
	name: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<T | undefined> {
	const shared = (globalThis as Record<string, unknown>).__pi_kp__ as KpShared | undefined;
	if (!shared) return undefined;
	try {
		const client = await shared.connect();
		const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
		if (result.isError) return undefined;
		const raw = result.content?.find((c) => c.type === "text")?.text;
		if (!raw) return undefined;
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

/** Session-scoped registry of fact ids already injected into context by ANY
 *  channel. Lives on globalThis so every extension shares one set. */
function deliveredSet(): Set<string> {
	const g = globalThis as Record<string, unknown>;
	if (!(g.__pi_delivered_facts__ instanceof Set)) g.__pi_delivered_facts__ = new Set<string>();
	return g.__pi_delivered_facts__ as Set<string>;
}

export function markDelivered(factIds: Array<string | undefined>): void {
	const set = deliveredSet();
	for (const id of factIds) if (id) set.add(id);
}

export function isDelivered(factId: string | undefined): boolean {
	return factId ? deliveredSet().has(factId) : false;
}

export function resetDelivered(): void {
	deliveredSet().clear();
}

/** Opt-in slash-command seam: extensions whose commands make sense to run from
 *  a scheduler (/every) register their handler here, since pi has no
 *  programmatic command-execution API. */
export type SlashHandler = (
	args: string,
	ctx: { cwd: string; ui: { notify: (text: string, level: "info" | "warning" | "error") => void } },
) => Promise<void>;

function slashSeam(): Map<string, SlashHandler> {
	const g = globalThis as Record<string, unknown>;
	if (!(g.__pi_slash__ instanceof Map)) g.__pi_slash__ = new Map<string, SlashHandler>();
	return g.__pi_slash__ as Map<string, SlashHandler>;
}

export function registerSlashSeam(name: string, handler: SlashHandler): void {
	slashSeam().set(name, handler);
}

export function getSlashSeam(name: string): SlashHandler | undefined {
	return slashSeam().get(name);
}

/** Pull path-looking strings out of tool args (file_path, path, cmd text...). */
export function extractPaths(args: unknown): string[] {
	const out: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			for (const token of value.split(/[\s"'`]+/)) {
				if (token.length > 2 && token.length < 300 && (token.includes("/") || /\.\w{1,8}$/.test(token))) {
					out.push(token);
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value && typeof value === "object") {
			for (const item of Object.values(value)) walk(item);
		}
	};
	walk(args);
	return out;
}
