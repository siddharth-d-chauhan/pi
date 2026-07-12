/**
 * chips.ts — the pi TUI design language (user-picked, 2026-07-12):
 *
 *   structure  painted label chip + bold SECTION headers (concept "1B chips")
 *   bars       blocks █░
 *   status     pills (dark tinted bg + bright fg)
 *   criteria   ▣ filled-green = pass · □ rim-red = failing · □ rim-dim = todo
 *   dots       ○ unfilled, RIM color carries state (green/red/amber/blue)
 *   footer     copper key letter + muted label
 *   cursor     copper rail ▎ + subtle row tint (concept "2C")
 *
 * Pure string helpers with TARGETED resets (\x1b[39m fg / \x1b[49m bg — never
 * \x1b[0m) so they compose inside painted rows. Truecolor, matching the
 * precedent set by lib/card.ts (copper/heatLine are already truecolor).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---- palette (dark-theme tuned, same family as the concept mocks) ----------
const FG = (r: number, g: number, b: number) => (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
const BG = (r: number, g: number, b: number) => (s: string) => `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m`;

export const ink = FG(232, 234, 237);
export const soft = FG(154, 162, 173);
export const faint = FG(107, 114, 128);
export const copper = FG(184, 115, 51);
export const ember = FG(226, 114, 91);
export const green = FG(79, 181, 124);
export const amber = FG(214, 166, 72);
export const blue = FG(106, 159, 232);
export const red = FG(224, 108, 117);
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
export { bold };

// ---- painted label chip:  LOOP  (copper bg, near-black fg, bold) -----------
export function chip(label: string): string {
	return BG(184, 115, 51)(FG(13, 15, 19)(bold(` ${label} `)));
}

// ---- status pills -----------------------------------------------------------
export type PillKind = "green" | "amber" | "red" | "blue" | "neutral";
const PILL: Record<PillKind, { bg: [number, number, number]; fg: [number, number, number] }> = {
	green: { bg: [20, 53, 31], fg: [82, 214, 138] },
	amber: { bg: [58, 44, 16], fg: [232, 187, 92] },
	red: { bg: [58, 21, 24], fg: [239, 139, 139] },
	blue: { bg: [22, 40, 63], fg: [125, 177, 245] },
	neutral: { bg: [35, 42, 53], fg: [205, 211, 220] },
};
export function pill(kind: PillKind, text: string): string {
	const p = PILL[kind];
	return BG(...p.bg)(FG(...p.fg)(` ${text} `));
}

/** Loop/agent status → pill. */
export function statusPill(status: string): string {
	const s = status.toLowerCase();
	if (s === "completed" || s === "done") return pill("green", "COMPLETED");
	if (s === "running") return pill("amber", "RUNNING");
	if (s === "parked") return pill("blue", "PARKED");
	if (s === "failed" || s === "cancelled") return pill("red", s.toUpperCase());
	return pill("neutral", status.toUpperCase());
}

// ---- block progress bar █░ --------------------------------------------------
export function blockBar(done: number, total: number, width: number, color: (s: string) => string = green): string {
	if (total <= 0 || width <= 0) return "";
	const filled = Math.round((Math.min(done, total) / total) * width);
	return color("█".repeat(filled)) + faint("░".repeat(Math.max(0, width - filled)));
}

// ---- criterion marks: fill = pass, rim color = state ------------------------
export function critMark(state: "pass" | "fail" | "todo"): string {
	if (state === "pass") return green("▣");
	if (state === "fail") return red("□");
	return faint("□");
}

// ---- rim dots: ○ colored rim only -------------------------------------------
export type DotState = "done" | "fail" | "working" | "info" | "idle";
export function dot(state: DotState): string {
	if (state === "done") return green("○");
	if (state === "fail") return red("○");
	if (state === "working") return amber("○");
	if (state === "info") return blue("○");
	return faint("○");
}

/** Verdict text → colored verdict pill for the timeline. */
export function verdictPill(verdict: string): string {
	const v = verdict.toLowerCase();
	if (v === "done") return pill("green", "done");
	if (v.includes("review") && (v.includes("fail") || v.includes("✗"))) return pill("red", "review ✗");
	if (v.includes("review")) return pill("green", "review ✓");
	if (v === "blocked") return pill("red", "blocked");
	if (v === "continue") return pill("neutral", "continue");
	return pill("neutral", verdict.slice(0, 12));
}
export function dotForVerdict(verdict: string): string {
	const v = verdict.toLowerCase();
	if (v.includes("fail") || v === "blocked") return dot("fail");
	if (v === "continue") return dot("working");
	return dot("done");
}

/** Background-process status → rim dot. */
export function dotForStatus(status: string): string {
	const s = status.toLowerCase();
	if (s === "running") return dot("working");
	if (s === "completed" || s === "done") return dot("done");
	if (s === "failed" || s === "cancelled") return dot("fail");
	if (s === "parked") return dot("info");
	return dot("idle");
}

// ---- row with a right-flush trailing field (e.g. age) -----------------------
/** Compose `left … right` so the whole thing is exactly `width` visible cells,
 *  right flush at the end. Left is truncated (with …) if the pair overflows. */
export function rowAlign(left: string, right: string, width: number): string {
	const rw = visibleWidth(right);
	const room = Math.max(0, width - rw - 1);
	const l = truncateToWidth(left, room);
	const gap = Math.max(1, width - visibleWidth(l) - rw);
	return l + " ".repeat(gap) + right;
}

// ---- SECTION header ----------------------------------------------------------
export function section(label: string, suffix = ""): string {
	return ` ${soft(bold(label.toUpperCase()))}${suffix ? `  ${suffix}` : ""}`;
}

// ---- copper-key footer -------------------------------------------------------
export function keyHints(pairs: Array<[key: string, label: string]>): string {
	return ` ${pairs.map(([k, l]) => `${copper(k)} ${soft(l)}`).join("   ")}`;
}

// ---- 2C cursor: copper rail + subtle row tint --------------------------------
const TINT: [number, number, number] = [26, 33, 44];
export function cursorRow(content: string, width: number): string {
	const inner = truncateToWidth(content, Math.max(1, width - 1));
	const pad = " ".repeat(Math.max(0, width - 1 - visibleWidth(inner)));
	return copper("▎") + BG(...TINT)(inner + pad);
}
export function plainRow(content: string, width: number): string {
	return ` ${truncateToWidth(content, Math.max(1, width - 1))}`;
}
