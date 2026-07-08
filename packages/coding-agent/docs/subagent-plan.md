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
- **Strict-mode-safe schemas from day one** (omp pitfall #7): no top-level unions in tool
  params; optional fields via `Type.Optional`; test against the faux provider AND one
  strict-mode shape check.
- **Tests**: every phase adds suite tests under `packages/coding-agent/test/suite/agents/`
  using `test/suite/harness.ts` + faux provider (no real APIs). Regression tests for every
  pitfall in the design doc's ledger.

---

## Phase 0 — Concurrency spike (½ day, de-risks everything)

The audit found no proof two `AgentSession`s ever ran concurrently in one process.

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
invalidation interplay). Extension support for children is a Phase 4 opt-in
(`agents.childExtensions: true`).

---

## Phase 1 — Foundation: definitions, spawn, tool, handles (the big one)

### 1.1 `core/agents/definitions.ts` (~250 LoC)

```ts
export interface AgentDefinition {
  name: string;                    // lookup is case-INSENSITIVE, stored lowercase
  description: string;             // routing text; required
  systemPrompt: string;            // markdown body
  tools?: string[];                // allowlist; undefined = defaults; '*' = all
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
- Bundled agents: `explore.md`, `plan.md`, `worker.md`, `reviewer.md` (contents adapted from
  Claude Code's Explore read-only prompt + omp's format contracts).
- Tests: precedence override, case-insensitive lookup (`Reviewer` == `reviewer`), lenient
  parse (unknown keys, invalid YAML → skip w/ warning), tools CSV and array forms, output
  schema passthrough.

### 1.2 `core/agents/model-roles.ts` (~80 LoC)

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

```ts
export interface AgentArtifact { id: string; path: string; bytes: number }
export function capReturn(id: string, text: string, capChars?: number):
  { inline: string; handle?: string }   // handle = "agent://<id>"
export function pullHandle(ref: string): string  // agent://<id>[/json.path | ?q=/regex/]
```
- Artifacts dir: `<agentDir>/artifacts/<sessionId>/<id>.md` (bounded: delete-on-park option
  later). JSON-path pull when the artifact parses as JSON (structured output case); regex
  windowed slice otherwise (port delegate.ts `pullHandle`, it's proven).
- Also register `agent://` in whatever pi uses to resolve `@`-mention-like refs later — NOT
  in phase 1; the `agent` tool gets a `pull` action instead? No — keep one tool; pull is a
  tiny separate read-only tool `agent_pull { ref }` (always available to agents' parents).
- Tests: cap boundary, JSON path pull, regex pull, missing handle error text.

### 1.4 `core/agents/spawn.ts` (~400 LoC) — the heart

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
2. **Child session**: `createAgentSession({ cwd, agentDir, authStorage: parentAuth,
   modelRegistry: parentRegistry, model: resolved, thinkingLevel, tools: definition.tools,
   customTools: [], noTools: undefined, settingsManager: snapshot, sessionManager, ... })`.
   - `sessionManager`: `SessionManager.create(cwd, agentDir, { parentSession: parentFile })`
     for named/background agents; `inMemory()` for one-shot sync workers (setting
     `agents.persistSessions: "always" | "background" | "never"`, default `background`).
   - Settings snapshot: clone parent SettingsManager view with compaction on, retry on,
     **no extensions**, tool approval = auto (children are unattended; the parent's
     permission story guards the blast radius via tool allowlists in phase 1; permission
     rulesets are Phase 4).
   - System prompt: definition body + `## CONTEXT` (the shared `context` field) +
     `## OUTPUT CONTRACT` (if `output` schema — "call the `finish` tool"). If
     `omitProjectContext`, pass the option that suppresses AGENTS.md/context files (check
     `sessionStartEvent`/resourceLoader path; if no such option exists upstream, add ONE
     optional flag `omitProjectContext?: boolean` to CreateAgentSessionOptions — hook-sized
     seam, undefined-safe).
3. **Turn cap**: subscribe to `turn_end`; at `maxTurns - 1` steer "budget notice: wrap up
   now"; at cap, abort with graceful finalization (opencode's forced text-only final step
   approximated via steer + abort-after-response).
4. **Registry bridge** (~30 LoC): `registry.register({kind: "subagent", label, ...})`;
   subscribe child events → `appendLog` (tool titles + text deltas, one line each),
   `setStatus`; stash `tokens/costUsd/requests/contextPct` from `getSessionStats()` on each
   `agent_end` (needs registry field additions, §1.6).
5. **Finalize**: `getLastAssistantText()`; empty → `"(Subagent completed but returned no
   output.)"` (Claude Code); structured output: if `output` schema, register a hidden
   `finish` tool (omp yield, simplified: single terminal call, 3 validation retries then
   accept-with-flag); `capReturn` → inline + handle; usage trailer appended to inline:
   `agentId: <id> — <tokens> tok · $<cost> · <n> tools · <t>s`.
6. **Failure**: child throw/abort → status failed/cancelled, partial last-text still
   extracted (Claude Code's extractPartialResult).

Tests (faux provider): sync spawn happy path; depth cap; spawns allowlist; semaphore blocks
9th concurrent; result cap + handle; empty-output placeholder; turn cap steer; abort
propagation; cost/usage accounting; child session file has parentSession header.

### 1.5 `core/tools/agent.ts` (~250 LoC) + `agent_pull`

- Schema per design doc (single shape, `tasks` array, all optionals).
- `execute`: resolve definitions; sync tasks → `Promise.all(spawnAgent…)` bounded by
  semaphore; background tasks → fire, return
  `{status:"async_launched", registryId, note}` per task. Mixed batches allowed.
- Background completion injection: on child completion, `pi`-side bridge uses the session's
  `sendUserMessage`-equivalent internal API to inject a `<task-notification>` block
  (task id, status, inline result, handle) as a next-turn message. Phase 1 delivers this via
  the extension-API-equivalent core path (`AgentSession.sendUserMessage` exists per audit).
  Include "do not poll; do not duplicate the agent's work" guidance.
- **Dynamic description**: build from spawnable definitions at tool-creation time; when the
  definitions registry changes (file watcher NOT in phase 1 — only session start), it's
  static per session. Re-announce-on-change lands with the watcher in Phase 2 (as a
  system-reminder message, never schema mutation).
- `renderCall/renderResult`: compact card — `agent reviewer (fix auth bug) · running ▸ last
  tool` reusing Text; the full live card component comes in Phase 2 with the Hub.
- Registration: one entry each in `core/tools/index.ts` (like update_plan), category `coord`
  in tool-categories.ts. **Default-active**: yes for `agent`, yes for `agent_pull`
  (they're the feature; opt out via /tools).
- Prompt text: port Claude Code's briefing guidance + omp's format contracts (Goal /
  Constraints / Contract for `context`; Target / Change / Acceptance encouraged per prompt).
- Tests: schema strict-mode shape; parallel fan-out; background launch + notification
  injection; dynamic description lists only spawnable types; agent_pull round-trip.

### 1.6 Registry control-plane extensions (upstream-file edit, ~40 LoC additive)

`background-process-registry.ts`:
- Entry gains optional `metrics?: { tokens?, costUsd?, requests?, contextPct? }`,
  `agentType?`, `sessionFile?`, `resultHandle?`, `parentId?`; new optional callbacks on
  register: `onKill?: () => void`, `onSteer?: (text: string) => void`.
- Registry methods `kill(id)`, `steer(id, text)` (no-ops without callbacks); statuses gain
  `"idle"` (Phase 2 uses it; harmless now).
- BackgroundLogPanel: show metrics line when present; `x` key → `kill(id)` (guard: only when
  onKill exists). BackgroundStatusWidget unchanged (already renders labels/age/tail).
- Tests: kill/steer plumbing, metrics snapshot rendering (headless render probe).

### 1.7 Settings additions (settings-manager.ts, additive block)

```ts
agents?: {
  maxDepth?: number;            // 2
  maxConcurrency?: number;      // 8
  maxCostUsd?: number;          // per spawn-tree budget; undefined = off (opencode gap)
  persistSessions?: "always" | "background" | "never";
  roles?: Record<string, string[]>;
  modelOverrides?: Record<string, string>;
  disabled?: string[];          // agent types hidden from spawning
}
```
Getters only where consumed; no settings-selector UI in Phase 1 (Phase 2 polish).

**Phase 1 exit**: spawn `explore` + `worker` from a real session against faux provider tests;
manual smoke: `pi` → ask it to "use the agent tool to explore src/ in two parallel agents" →
watch the below-prompt widget + log panel light up. Commit series (~6 commits), push.

---

## Phase 2 — Lifecycle, A2A, Agent Hub, background polish

### 2.1 `core/agents/lifecycle.ts` (~200 LoC)
- Completed non-isolated agents → status `idle`, session kept, TTL timer
  (`agents.idleTtlMs`, default 420_000). TTL → `parked`: `session.dispose()`, keep
  sessionFile + registry entry (status parked). `revive(id)`: reopen via
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

**Exit**: message a parked agent and watch it revive in the Hub; kill from Hub; promotion
works; tests for TTL park/revive, delivery matrix (running/idle/parked), mailbox overflow.

---

## Phase 3 — Chains

### 3.1 `core/agents/chains.ts` (~350 LoC)
- YAML loader (`.pi/chains/*.yaml` + `~/.pi/agent/chains/`), schema validation with
  helpful errors (stage id dupes, unknown agent, cycle detection on `parallel_with`/deps).
- Runner: topological stages; each stage = spawnAgent with interpolated prompt
  (`{{stage.result}}` inline if < 2k chars else auto-`{{stage.handle}}` + note); verify
  ladder per stage: shell command (cwd-scoped, timeout) → on fail, feed stderr back and
  retry ≤ `max_iters` (default 2) → optional `judge: true` adversarial gate via a hidden
  `judge` agent on the git diff (port delegate.ts drive()).
- Chain run registers ONE parent registry entry + child entries; failure policy per stage:
  `on_fail: stop | continue | goto:<stage>`.

### 3.2 `components/chain-card.ts` (~200 LoC)
- Boxed stage flow: `[plan ✓] → [build ▶ 2m: npm run check] → [review ○]`, width-aware,
  themed; renders under the parent's tool card and in the Hub.

### 3.3 `/chain` command + `agent` tool `chain` param? No — separate `chain` tool
(`{ name, input }`), keeps `agent` schema stable. Category coord, default-active.

**Exit**: `feature-flow` example chain in docs; suite test with faux provider driving a
3-stage chain incl. verify-retry; TUI probe rendering.

---

## Phase 4 — Teams, side-requests, memory, fork spawns

- `core/agents/teams.ts`: team preset loader (`.pi/teams/*.yaml`), `/team <name>` applies
  modelOverrides/disabled/roles + coordinator system-prompt snippet; footer badge.
- **`session.sideRequest()` seam** (upstream AgentSession, hook-sized optional method):
  aux completion on current context, never persisted — unlocks 30s activity summaries on
  Hub cards, chain judges without transcript pollution, `/handoff` in core.
- Per-agent-type memory dirs (`~/.pi/agent/agent-memory/<type>/MEMORY.md`) injected into
  that type's system prompt; write-tool allowlisted to its own dir (Claude Code).
- Fork spawns (`agent` tool `fork: true`): parent-context inheritance with placeholder
  tool-results for cache-shared prefixes. Gate behind `agents.experimental.fork`.
- Worktree isolation for `isolation: "worktree"` (create/cleanup-if-unchanged, notice
  injection about stale paths); merge = patch apply (omp's default; skip branch mode).
- Child-extension opt-in; permission rulesets exploration (opencode model) — separate
  design note before building.

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
| Cost runaway from recursive fan-out | depth 2 default, semaphore, `agents.maxCostUsd` tree budget enforced in spawnAgent |
| Strict-mode providers reject schemas | phase-1 shape test; no top-level unions; optional-only extensions |

## Sequencing summary

Phase 0 (½ d) → Phase 1 (core value: parallel research/implement agents with clean context) →
Phase 2 (the "alive" feel: revive, message, Hub) → Phase 3 (chains = your orchestration ask) →
Phase 4 (teams/memory/fork = differentiation). Each phase is a PR-sized commit series on main,
pushed after green checks.
