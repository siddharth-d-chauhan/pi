# CLAUDE.md — pi-harness (the agent's extensions)

pi is extended via `extensions/*.ts`, registered in **both** `<repo>/.pi/settings.json` (project) and
`~/.pi/agent/settings.json` (global) — **edits must be synced to both** or they won't load in real
sessions. Extensions never patch pi's source. Verify a change loads with:
`node -e "import('./extensions/X.ts').then(()=>console.log('ok')).catch(e=>console.log(e.message))"`.

## TUI / UI extension API (from pi.dev/docs/latest/tui + verified in source)

pi's UI methods live on **`ctx.ui`** (the `ExtensionUIContext` passed to each hook/command), NOT on
`pi` and NOT on `ctx` directly. `pi` (ExtensionAPI) only has `on` / `registerTool` /
`registerCommand` / `registerShortcut` / `registerFlag`.

**Keybindings — use `pi.registerShortcut(keyId, {description, handler})`.** `keyId` is a NAMED key:
`"shift+down"`, `"ctrl+shift+p"`, `"enter"`, `"escape"`, etc. pi maps the escape sequence for you.
Do NOT hand-match raw escape bytes via `ctx.ui.onTerminalInput` for a hotkey — the editor eats many
keys (Ctrl+K = kill-line in the tui package), plain ↓ varies by terminal mode (`\x1b[B` vs `\x1bOB`),
and Shift+Down is `\x1b[b` (lowercase). `registerShortcut` is the only robust path.

**`ctx.ui` methods:**
- `setStatus(id, text)` — persistent footer segment. `undefined` clears. Footer renders these
  unconditionally when present.
- `setWidget(id, string[], opts?)` — content above/below the editor (`{placement:"aboveEditor"}`).
- `setWorkingMessage(msg?)` / `setWorkingIndicator({frames, intervalMs})` — the streaming loader.
- `notify(msg, "info"|"warning"|"error")` — a transient notice.
- `select(title, options[])` / `confirm` / `input` — **modal, FOCUS-STEALING dialogs.** Do NOT use
  from a background/proposal flow — a modal that pops mid-turn interrupts the user's typing. Use a
  passive `setWidget` + a `/command`, or a `custom()` overlay opened on demand.
- `custom<T>(factory, {overlay, overlayOptions})` — a focusable overlay Component. THE way to build
  a navigable panel.

**`custom()` overlay — the navigable-panel pattern:**
```ts
await ctx.ui.custom((tui, theme, keybindings, done) => ({
  render(width) { /* return string[] — see width rule */ },
  handleInput(data) { if (matchesKey(data,"up")) …; if (data==="\x1b") done("closed"); tui.requestRender(); },
  invalidate() {}, dispose() {},
}), {
  overlay: true,
  overlayOptions: { anchor: "bottom-center", width: "96%", minWidth: 50, maxHeight: "60%", margin: {bottom:1,left:1,right:1} },
});
```
- **overlayOptions is REQUIRED to be visible** — bare `{overlay:true}` renders unpositioned/zero-size
  = invisible. anchor ∈ 9 positions (center, top-left, bottom-center…).
- **Every render() line MUST be ≤ width visible columns** — ragged/over-wide lines draw as nothing.
  Pad/truncate with `truncateToWidth(s,w)` + `visibleWidth(s)` from `@earendil-works/pi-tui` (or
  inline equivalents to avoid the dep). This is the #1 cause of "the panel is invisible".
- Match keys inside with `matchesKey(data, "up"|"down"|"escape")` (handles all terminal modes).

**Hook ctx shapes:** event handlers get `(event, ctx)`. Tool `execute` is
`(id, params, signal, onUpdate, ctx)` — **ctx is the 5th arg** (a 4-arg sig makes "ctx" = onUpdate,
a silent no-op). A `noOpUIContext` stub (every method a no-op) is used when not interactive;
`ctx.mode === "tui"` when real.

**Mouse / clickable widgets: NOT supported.** pi never enables mouse tracking (no DECSET
`?1000h`/`?1006h`), so terminals don't send clicks to pi. Keyboard only.

## CROSS-EXTENSION SHARED STATE — use `globalThis`, not a shared imported module

pi loads EACH extension with its own jiti instance and `moduleCache:false` (coding-agent
loader.ts). So `import "./shared.ts"` from two different extensions gives each a SEPARATE module
instance — a module-level `const map = new Map()` does **not** share. Symptom: writer populates its
copy, reader sees an empty copy (e.g. background.ts registered a job but ui-logs read nothing →
"nothing running"). **Fix: back shared state on `globalThis`**:
```ts
const S = (globalThis as any).__kpFoo ??= { map: new Map(), listeners: new Set() };
```
process-registry.ts and ui-agent-cards.ts do this.

## KV-cache discipline

Per-turn context changes must not mutate the cached system-prompt prefix. System-prompt injections
(`before_agent_start`) must be byte-identical every turn (build once + memoize). Dynamic content goes
in the conversation TAIL via the `context` hook as append-only, byte-stable messages. See `/context`
and `/cache-check`. CLAUDE.md is injected ONCE per session (claude-md.ts) — a `#`-add doesn't churn
the prefix; it stays as normal input.

## Memory capture (this session's rework)

Regex detects candidate corrections/preferences (cheap, every turn), but it can't read intent — a
question's "say no if you don't know" once matched a correction pattern. So capture = PROPOSE, not
silent-store: candidates queue into a passive widget; `/memory` (or `/memory review`) opens a
focusable accept/reject panel; rejections persist (memory-rejected.json) and generalize to
paraphrases (keyword-overlap ≥60%) so you're not re-prompted. Nothing enters the brain until you
accept. Patterns are tightened + exclude questions/requests up front.

## Memory delivery (write-time compilation — KP never on the turn path)

All expensive work happens at WRITE time; the read path is local, precompiled, conditional.
Every accepted/promoted memory lands in one of three delivery lanes:

- **always-on** — the digest (`.pi/pi-memory.md`), true globals only, injected once per session.
- **triggered** — a recurring `@file:`-scoped steer compiles to a glob-gated rule
  (`.pi/rules/mem-*.json`, `source:"memory"`); rules.ts fires it the moment a matching file is
  touched (tier 1.5 glob-trigger, mtime-reloaded mid-session) — zero tokens on every other turn.
- **on-demand** — episodic/procedural bulk stays in the brain, pulled via `recall_memory`.

The per-turn proactive lane matches against a LOCAL snapshot of typed memories
(`.pi/memory-snapshot.json`, background-synced via `knowledge.memory_by_kind` at session start +
after accepts) — a lexical IDF matcher, ~2-13ms measured, so the 300ms same-turn window actually
lands (the KP cross-encoder is 10-15s on this stack and only serves deliberate pulls now).
Error-shaped tool results additionally trigger a checkpoint recall ("hit this before?") allowed ONE
budgeted mid-task injection (`KP_MEMORY_ERROR_*`). Reflect writes imperative directives
("When X, do Y"), not descriptions of past mistakes.
