/**
 * SGR mouse protocol (DECSET 1006) parsing.
 *
 * Sequences look like `\x1b[<b;x;yM` (press/move/wheel) or `\x1b[<b;x;ym`
 * (release), where `b` encodes button and modifiers:
 * bits 0-1 = button, bit 2 (4) = shift, bit 3 (8) = alt, bit 4 (16) = ctrl,
 * bit 5 (32) = motion, bit 6 (64) = wheel, bit 7 (128) = buttons 8-11.
 *
 * StdinBuffer splits batched stdin into individual complete sequences before
 * they reach TUI.handleInput, so the parser operates on one sequence at a time.
 */

export interface MouseEvent {
	kind: "press" | "release" | "move" | "wheel-up" | "wheel-down" | "wheel-left" | "wheel-right";
	button: number;
	/** 1-based terminal column */
	x: number;
	/** 1-based terminal row */
	y: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

const SGR_MOUSE_PREFIX = "\x1b[<";
const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** Cheap prefix test for SGR mouse reports (`\x1b[<`). */
export function isSgrMouseSequence(data: string): boolean {
	return data.startsWith(SGR_MOUSE_PREFIX);
}

/**
 * Test for ANY terminal mouse report: SGR (`\x1b[<…M/m`) or legacy X10
 * (`\x1b[M` followed by 3 raw bytes). Legacy reports appear when a terminal
 * or multiplexer downgrades the encoding, or when tracking enabled by a
 * crashed process leaks into a session that never turned it on. They must
 * never reach the keyboard path — their payload bytes are printable
 * characters (button/x/y + 32) that would be typed into the editor.
 */
export function isMouseReportSequence(data: string): boolean {
	return isSgrMouseSequence(data) || data.startsWith("\x1b[M");
}

/** Parse a single SGR mouse sequence. Returns null if it is not one. */
export function parseSgrMouse(data: string): MouseEvent | null {
	const match = data.match(SGR_MOUSE_PATTERN);
	if (!match) return null;

	const code = parseInt(match[1], 10);
	const x = parseInt(match[2], 10);
	const y = parseInt(match[3], 10);

	let button = code & 3;
	if (code & 128) button += 8;

	let kind: MouseEvent["kind"];
	if (code & 64) {
		// Wheel buttons: 0 = up, 1 = down, 2 = left, 3 = right (horizontal
		// wheel/trackpad swipe — kitty, iTerm2, WezTerm emit 66/67).
		const wheel = code & 3;
		kind = wheel === 0 ? "wheel-up" : wheel === 1 ? "wheel-down" : wheel === 2 ? "wheel-left" : "wheel-right";
	} else if (code & 32) {
		kind = "move";
	} else {
		kind = match[4] === "m" ? "release" : "press";
	}

	return {
		kind,
		button,
		x,
		y,
		shift: (code & 4) !== 0,
		alt: (code & 8) !== 0,
		ctrl: (code & 16) !== 0,
	};
}
