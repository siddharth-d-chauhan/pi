/**
 * Loop watchdog — detects event-loop blocks in the TUI's render path.
 *
 * Schedules a tick every `intervalMs`. A tick that fires later than
 * `intervalMs + thresholdMs` past its expected deadline means the loop was
 * blocked that long. The overshoot is logged once per block (rising-edge
 * de-dup), so a sustained freeze prints one line, not a flood.
 *
 * Used to surface stalls during long markdown/JSON renders, async tool
 * output flushes, or any Component that ends up doing heavy work on the
 * hot path.
 *
 * The handle is `unref`'d so the probe never keeps the process alive; on
 * stop() the armed timer is cancelled so a stopped watchdog leaves nothing
 * in the event loop. A `#generation` guard handles injected timers that
 * cannot cancel — start→stop→start cannot resurrect the prior chain.
 */

import { performance } from "node:perf_hooks";

export interface LoopWatchdogOptions {
	/** Probe tick interval in ms. Default 250. */
	intervalMs?: number;
	/** Tick later than this past its deadline counts as a block. Default 250. */
	thresholdMs?: number;
	/** Monotonic clock source; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Timer source; injectable for tests. Default `setTimeout`. */
	schedule?: (cb: () => void, ms: number) => LoopWatchdogTimer;
}

interface LoopWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

export class LoopWatchdog {
	#intervalMs: number;
	#thresholdMs: number;
	#now: () => number;
	#schedule: (cb: () => void, ms: number) => LoopWatchdogTimer;
	#expected = 0;
	#wasBlocked = false;
	#running = false;
	#generation = 0;
	#handle: LoopWatchdogTimer | undefined;

	constructor(options: LoopWatchdogOptions = {}) {
		this.#intervalMs = options.intervalMs ?? 250;
		this.#thresholdMs = options.thresholdMs ?? 250;
		this.#now = options.now ?? (() => performance.now());
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return {
					unref: () => timer.unref?.(),
					cancel: () => clearTimeout(timer),
				};
			});
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#wasBlocked = false;
		this.#armTick();
	}

	stop(): void {
		this.#running = false;
		this.#wasBlocked = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	#armTick(): void {
		const generation = this.#generation;
		this.#expected = this.#now() + this.#intervalMs;
		this.#handle = this.#schedule(() => this.#tick(generation), this.#intervalMs);
		this.#handle.unref?.();
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const blockedMs = this.#now() - this.#expected;
		if (blockedMs > this.#thresholdMs) {
			if (!this.#wasBlocked) {
				this.#wasBlocked = true;
				// Single line, single rising edge — never floods during sustained freezes.
				process.stderr.write(`[tui] event-loop blocked for ${Math.round(blockedMs)}ms\n`);
			}
		} else {
			this.#wasBlocked = false;
		}
		this.#armTick();
	}
}
