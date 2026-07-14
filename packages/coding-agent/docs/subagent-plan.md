# pi Subagent System — Implementation Plan

Companion to `subagent-design.md`. This is the build order: file-by-file scope, exact seams
into upstream code, type contracts, test gates, and risks. Every phase ends green
(`npm run check` + `./test.sh`) and independently shippable/committable.

## Ground rules

- **Mergeability**: new modules under `packages/coding-agent/src/core/agents/` and
  `modes/interactive/components/`; upstream files gain only one-line registrations or
  optional seams (AGENTS.md escalation ladder rungs 2–3).
- **One enforcement point**: spawn policy, depth, tool stripping all live in
  `spawn.ts` — never duplicated into children via env vars.
- **Domain-neutral core**: subagents are scoped workers for any tool-backed domain, not only
  coding. Coding-specific affordances (diff review, tests, git worktrees) are optional layers
  activated only when the agent uses workspace/code tools.
- **Permission safety before autonomy**: Phase 1 must preserve the parent's approval story by
  constraining child tool exposure and failing closed for unsafe parallel shared-state writes.
  A full child approval bridge for write/execute/network-sensitive actions is Phase 2 work.
- **Shared-workspace writes are opt-in**: parallel filesystem/project-write agents run in an
  isolation primitive when one exists (git worktree for repos, domain-specific isolation for
  other tools) or serialize. The default must not let two background agents mutate the same
  workspace state blindly.
- **Scalable discovery**: tool descriptions may include a small stable agent roster, but
  large or changing registries use a read-only listing/search tool plus cache-stable
  system-reminder deltas.
- **Strict-mode-safe schemas from day one** (omp pitfall #7): no top-level unions in tool
  params; optional fields via `Type.Optional`; test against the faux provider AND one
  strict-mode shape check.
- **Tests**: every phase adds suite tests under `packages/coding-agent/test/suite/agents/`
  using `test/suite/harness.ts` + faux provider (no real APIs). Regression tests for every
  pitfall in the design doc's ledger.

## Current implementation status

Last updated: 2026-07-08.

Implemented and verified:
- ✅ Agent definition discovery/parsing with project/user/package/bundled precedence.
- ✅ Bundled domain-neutral agents: `explore`, `plan`, `worker`, `reviewer`.
- ✅ Agent model role resolution (`pi/<role>`), fallback chains, overrides, cycle guards.
- ✅ Result handle store with cap/spill, `agent://` refs, JSON-path pulls, regex windows.
- ✅ `agent_list` read-only discovery tool.
- ✅ `agent_pull` read-only artifact pull tool.
- ✅ Tool registration/category/default-active wiring for `agent`, `agent_list`, and
  `agent_pull`.
- ✅ Agent settings block and getters for depth/concurrency/model roles/overrides/etc.
- ✅ Focused suite/regression tests for the implemented foundation.
- ✅ Phase 0 concurrent-session spike (`test/suite/agents/concurrent-sessions.test.ts`).
- ✅ `spawnAgent` core: depth/spawn-policy/self-spawn/permission-mode guards, per-spawn
  semaphore, in-flight race-free isolation reservation, child session factory contract,
  registry bridge with `tokens=`/`cost=` line on `agent_end`, turn-cap steer+abort,
  cap/spill finalization, usage trailer, child lineage propagation, and instructional
  permission-mode prompt text.
- ✅ `core/tools/agent.ts` runtime tool: typed schema (single `tasks` array, mixed sync
  + background), `agent_list`-style discovery wired into description, definition-level
  background defaults, default factory that builds a child `AgentSession` via
  `createAgentSession` with `noContextFiles`, configured `agentDir` session storage, and
  `parentSession` header propagation, and child extension loading disabled.
- ✅ `agent_list` uses the same project/user/package/bundled definition discovery inputs as
  spawn routing when package agent dirs are supplied.
- ✅ Explicit empty/effectively empty tool allowlists are treated as non-mutating/read-only
  for the shared-workspace gate.
- ✅ Tool registered in `tools/index.ts` (`ToolName`/`allToolNames`/switch cases), tagged
  `coord` in `tool-categories.ts`, added to default-active in both `sdk.ts` and
  `agent-session.ts`.
- ✅ Existing read-only discovery tools (`grep`, `find`, `ls`) are default-active so bundled
  read-only agents receive the tools their definitions request.
- ✅ Phase 1 faux-provider tests for the spawn path (`test/suite/agents/spawn.test.ts`):
  custom-prompt forwarding, self-spawn ban, spawns allowlist, depth cap, sync happy
  path with usage, in-flight counter release on factory throw.
- ✅ Background registry control-plane extensions: subagent metadata, metrics, result handle,
  kill/steer callbacks, `idle` status, guarded `x` kill in the log panel, and metrics line.
- ✅ Background launches return a registry id before waiting on a saturated child concurrency
  slot; synchronous launches still wait for capacity.
- ✅ Result usage trailers include the real background registry id (`agentId: bg-...`) rather
  than a placeholder.
- ✅ Background completion notification injection via a visible `<task-notification>` custom
  message that triggers the idle parent immediately or follows up an active parent turn.
- ✅ TUI background surfaces covered by headless render regressions: below-editor status
  widget log preview, log-panel metrics/result handle display, and selected-task kill.
- ✅ Focused agent/regression suite clean locally; `npm run check` clean.

Partially done:
- ⚠️ `agent-session.ts` received a small additive `agentDir` getter and a
  `systemPromptOverride` config field for the spawn seam — the rest of the file is
  unchanged.
- ⚠️ Worktree isolation is enforced as a *configuration gate* (parallel mutating spawns
  fail closed with a clear error and a pointer to `agents.allowSharedWorkspaceWrites`
  or `isolation: worktree`); the actual git-backed worktree helper is still Phase 4
  polish, not a Phase 1 blocker.
- ⚠️ Permission mode is currently enforced through child tool exposure plus system-prompt
  instructions. Parent approval bubbling for child write/execute/network-sensitive actions is
  not implemented yet.

Remaining before Phase 1 is complete:
- ⬜ Manual smoke against a real cheap model (per the Phase 1 exit criteria in §1.5/§1.6).

---

## Phase 0 — Concurrency spike (½ day, de-risks everything)

The audit found no proof two `AgentSession`s ever ran concurrently in one process.

Status: ✅ implemented and covered by `test/suite/agents/concurrent-sessions.test.ts`.

**`test/suite/agents/concurrent-sessions.test.ts`**
- Create two `createAgentSession` instances with the faux provider (different fake models),
  run overlapping `prompt()` calls, assert: interleaved events don't cross streams, both
  sessions complete, `getSessionStats()` are independent, background registry entries don't
  collide.
- Probe the known globals: shared fetch dispatcher (http-dispatcher), theme singleton
  (not touched headless), extension runtime invalidation (child sessions load ZERO extensions
  in phase 1 — decision below — so this is moot initially).
- **Exit criteria**: green test, or a documented list of globals to fix first.

Decision locked here: **children load no extensions in Phase 1** (fast spawn, no jiti cost, no
invalidation interplay). This is enforced by the default child session factory. Extension
support for children is a Phase 4 opt-in
(`agents.childExtensions: true`).

---

## Phase 1 — Foundation: definitions, spawn, tool, handles (the big one)

### 1.1 `core/agents/definitions.ts` (~250 LoC)

Status: ✅ implemented as additive core module with bundled generic agents and tests.

```ts
export interface AgentDefinition {
  name: string;                    // lookup is case-INSENSITIVE, stored lowercase
  description: string;             // routing text; required
  systemPrompt: string;            // markdown body
  tools?: string[];                // allowlist; undefined = defaults; '*' = all
  disallowedTools?: string[];       // subtractive denylist, applied after tools
  permissionMode?: "inherit" | "bubble" | "auto" | "read-only";
  spawns?: string[] | "*";         // default: none
  model?: string;                  // id, provider/model, or role alias "pi/<role>"
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;               // default 40
  background?: boolean;
  isolation?: "none" | "worktree";
  omitProjectContext?: boolean;
  output?: TSchema;                // structured output (JSON schema in frontmatter)
  color?: string;
  source: "bundled" | "user" | "project" | "package";
  filePath?: string;
}
export function loadAgentDefinitions(cwd: string, agentDir: string): AgentDefinitionRegistry;
```

- Parser: gray-matter-style frontmatter (reuse whatever ResourceLoader uses for skills —
  check `resource-loader.ts` first; do NOT add a dependency). Lenient: unknown keys ignored
  with a debug log; a bad user/project file warns and skips; a bad bundled file throws.
- Discovery precedence: project `.pi/agents/**/*.md` → user `~/.pi/agent/agents/**/*.md` →
  bundled (in `core/agents/bundled/*.md`, imported as strings). First-wins by lowercase name.
- **Seam**: one entry in ResourceLoader's discovery table so `--list-resources`/packages see
  agents. If ResourceLoader's shape doesn't fit cheaply, defer the seam — the loader above is
  self-sufficient; note it as Phase 4 cleanup.
- Bundled agents stay generic enough to use outside coding: `explore.md` (read-only
  information gathering), `plan.md` (read-only task planning), `worker.md` (general execution),
  `reviewer.md` (independent verification). Code-specific examples can ship as project/user
  agent definitions or package-provided agents rather than hardwired core behavior.
- `omitProjectContext` is honored only for bundled read-only agents by default. User/project
  agents can use it only when `agents.allowOmitProjectContext: true` is set, because skipping
  AGENTS.md/context files can bypass repo rules.
- Tests: precedence override, case-insensitive lookup (`Reviewer` == `reviewer`), lenient
  parse (unknown keys, invalid YAML → skip w/ warning), tools/disallowedTools CSV and array
  forms, permissionMode validation, output schema passthrough, `omitProjectContext` gating.

### 1.2 `core/agents/model-roles.ts` (~80 LoC)

Status: ✅ implemented with `pi/<role>` aliases, per-agent model overrides, configured
fallback chains, case-insensitive override lookup, inherit fallback, and cycle detection.

```ts
export function resolveAgentModel(
  spec: string | undefined,          // "pi/smol" | "anthropic/claude-x" | "claude-x" | undefined
  parent: Model, registry: ModelRegistry, settings: SettingsManager,
): { model: Model; inherited: boolean }
```
- Role aliases from `settings agents.roles: Record<string, string[]>` (priority chain, first
  available wins — availability = `registry.hasConfiguredAuth`). Cycle-guard on alias
  recursion (omp does alias recursion; cap depth 4).
- Per-type override map `agents.modelOverrides` applied before resolution.
- If resolved alias tier == parent's tier → return parent's exact model object (Claude Code
  cache-parity trick).
- Tests: chain fallback, cycle guard, override map, inherit default.

### 1.3 `core/agents/handles.ts` (~150 LoC) — externalized returns

Status: ✅ implemented as `AgentHandleStore` with cap/spill, `agent://` pulls, JSON subpaths,
regex windows, and runtime `agent_pull` tool wiring.

```ts
export interface AgentArtifact { id: string; path: string; bytes: number }
export function capReturn(id: string, text: string, capChars?: number):
  { inline: string; handle?: string }   // handle = "agent://<id>"
export function pullHandle(ref: string): string  // agent://<id>[/json.path | ?q=/regex/]
```
- Artifacts dir: `<agentDir>/artifacts/<id>.md` (bounded cleanup and per-session partitioning
  later). JSON-path pull when the artifact parses as JSON (structured output case); regex
  windowed slice otherwise (port delegate.ts `pullHandle`, it's proven).
- Also register `agent://` in whatever pi uses to resolve `@`-mention-like refs later — NOT
  in phase 1; the `agent` tool gets a `pull` action instead? No — keep one tool; pull is a
  tiny separate read-only tool `agent_pull { ref }` (always available to agents' parents).
- Tests: cap boundary, JSON path pull, regex pull, missing handle error text.

### 1.4 `core/agents/spawn.ts` (~400 LoC) — the heart

Status: ✅ implemented as `core/agents/spawn.ts` with focused faux-provider tests.

```ts
export interface SpawnOptions {
  definition: AgentDefinition;
  prompt: string; context?: string;
  parent: { session: AgentSession; depth: number; sessionFile?: string };
  modelOverride?: string; background: boolean;
  name?: string;                     // registry display + addressing
  signal?: AbortSignal;
}
export interface SpawnResult {
  status: "completed" | "failed" | "cancelled";
  inline: string; handle?: string;
  usage: { tokens: number; costUsd: number; requests: number; durationMs: number };
  sessionFile?: string; registryId: string;
}
export async function spawnAgent(opts: SpawnOptions, deps: SpawnDeps): Promise<SpawnResult>
```

Internals:
1. **Guards**: depth (`agents.maxDepth`, default 2), spawns allowlist, self-spawn-by-type ban,
   per-session semaphore (`agents.maxConcurrency`, default 8, **re-read each spawn**).
2. **Permissions + isolation preflight**:
   - Effective tools = defaults/allowlist minus `disallowedTools`, then spawn-policy
     stripping. Parent plan/read-only mode forces a read-only tool set and clears spawns.
   - Permission mode default is `bubble`, but Phase 1 enforcement is limited to tool exposure
     and child prompt instructions. Parent approval bubbling for child write/execute/network-
     sensitive actions is Phase 2 work.
   - Phase 1 implements a shared-workspace mutation gate: background or concurrent mutating
     agents fail closed unless `agents.allowSharedWorkspaceWrites` is set. The actual
     git-backed `isolation: "worktree"` helper is Phase 4 work.
3. **Child session**: `createAgentSession({ cwd, agentDir, authStorage: parentAuth,
   modelRegistry: parentRegistry, model: resolved, thinkingLevel, tools: effectiveTools,
   customTools: [], noTools: undefined, settingsManager: snapshot, sessionManager, ... })`.
   - `sessionManager`: `SessionManager.create(cwd, agentDir, { parentSession: parentFile })`
     for named/background agents; `inMemory()` for one-shot sync workers (setting
     `agents.persistSessions: "always" | "background" | "never"`, default `background`).
   - Settings snapshot: clone parent SettingsManager view with compaction on, retry on,
     **no extensions**, parent-derived tool exposure, and permission-mode instructions in the
     child prompt. A child approval bridge that bubbles prompts to the parent session is Phase
     2 work.
   - System prompt: definition body + `## CONTEXT` (the shared `context` field) +
     `## OUTPUT CONTRACT` (if `output` schema — "call the `finish` tool"). If
     `omitProjectContext`, pass the option that suppresses AGENTS.md/context files (check
     `sessionStartEvent`/resourceLoader path; if no such option exists upstream, add ONE
     optional flag `omitProjectContext?: boolean` to CreateAgentSessionOptions — hook-sized
     seam, undefined-safe).
4. **Turn cap**: subscribe to `turn_end`; at `maxTurns - 1` steer "budget notice: wrap up
   now"; at cap, abort with graceful finalization (opencode's forced text-only final step
   approximated via steer + abort-after-response).
5. **Registry bridge** (~30 LoC): `registry.register({kind: "subagent", label, ...})`;
   subscribe child events → `appendLog` (tool titles + text deltas, one line each),
   `setStatus`; stash `tokens/costUsd/requests/contextPct` from `getSessionStats()` when
   available.
6. **Finalize**: `getLastAssistantText()`; empty → `"(Subagent completed but returned no
   output.)"` (Claude Code); structured output: if `output` schema, register a hidden
   `finish` tool (omp yield, simplified: single terminal call, 3 validation retries then
   accept-with-flag); `capReturn` → inline + handle; usage trailer appended to inline:
   `agentId: <id> — <tokens> tok · $<cost> · <n> tools · <t>s`.
7. **Failure**: child throw/abort → status failed/cancelled, partial last-text still
   extracted (Claude Code's extractPartialResult).

Tests (faux provider): sync spawn happy path; depth cap; spawns allowlist; semaphore blocks
9th concurrent; result cap + handle; empty-output placeholder; turn cap steer; abort
propagation; cost/usage accounting; child session file has parentSession header; permission
prompt-text/fail-closed behavior; isolation-required gate for parallel shared-state mutation.

### 1.5 `core/tools/agent.ts` (~300 LoC) + `agent_pull` + `agent_list`

Status: ✅ `agent`, `agent_list`, and `agent_pull` implemented and default-active with
allowlist/denylist filtering.

- Schema per design doc (single shape, `tasks` array, all optionals).
- `execute`: resolve definitions; sync tasks → `Promise.all(spawnAgent…)` bounded by
  semaphore; background tasks → fire, return normal task details with inline
  `Background agent launched: <registryId>` text. Mixed batches allowed.
- Background completion injection: on child completion, `pi` injects a visible
  `<task-notification>` block (task id, status, inline result, handle) and starts a parent turn
  immediately, or queues it as a follow-up when the parent is already streaming.
  Include "do not poll; do not duplicate the agent's work" guidance.
- **Dynamic discovery**: the `agent` tool description includes only the spawnable bundled
  agents plus up to `agents.maxInlineDefinitions` project/user agents (default 12). Larger
  registries expose `agent_list { q?, limit? }` so the model can search without mutating the
  tool schema. File-watcher deltas land in Phase 2 as system-reminder messages, never schema
  mutation.
- `renderCall/renderResult`: compact card — `agent reviewer (fix auth bug) · running ▸ last
  tool` reusing Text; the full live card component comes in Phase 2 with the Hub.
- Registration: one entry each in `core/tools/index.ts` (like update_plan), category `coord`
  in tool-categories.ts. **Default-active**: yes for `agent`, `agent_pull`, and
  `agent_list` (they're the feature; opt out via /tools).
- Prompt text: port Claude Code's briefing guidance + omp's format contracts (Goal /
  Constraints / Contract for `context`; Target / Change / Acceptance encouraged per prompt).
- Tests: schema strict-mode shape; parallel fan-out; background launch + notification
  injection; inline description cap; `agent_list` search; agent_pull round-trip.

### 1.6 Registry control-plane extensions (upstream-file edit, ~40 LoC additive)

Status: ✅ implemented.

`background-process-registry.ts`:
- Entry gains optional `metrics?: { tokens?, costUsd?, requests?, contextPct? }`,
  `agentType?`, `sessionFile?`, `resultHandle?`, `parentId?`; new optional callbacks on
  register: `onKill?: () => void`, `onSteer?: (text: string) => void`.
- Registry methods `kill(id)`, `steer(id, text)` (no-ops without callbacks); statuses gain
  `"idle"` (Phase 2 uses it; harmless now).
- BackgroundLogPanel: show metrics line when present; `x` key → `kill(id)` (guard: only when
  onKill exists). BackgroundStatusWidget renders the below-editor running-task summary and
  sanitized log preview.
- Tests: kill/steer plumbing, metrics snapshot rendering (headless render probe).

### 1.7 Settings additions (settings-manager.ts, additive block)

Status: ✅ implemented as an additive `agents` settings block with getters.

```ts
agents?: {
  maxDepth?: number;            // 2
  maxConcurrency?: number;      // 8
  maxCostUsd?: number;          // per spawn-tree budget; undefined = off (opencode gap)
  persistSessions?: "always" | "background" | "never";
  roles?: Record<string, string[]>;
  modelOverrides?: Record<string, string>;
  disabled?: string[];          // agent types hidden from spawning
  allowSharedWorkspaceWrites?: boolean;
  allowOmitProjectContext?: boolean;
  maxInlineDefinitions?: number; // 12
}
```
Getters only where consumed; no settings-selector UI in Phase 1 (Phase 2 polish).

**Phase 1 exit**: spawn `explore` + `worker` from a real session against faux provider tests;
manual smoke: `pi` → ask it to "use the agent tool to explore the project/docs in two
parallel agents" → watch the below-prompt widget + log panel light up; attempt two parallel
shared-state mutations without isolation and verify the gate; verify permission-mode prompt
text/tool exposure until the Phase 2 approval bridge exists. Commit series (~6 commits),
push.

---

## Phase 2 — Lifecycle, A2A, Agent Hub, background polish

Status (2026-07-08):
- ✅ 2.1 Lifecycle: `core/agents/lifecycle.ts` — running → idle → parked (TTL,
  `agents.idleTtlMs`) → revived; revive factories reopen the child session file
  (`resumeSessionFile` on the child-session factory contract); file-less
  one-shots dispose at park time; kill releases; `disposeAllAgents()` sweeps on
  interactive shutdown. Registry gained the `parked` status.
- ✅ 2.2 A2A: `agent_message` tool (default-active; auto-injected into children
  with parent identity). Delivery matrix: running → followUp queue, idle → wake
  with a real turn (reply returned when `wait`), parked → revive-then-deliver;
  per-delivery 20-turn budget. Child→parent messages arrive as `agent-message`
  custom messages (rendered as accent cards by the agent-notify extension).
  Sessions are the mailboxes — no droppable buffer exists.
- ✅ 2.3 Agent Hub: shipped as `extensions/agent-hub.ts` (roster, kill,
  steer/message with lifecycle-aware delivery, `r` revive) instead of a core
  component — extension-first supersedes the original plan here.
- ⬜ 2.4 remaining: cold-revival scan of parked children on session start,
  definitions file-watcher with cache-stable re-announce, fg→bg promotion key.

### 2.1 `core/agents/lifecycle.ts` (~200 LoC)
- Completed non-isolated agents → status `idle`, session kept, TTL timer
  (`agents.idleTtlMs`, default 420_000). TTL → `parked`: `session.dispose()`, keep
  sessionFile + registry entry (adds `parked` status). `revive(id)`: reopen via
  `createAgentSession` + `SessionManager.open(sessionFile)`, replay identity (name, type,
  depth), status back to idle.
- Cold revival: on session start, scan agentDir sessions with `parentSession == current
  lineage` (children enumeration gap — do a header scan via `SessionManager.list`, cache it)
  and register parked entries.
- Kill-all sweep on parent shutdown (`session_shutdown`).

### 2.2 `core/agents/messaging.ts` (~250 LoC)
- In-process bus keyed by registry id: `send/wait/inbox/list`; delivery per design doc
  (running → aside at step boundary via a `steer` variant that does not interrupt tool
  execution — use `AgentSession.followUp()` semantics; idle → `prompt()`; parked →
  revive-then-deliver). Receipts; bounded mailbox with overflow NOTICE line.
- `agent_message` tool auto-added to children with peers and to the parent; roster section
  rendered into child system prompts at spawn (static) + updated via system-reminder on
  change.
- Deadlock escape: `await: true` with recipient unable to reach a boundary → timeout reply
  with status explanation (omp's side-channel auto-reply simplified to a timeout).

### 2.3 `components/agent-hub.ts` (~350 LoC)
- Grows from BackgroundLogPanel patterns: roster view (glyph, type pill color, name, task,
  metrics, unread count) → detail view (transcript tail rendered from sessionFile, steer
  input line, `x` kill, `r` revive). Open via the existing down-arrow seam (panel shows
  agents first) + `/agents` command.
- ChainCard-style live tool line per running agent (`↳ grep "auth" …`) fed by the registry
  log.

### 2.4 Background UX
- Foreground→background promotion keybinding (`app.agent.background`, ctrl+b if free) —
  spawnAgent already returns a controllable iterator-equivalent (subscription), promotion =
  stop streaming into parent turn, register async completion injection.
- Definitions file-watcher; changes re-announce via system-reminder (cache-stable).
- Permission prompt polish in the Hub: entries needing approval show `blocked: approval`,
  focus the parent prompt, and resume/fail the child when the approval resolves. This is the
  full child approval bridge deferred from Phase 1.

**Exit**: message a parked agent and watch it revive in the Hub; kill from Hub; promotion
works; permission prompts are visible from the Hub; tests for TTL park/revive, delivery
matrix (running/idle/parked), mailbox overflow.

---

## Phase 3 — Chains

Status (2026-07-09): ✅ shipped.
- `core/agents/chains.ts`: YAML loader (project `.pi/chains/` → user
  `~/.pi/agent/chains/`), validation with helpful errors (dupes, unknown
  needs, cycles), wave-parallel DAG runner, `{{input}}`/`{{stage.result}}`/
  `{{stage.handle}}` interpolation with the 2k inline cap, per-stage
  `on_fail: stop|continue`.
- Verify gates reuse Phase 2 instead of respawning: a failing `verify`
  command's output is DELIVERED to the stage's still-idle agent via the
  lifecycle, and the fix is re-verified (`max_iters`).
- `chain` tool (default-active) with a live stage-flow card
  (`[plan ✓] → [build ▶] → [review ○]`); `/chain` command extension lists
  and launches chains; demo chain in `.pi/chains/demo.yaml`.
- Verified live: two-stage demo chain against a real model, findings
  interpolated across stages. 8 suite tests incl. the verify-feedback loop.
- Deviation from the original sketch: `goto:<stage>` on_fail dropped (kept
  stop/continue), ChainCard lives with the tool (core) not a separate
  component file.
- 2026-07-09 upgrades: judge gates (`judge:` — fresh-eyes read-only agent,
  VERDICT: PASS|FAIL, shares the verify retry loop), named inputs
  (`inputs:` + JSON-object input, defaults, missing-input errors),
  `foreach` fan-out stages (JSON array or line list, `max_items`,
  progress in the card), chain resume (per-stage persistence under
  `<agentDir>/chain-runs/`, `resume: true` seeds completed stages), and
  cost tracking (per-stage + Σ totals row, `budget_usd` ceiling that
  fails stages before spawning).

### 3.1 `core/agents/chains.ts` (~350 LoC)
- YAML loader (`.pi/chains/*.yaml` + `~/.pi/agent/chains/`), schema validation with
  helpful errors (stage id dupes, unknown agent, cycle detection on `parallel_with`/deps).
- Runner: topological stages; each stage = spawnAgent with interpolated prompt
  (`{{stage.result}}` inline if < 2k chars else auto-`{{stage.handle}}` + note); verify
  ladder per stage: shell command (cwd-scoped, timeout) → on fail, feed stderr back and
  retry ≤ `max_iters` (default 2) → optional `judge: true` adversarial gate via a hidden
  `judge` agent on produced artifacts or diffs (git diff for coding workflows; port
  delegate.ts drive()).
- Chain run registers ONE parent registry entry + child entries; failure policy per stage:
  `on_fail: stop | continue | goto:<stage>`. Verify gates are domain-specific: shell commands
  are the coding/default-local option, but stages can also use structured checks supplied by
  tools, MCP servers, or package-provided validators.

### 3.2 `components/chain-card.ts` (~200 LoC)
- Boxed stage flow: `[plan ✓] → [build ▶ 2m: npm run check] → [review ○]`, width-aware,
  themed; renders under the parent's tool card and in the Hub.

### 3.3 `/chain` command + `agent` tool `chain` param? No — separate `chain` tool
(`{ name, input }`), keeps `agent` schema stable. Category coord, default-active.

**Exit**: `feature-flow` example chain in docs; suite test with faux provider driving a
3-stage chain incl. verify-retry; TUI probe rendering; chain stages inherit the same
permission/isolation gates as direct agent spawns.

---

## Phase 4 — Teams, side-requests, memory, fork spawns

Status (2026-07-09): ✅ shipped (fork spawns intentionally deferred).
- Cold revival: `<agentDir>/agent-index.json` persists adopted agents
  (tools/spawns/model/thinkingLevel); `registerColdAgents` re-registers a
  session's parked children on start/resume/switch with real kill/steer
  callbacks. Verified live across a pi restart (secret-word recall).
- `session.sideRequest(prompt)` — aux completion over the (tail-capped)
  serialized conversation; never touches the transcript.
- Per-agent-type memory: `.pi/agent-memory/<type>/MEMORY.md` (project) /
  `<agentDir>/agent-memory/<type>/` (user), fenced as untrusted data,
  front-truncated at 8k; write-back instruction when the agent has
  write/edit (suppressed for worktree agents).
- Worktree isolation: `isolation: worktree` spawns work in a disposable
  `git worktree` (branch pi-agent/<id8>); auto-removed when unchanged,
  kept + surfaced (result, registry summary) when changed. Worktree
  agents are never adopted; leak-safe on factory failure.
- Team presets: `.pi/teams/*.yaml` (+ user dir) — per-type model
  overrides, role chains, disabled types, coordinatorNote; `/team`
  extension applies/clears; routing merged in model-roles + spawn gate.
- UX pass: chain card spinner/pulse/truncation-hint, shared elapsed
  formatting, glyph/color consistency, dormant-agents footer hint,
  actionable error messages, hub grouping (⛓ chain headers), /chain new
  scaffolding, definitions file-watcher (agent-watch extension).
- Correctness pass (14 findings fixed): revive memoization + kill-during-
  revive teardown, delivery finally liveness checks, lifecycle-owned
  message queue with drain-on-idle (no droppable followUp queue), worktree
  cleanup on factory failure, killed agents removed from the cold index,
  ephemeral judge/foreach spawns (no idle pile-up, no index pollution),
  chains usable from subagents (spawns forwarded), gate-retry cost counted
  against budgets, memory prompt-injection fencing, sideRequest tail cap.

- `core/agents/teams.ts`: team preset loader (`.pi/teams/*.yaml`), `/team <name>` applies
  modelOverrides/disabled/roles + coordinator system-prompt snippet; footer badge.
- **`session.sideRequest()` seam** (upstream AgentSession, hook-sized optional method):
  aux completion on current context, never persisted — unlocks 30s activity summaries on
  Hub cards, chain judges without transcript pollution, `/handoff` in core.
- Per-agent-type memory dirs (`~/.pi/agent/agent-memory/<type>/MEMORY.md`) injected into
  that type's system prompt; write-tool allowlisted to its own dir (Claude Code).
- Fork spawns (`agent` tool `fork: true`): parent-context inheritance with placeholder
  tool-results for cache-shared prefixes. Gate behind `agents.experimental.fork`.
- Worktree isolation polish: cleanup-if-unchanged, notice injection about stale paths, and
  patch-apply merge helpers (omp's default; skip branch mode).
- Child-extension opt-in; richer permission rulesets exploration (opencode model) —
  separate design note before building.

---

## Phase 5 — User docs and publish polish

- Create a concise user-facing `subagents.md` that covers: what subagents inherit, what they
  do not inherit, foreground vs background, permission prompts, isolation, result handles,
  `agent_pull`, and common agent-definition examples across coding, docs/research, data/ops,
  and other tool-backed workflows.
- Add the user doc to `docs.json`. Keep `subagent-design.md`, `subagent-plan.md`, and
  research notes development-only unless explicitly publishing the design history.
- Add a short migration note for extension authors currently using `delegate.ts` or the
  example `subagent/` extension: which APIs are replaced by core agents, and which remain
  extension-only.
- Exit: docs nav includes the user-facing page, docs build/link check passes if available,
  and the published page avoids leaking internal research claims as product guarantees.

---

## Test & verification strategy (every phase)

1. Suite tests (faux provider) as listed per phase — no real keys, CI-safe.
2. Headless runtime probes (scratchpad scripts) for TUI components (render width, ANSI
   safety) — same method used for BackgroundStatusWidget/ChatSearch.
3. One end-to-end manual smoke per phase with a real cheap model (user-run,
   documented in the phase's commit message).
4. `npm run check` + `./test.sh` green before every commit (pre-commit hook enforces).
5. `/code-review high` over the working diff at each phase end; fix before commit.

## Risks

| Risk | Mitigation |
|---|---|
| Concurrent in-process sessions break on a hidden global | Phase 0 spike; children load no extensions; fallback = RpcClient subprocess driver (audit found it ready-made) behind the same SpawnDeps interface |
| Spawn latency (session construction cost) | measure in Phase 0; inMemory sessions for sync one-shots; lazy tool creation |
| Registry/UI churn on many agents | metrics coalescing (150ms, omp), log ring buffers already bounded |
| Upstream drift on seamed files | seams are optional/undefined-safe; sync weekly per Fork Maintenance |
| Cost runaway from recursive fan-out | depth 2 default and semaphore today; `agents.maxCostUsd` tree-budget enforcement remains follow-up work |
| Strict-mode providers reject schemas | phase-1 shape test; no top-level unions; optional-only extensions |
| Child bypasses parent permission expectations | Phase 1 tool exposure constraints plus prompt instructions; Phase 2 approval bridge; fail-closed gates for unsafe parallel mutation |
| Parallel agents overwrite shared state | Phase 1 isolation gate for shared-state mutation; shared-workspace writes require explicit opt-in |
| Agent registry bloats prompt cache | Inline roster cap plus `agent_list`; file changes announced as system-reminder deltas, never schema mutation |
| `omitProjectContext` skips repo rules | Bundled read-only default only; user/project use requires explicit setting |

## Sequencing summary

Phase 0 (½ d) → Phase 1 (core value: parallel research/implement agents with clean context) →
Phase 2 (the "alive" feel: revive, message, Hub) → Phase 3 (chains = your orchestration ask) →
Phase 4 (teams/memory/fork = differentiation) → Phase 5 (publishable docs). Each phase is a
PR-sized commit series on main, pushed after green checks.
