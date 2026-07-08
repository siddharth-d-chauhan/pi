/**
 * scan-cache.ts — a tiny process-shared file-list/scan cache with
 * INVALIDATE-ON-MUTATE keyed by DIR-PREFIX (rank 25, from oh-my-pi), NOT a TTL.
 *
 * TTL caches go stale silently and refresh needlessly; the right key is "did WE
 * change something under this dir". So: cache scan/search results by a key that
 * carries the dir(s) they cover; when an edit/write tool touches a path, drop
 * every cached entry whose covered dir is a prefix of (or under) the edited dir.
 * A miss after our own edit is thus guaranteed fresh, and reads between edits are
 * cheap. Extensions call `attachInvalidation(pi)` once to hook edit events.
 *
 * Also exposes `withRefreshRetry`: run a retrieval; if it comes back EMPTY and the
 * backing index is stale-ish (a recoverable INDEX_STALE-class condition), run ONE
 * refresh then retry before reporting "not found" — mapping onto the
 * agent_protocol INDEX_STALE recoverable-error contract.
 *
 * No config env; opt-in per caller.
 */

// entry: value + the set of dir prefixes it depends on (absolute, no trailing /).
type Entry = { value: string; dirs: string[]; ts: number };
const store = new Map<string, Entry>();

function norm(dir: string): string {
	const d = dir.replace(/\/+$/, "");
	return d || "/";
}

/** cache a scan/search result under `key`, declaring the dirs it covers. */
export function put(key: string, value: string, coveredDirs: string[]): void {
	store.set(key, { value, dirs: coveredDirs.map(norm), ts: Date.now() });
}

/** cached value for `key`, or null on miss. */
export function get(key: string): string | null {
	const e = store.get(key);
	return e ? e.value : null;
}

/**
 * Invalidate every entry whose covered dir is an ANCESTOR-OR-SELF of, or lives
 * UNDER, the edited dir — i.e. any scan that could have observed the changed file.
 * Dir-prefix keyed, so it's precise (only affected scans drop) and TTL-free.
 */
export function invalidateForPath(editedPath: string): number {
	const editedDir = norm(editedPath.replace(/\/[^/]*$/, "") || editedPath);
	let dropped = 0;
	for (const [key, e] of store) {
		const hit = e.dirs.some((d) => {
			// covered dir contains the edit (d is a prefix of editedDir) OR the edit's
			// dir contains the covered dir (editedDir is a prefix of d).
			const a = editedDir === d || editedDir.startsWith(`${d}/`);
			const b = d === editedDir || d.startsWith(`${editedDir}/`);
			return a || b;
		});
		if (hit) {
			store.delete(key);
			dropped++;
		}
	}
	return dropped;
}

/** clear everything (test / hard reset). */
export function clearAll(): void {
	store.clear();
}

const EDIT_TOOLS = /^(edit|write|hedit|multiedit|apply_patch|str_replace|create_file|rename_symbol)$/;

/** hook a pi instance's edit events so our own mutations drop stale scans. */
export function attachInvalidation(pi: any): void {
	try {
		pi.on?.("tool_result", (event: any) => {
			if (event?.isError) return;
			if (!EDIT_TOOLS.test(event?.toolName || "")) return;
			const p = String(event?.input?.path ?? event?.input?.file_path ?? "").trim();
			if (p) invalidateForPath(p.startsWith("/") ? p : `${process.cwd()}/${p}`);
		});
	} catch {}
}

/**
 * Run a retrieval; on a ZERO/empty result that looks index-stale, refresh ONCE and
 * retry before giving up. `isEmpty` decides emptiness; `looksStale` decides whether
 * a refresh is even warranted (default: always try one refresh on empty).
 */
export async function withRefreshRetry<T>(opts: {
	run: () => Promise<T> | T;
	isEmpty: (r: T) => boolean;
	refresh: () => Promise<void> | void;
	looksStale?: () => Promise<boolean> | boolean;
}): Promise<{ result: T; refreshed: boolean }> {
	const first = await opts.run();
	if (!opts.isEmpty(first)) return { result: first, refreshed: false };
	const stale = opts.looksStale ? await opts.looksStale() : true;
	if (!stale) return { result: first, refreshed: false };
	try {
		await opts.refresh();
	} catch {
		return { result: first, refreshed: false };
	}
	const second = await opts.run();
	return { result: second, refreshed: true };
}
