/**
 * Desktop notification delivery for the TUI.
 *
 * Sends a desktop/terminal notification through the best protocol the host
 * supports. Detection is performed once at startup and cached; subsequent
 * {@link notify} calls are fire-and-forget.
 *
 * Order of preference:
 *   1. OSC 99 (Kitty) — when `KITTY_WINDOW_ID` is set.
 *   2. OSC 777 (Ghostty, iTerm2, WezTerm, rxvt-unicode, vscode) — when
 *      `TERM_PROGRAM` / `COLORTERM` indicates a known consumer.
 *   3. `notify-send` over D-Bus (Linux fallback) — when on Linux, a session
 *      bus is reachable, and the binary resolves on `PATH`.
 *   4. No-op.
 *
 * Either `PI_NO_DESKTOP_NOTIFY=1` or `PI_NO_NOTIFY=1` disables all sends.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Terminal } from "./terminal.ts";

/** Resolved delivery protocol. `"none"` means notifications are disabled. */
export type NotifyProtocol = "osc-777" | "osc-99" | "dbus" | "none";

/** Bell terminator used by OSC 777. */
const BEL = "\x07";
/** String terminator used for the multi-part Kitty OSC 99 sequence. */
const ST = "\x1b\\";

/** Result of resolving which protocol to use. Cached after first call. */
let cachedProtocol: NotifyProtocol | undefined;

/** Get the detected notification protocol, computing it on the first call. */
export function getNotifyProtocol(): NotifyProtocol {
	if (cachedProtocol !== undefined) return cachedProtocol;
	cachedProtocol = detectProtocol();
	return cachedProtocol;
}

/** Reset the cached protocol decision. Tests only. */
export function resetNotifyProtocolCache(): void {
	cachedProtocol = undefined;
}

/**
 * Fire-and-forget desktop notification. No-op when the detected protocol is
 * `"none"` (unsupported host, opt-out env var, or missing tools).
 *
 * @param title  Notification title shown by the host.
 * @param body   Notification body / message.
 * @param opts   Optional routing. `terminal` routes OSC writes through the
 *               TUI's `Terminal.write` so they don't interleave into a frame;
 *               otherwise OSC writes go straight to `process.stdout` and the
 *               `dbus` path is unaffected.
 */
export function notify(title: string, body: string, opts: { terminal?: Terminal } = {}): void {
	const protocol = getNotifyProtocol();
	switch (protocol) {
		case "osc-99":
			if (opts.terminal) opts.terminal.write(`\x1b]99;i=1:d=0;${title}${ST}\x1b]99;i=1:p=body;${body}${ST}`);
			else process.stdout.write(`\x1b]99;i=1:d=0;${title}${ST}\x1b]99;i=1:p=body;${body}${ST}`);
			return;
		case "osc-777":
			if (opts.terminal) opts.terminal.write(`\x1b]777;notify;${title};${body}${BEL}`);
			else process.stdout.write(`\x1b]777;notify;${title};${body}${BEL}`);
			return;
		case "dbus":
			spawnNotifySend(title, body);
			return;
		default:
			return;
	}
}

// ----------------------------------------------------------------------------
// Detection
// ----------------------------------------------------------------------------

function detectProtocol(): NotifyProtocol {
	const env = process.env;
	if (env.PI_NO_DESKTOP_NOTIFY === "1" || env.PI_NO_NOTIFY === "1") {
		return "none";
	}
	if (env.KITTY_WINDOW_ID) {
		return "osc-99";
	}
	if (detectsOSC777Terminal(env)) {
		return "osc-777";
	}
	if (process.platform === "linux" && env.DBUS_SESSION_BUS_ADDRESS && resolveOnPath("notify-send")) {
		return "dbus";
	}
	return "none";
}

/**
 * Terminals that recognise OSC 777 notifications. `TERM_PROGRAM` is the
 * primary signal; `COLORTERM` / `TERM` cover rxvt-unicode and other truecolor
 * clients that don't set `TERM_PROGRAM`.
 */
function detectsOSC777Terminal(env: NodeJS.ProcessEnv): boolean {
	const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? "";
	if (
		termProgram.includes("ghostty") ||
		termProgram.includes("wezterm") ||
		termProgram === "iterm.app" ||
		termProgram.includes("iterm2") ||
		termProgram === "vscode" ||
		termProgram === "apple_terminal" ||
		termProgram === "konsole" ||
		termProgram === "yakuake" ||
		termProgram.includes("rxvt")
	) {
		return true;
	}
	const colorTerm = env.COLORTERM?.toLowerCase() ?? "";
	if (colorTerm.includes("rxvt")) return true;
	const term = env.TERM?.toLowerCase() ?? "";
	return term.startsWith("rxvt");
}

/**
 * Resolve a binary on `PATH` without pulling in a `which` dependency.
 * Returns the absolute path or `undefined`.
 */
function resolveOnPath(binary: string): string | undefined {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return undefined;
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, binary);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

// ----------------------------------------------------------------------------
// Emitters
// ----------------------------------------------------------------------------

/**
 * Spawn `notify-send` as a detached, unref'd process so the agent loop is
 * never blocked on D-Bus. Failures (missing binary, no session bus) are
 * swallowed silently — the next `notify` will retry.
 */
function spawnNotifySend(title: string, body: string): void {
	try {
		const child = spawn("notify-send", ["--app-name", "Pi", "--urgency=normal", "--expire-time=5000", title, body], {
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => {
			// libnotify missing / D-Bus session gone — swallow silently.
		});
		child.unref();
	} catch {
		// spawn can throw synchronously on missing binaries in some Node builds;
		// treat as no-op.
	}
}
