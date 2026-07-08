/**
 * ui-logs.ts — INTEGRATED-IN-UI log viewer: DOUBLE-DOWN (↓↓) at an empty prompt — or Shift+Down —
 * opens a focused panel to navigate into any running bg process or subagent and watch live output.
 *
 * KEY LESSON (from pi-background-tasks): pi has a first-class shortcut API — pi.registerShortcut(
 * keyId, {handler}) — with named KeyIds like "shift+down". Earlier attempts hand-matched raw escape
 * bytes via onTerminalInput, which the editor consumes and which varies by terminal mode — that's
 * why Ctrl+K / plain ↓ never worked. registerShortcut is the correct, robust path.
 *
 * Status bar: "N running · ↓↓ logs". ↓↓ (double-down, mirrors pi's double-Esc→tree) or Shift+Down
 * opens the panel: process list (↑↓ select) + live output (auto-refresh); f=follow, x=stop, Esc=close.
 *
 * Config: KP_UI_LOGS_ENABLED=0 disable.
 */

import * as registry from "./process-registry.ts";

const ENABLED = process.env.KP_UI_LOGS_ENABLED !== "0";
const TAIL_LINES = 60;
const icon = (s: string) => (s === "running" ? "⏳" : s === "done" ? "✓" : s === "killed" ? "⊘" : "✗");

// INLINED (no external dep) equivalents of pi-tui's width helpers — the WORKING package uses these
// to width-normalize every rendered row, which is what makes a custom() overlay actually draw
// (unpadded/ragged lines render as nothing). Kept dependency-free so the extension always loads.
// visibleWidth: count display columns, treating most non-ASCII as width-1 (good enough for our
// box glyphs + text; wide CJK is rare in logs and only affects padding by a column).
const visibleWidth = (s: string): number => {
	// strip ANSI, count code points
	return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
};
const truncateToWidth = (s: string, w: number): string => {
	const clean = s;
	if (visibleWidth(clean) <= w) return clean;
	const chars = [...clean];
	return `${chars.slice(0, Math.max(0, w - 1)).join("")}…`;
};
const pad = (v: string, width: number): string => v + " ".repeat(Math.max(0, width - visibleWidth(v)));
// arrow-key match across normal + application-cursor terminal modes.
const matchesKey = (data: string, key: "up" | "down" | "escape"): boolean => {
	if (key === "up") return data === "\x1b[A" || data === "\x1bOA";
	if (key === "down") return data === "\x1b[B" || data === "\x1bOB";
	return data === "\x1b";
};

function tail(text: string, n = TAIL_LINES): string {
	const lines = (text || "").split("\n");
	return lines.length > n ? `…(${lines.length - n} earlier lines)\n${lines.slice(-n).join("\n")}` : lines.join("\n");
}

export default function (pi: any) {
	if (!ENABLED) return;

	let ui: any = null;
	let opening = false; // guard against re-entrancy while the picker is open

	let lastDown = 0; // for double-down detection (like pi's double-Esc → tree)
	let keyBound = false;

	const openIfAny = async (): Promise<void> => {
		if (opening) return;
		if (!registry.all().length) {
			ui?.notify?.("Nothing running yet — start a bg_run or delegate a subagent.", "info");
			return;
		}
		await openViewer();
	};

	const grab = (_e: any, ctx: any) => {
		if (!ctx?.ui) return;
		ui = ctx.ui;
		// DOUBLE-DOWN gesture (mirrors pi's double-Esc → session tree): two ↓ within 500ms at an EMPTY
		// prompt opens the process/agent panel. onTerminalInput runs before the editor; we only act on
		// the second ↓ when the prompt is empty, so single ↓ / typing is never disturbed.
		if (!keyBound && typeof ctx.ui.onTerminalInput === "function") {
			const isDown = (d: string) => d === "\x1b[B" || d === "\x1bOB";
			const emptyPrompt = () => {
				try {
					return !(ui?.getEditorText?.() || "").trim();
				} catch {
					return true;
				}
			};
			ctx.ui.onTerminalInput((data: string) => {
				if (!isDown(data) || !emptyPrompt() || opening) {
					if (isDown(data)) lastDown = 0;
					return;
				}
				const now = Date.now();
				if (now - lastDown < 500) {
					// second ↓ in the window → open the panel
					lastDown = 0;
					void openIfAny();
					return { consume: true };
				}
				lastDown = now; // first ↓ — record, let it pass (does nothing at empty prompt)
			});
			keyBound = true;
		}
		// Keep the affordance in the status bar in sync as jobs/agents start and finish.
		refreshHint();
	};

	// Also register the named shortcut (Shift+Down) as an explicit alternative — the first-class API
	// (learned from pi-background-tasks). Both open the same viewer.
	if (typeof pi.registerShortcut === "function") {
		pi.registerShortcut("shift+down", {
			description: "Open the background process / agent log viewer",
			handler: async (ctx: any) => {
				if (ctx?.ui) ui = ctx.ui;
				await openIfAny();
			},
		});
	}

	// Refresh the hint the INSTANT a job starts/finishes (not only on the next turn hook), so
	// "N running · ↓↓ logs" appears immediately when you bg_run something.
	registry.onChange(() => refreshHint());

	function refreshHint(): void {
		if (!ui?.setStatus) return;
		// Only show the affordance while something is RUNNING — clears the moment jobs finish (no
		// lingering "recent" hint). The panel can still be opened to view finished jobs' logs.
		const running = registry.running().length;
		try {
			ui.setStatus("kp-logs-hint", running ? `${running} running · ↓↓ logs` : undefined);
		} catch {}
	}

	// A focusable, NAVIGABLE overlay panel (Claude-Code-style) — not a modal picker. It renders the
	// process list on the left, the selected one's live output on the right, and handles arrow keys /
	// enter / x inside itself. Built via ctx.ui.custom (a focusable Component with render+handleInput).
	async function openViewer(): Promise<void> {
		if (typeof ui?.custom !== "function") {
			// Fallback for a UI without custom(): the old picker path.
			return openViewerFallback();
		}
		opening = true;
		try {
			await ui.custom(
				(tui: any, _theme: any, _kb: any, done: (r: any) => void) => {
					let sel = 0; // selected process index
					let follow = true; // auto-refresh the output view
					let timer: any = setInterval(() => tui?.requestRender?.(), 700); // live-refresh while open

					// A bordered, width-normalized frame — modeled on the working package's frame(). EVERY row
					// is padded to exactly `inner` visible cols via truncateToWidth+pad; that's what makes an
					// overlay actually draw (unpadded/ragged lines render as nothing).
					const frame = (title: string, rows: string[], footer: string, width: number): string[] => {
						const inner = Math.max(1, width - 2);
						const row = (c = "") => `│${pad(truncateToWidth(c, inner), inner)}│`;
						const out = [`╭${"─".repeat(inner)}╮`, row(` ${title}`), row("")];
						for (const r of rows) out.push(row(r));
						out.push(row(""), row(` ${footer}`), `╰${"─".repeat(inner)}╯`);
						return out;
					};

					const panel: any = {
						render(width: number): string[] {
							const w = Math.max(20, Math.min(width, 118));
							const list = registry.all();
							if (!list.length) return frame("logs", ["  nothing running"], "Esc close", w);
							sel = Math.max(0, Math.min(sel, list.length - 1));
							const cur = list[sel];
							const leftW = 30;
							const left = list.map(
								(e, i) =>
									`${i === sel ? "›" : " "} ${icon(e.state())} ${truncateToWidth(`${e.id} · ${e.label}`, leftW - 4)}`,
							);
							const out = (
								follow || cur.state() !== "running" ? tail(cur.output(), 12) : "(paused — press f to follow)"
							).split("\n");
							const rows: string[] = [];
							const n = Math.max(left.length, Math.min(out.length, 12), 1);
							for (let i = 0; i < n; i++) {
								const l = pad(truncateToWidth(left[i] || "", leftW), leftW);
								const r = out[i] || "";
								rows.push(` ${l} │ ${r}`);
							}
							return frame(
								`live logs · ${cur.id} (${cur.state()})`,
								rows,
								"↑↓ select · f follow · x stop · Esc close",
								w,
							);
						},
						handleInput(data: string): void {
							const list = registry.all();
							if (matchesKey(data, "up") || data === "k") sel = Math.max(0, sel - 1);
							else if (matchesKey(data, "down") || data === "j") sel = Math.min(list.length - 1, sel + 1);
							else if (data === "f") follow = !follow;
							else if (data === "x") {
								try {
									list[sel]?.kill?.();
								} catch {}
							} else if (matchesKey(data, "escape") || data === "q" || data === "\x03") {
								done("closed");
								return;
							}
							tui?.requestRender?.();
						},
						invalidate() {},
						dispose() {
							if (timer) {
								clearInterval(timer);
								timer = null;
							}
						},
					};
					return panel;
				},
				{
					// Match the WORKING pi-background-tasks package: without overlayOptions the overlay renders
					// unpositioned/zero-size and is INVISIBLE. anchor + width + maxHeight make it actually show.
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "96%",
						minWidth: 64,
						maxHeight: "60%",
						margin: { bottom: 1, left: 1, right: 1 },
					},
				},
			);
		} finally {
			opening = false;
			refreshHint();
		}
	}

	// Fallback (no custom()): modal picker chain.
	async function openViewerFallback(): Promise<void> {
		if (!ui?.select) return;
		opening = true;
		try {
			const list = registry.all();
			if (!list.length) {
				ui.notify?.("Nothing running.", "info");
				return;
			}
			const options = list.map((e) => `${icon(e.state())} [${e.kind}] ${e.id} · ${e.label.slice(0, 46)}`);
			const choice = await ui.select("Live logs — pick a process:", options);
			if (!choice) return;
			const entry = list[options.indexOf(choice)];
			for (;;) {
				const st = entry.state();
				ui.notify?.(
					`${icon(st)} [${entry.kind}] ${entry.id} · ${st}\n${entry.label}\n${"─".repeat(40)}\n` +
						(tail(entry.output()) || "(no output yet)"),
					"info",
				);
				if (st !== "running") return;
				const next = await ui.select(`${entry.id} · still running:`, [
					"↻ refresh",
					...(entry.kill ? ["⊘ stop it"] : []),
					"✕ close",
				]);
				if (!next || next.startsWith("✕")) return;
				if (next.startsWith("⊘")) {
					try {
						entry.kill?.();
					} catch {}
					ui.notify?.(`⊘ stopped ${entry.id}`, "info");
					return;
				}
			}
		} finally {
			opening = false;
			refreshHint();
		}
	}

	// Grab a ui-carrying ctx (for the status hint) from any lifecycle hook.
	pi.on("session_start", grab);
	pi.on("turn_start", grab);
	pi.on("tool_result", grab);
	pi.on("turn_end", grab);
	pi.on("message_end", grab);

	// /logs — same viewer, for non-interactive UIs or if you prefer typing it.
	pi.registerCommand?.("logs", {
		description: "Open the live process/agent log viewer (also: Shift+Down)",
		handler: async (_args: string, ctx: any) => {
			if (ctx?.ui) ui = ctx.ui;
			if (typeof ui?.custom !== "function" && typeof ui?.select !== "function") {
				ctx.ui.notify("Log viewer needs the interactive TUI.", "warning");
				return;
			}
			if (!registry.all().length) {
				ctx.ui.notify(
					"Nothing running or recorded yet. Start a bg_run or delegate a subagent, then /logs.",
					"info",
				);
				return;
			}
			await openViewer();
		},
	});
}
