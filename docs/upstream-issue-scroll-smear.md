# [RESOLVED — do not post upstream] Scrollback smear was fork-local

**Status:** root-caused and fixed in this fork. The earlier draft below-the-line
attributed the `ESC[nS` emissions to upstream's differential renderer — that was
wrong. Upstream never emits SU/SD; keep this note as the postmortem.

## Actual root cause (fork commit ab225143)

`interactive-mode.ts` additions wrote raw viewport scrolls directly to the
terminal, bypassing the differential renderer:

- `scrollChatUp/Down` — `ESC[1S` / `ESC[1T` on plain Up/Down whenever the
  editor was non-empty and the cursor sat on the first/last line (i.e. nearly
  every arrow press while composing a one-line prompt). This also shadowed the
  editor's built-in prompt-history browsing on Up.
- `jumpToFirst/Prev/NextMessage` — `ESC[1000S` / `ESC[10S` / `ESC[10T` on the
  alt+g / alt+[ / alt+] message-nav chords.

The renderer tracks `previousViewportTop` / `hardwareCursorRow` and maps
virtual rows to screen rows from them. A raw SU/SD shifts the physical screen
without updating that bookkeeping, so every subsequent differential repaint
lands offset — stale copies of the prompt, footer, and separator accumulate in
scrollback (the "duplicated prompt / duplicated footer" symptom). On Windows
Terminal the SU-scrolled lines are retained in scrollback permanently, which is
why it was so visible there.

The escapes also couldn't deliver the intended feature: `ESC[nT` inserts blank
lines rather than re-entering scrollback on every terminal tested, so the
"scroll chat with arrows" affordance never actually revealed history.

## Fix

Removed all raw SU/SD writes (fix commit follows this doc). Up/Down fall
through to the editor again (restoring prompt-history browsing); message nav
keeps its index/status without touching the screen. Verified by scripted pty:
6× Up + 6× Down on a non-empty single-line prompt now emits **0** SU/SD
(previously 8+ per interaction burst).

Proper scroll-to-message would need a real `scrollOffset` concept in the TUI's
virtual buffer (render a window other than the tail) — a feature, not a fix,
and one that could legitimately be proposed upstream.

---

*Original (incorrect) draft claimed: "when a transient bottom-anchored
component grows (slash autocomplete), the renderer emits `ESC[nS`". The 8
measured emissions in that pty run came from the fork's own arrow-key hooks
firing during autocomplete navigation, not from `packages/tui`.*
