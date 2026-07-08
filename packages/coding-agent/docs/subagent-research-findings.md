# Subagent Research Findings — Consolidated Reference

Full findings from four parallel deep-dives (2026-07-08). This is the durable record; the
distilled decisions live in `subagent-design.md`, the build order in `subagent-plan.md`.
Sources: Claude Code TS source (`~/claude/claude-code`), opencode (`~/opencode/opencode`),
oh-my-pi (`~/omp/oh-my-pi`), and this repo's own primitives + pi-harness prototypes.

---

## 1. Claude Code

### Agent definitions
- Merge precedence (later wins, by agentType): built-in → plugin → user `~/.claude/agents/*.md`
  → project `.claude/agents/*.md` (every `.claude/agents/` walking cwd up to git root) →
  CLI-flag JSON → managed policy. Enterprise can restrict to plugin-only.
- Frontmatter keys: `name` (required), `description` (required — the routing text),
  `tools` (list/CSV/`'*'`), `disallowedTools`, `model` (`sonnet|opus|haiku`|full id|`inherit`,
  default inherit), `effort` (low/medium/high or int buckets), `permissionMode` (incl.
  `bubble` = prompts bubble to parent terminal), `maxTurns`, `background`, `isolation`
  (`worktree`; `remote` internal), `memory` (`user|project|local` — auto-injects
  Read/Write/Edit), `skills` (preloaded at spawn), `initialPrompt`, `mcpServers`
  (agent-scoped, started at spawn, cleaned in finally), `hooks` (Stop auto-converts to
  SubagentStop), `color` (8 values). Body = system prompt. Files without `name` silently
  skipped (allows co-located docs).
- Built-ins: general-purpose (`tools:'*'`), Explore (read-only via disallowedTools, haiku,
  hard READ-ONLY prompt block, callers pass thoroughness "quick/medium/very thorough"),
  Plan, statusline-setup, claude-code-guide.
- **Token diets**: `omitClaudeMd: true` on Explore/Plan ("saves ~5-15 Gtok/week across 34M+
  Explore spawns"); gitStatus stripped; one-shot builtins skip the agentId/usage trailer
  (~135 chars × 34M runs/week).

### Spawn mechanics (Agent tool, alias Task)
- Params: `description` (3-5 words), `prompt`, `subagent_type?`, `model?`,
  `run_in_background?`, `name?` (SendMessage addressing / teammate spawn), `team_name?`,
  `mode?`, `isolation?`, `cwd?`. Disabled params are `.omit()`ed from the schema so the
  model never sees them. `maxResultSizeChars: 100_000`.
- Model resolution precedence: `CLAUDE_CODE_SUBAGENT_MODEL` env → tool `model` param (alias
  matching parent tier reuses parent's EXACT model — cache parity) → agent-def model →
  inherit. Effort: agent-def overrides session.
- Sync: streams in parent turn; 2s → background hint; **Ctrl+B backgrounds mid-flight**
  (Promise.race over iterator; iterator re-driven as async task); optional auto-background
  at 120s. Result = last assistant text blocks only + trailer
  (`agentId … <usage>total_tokens/tool_uses/duration_ms</usage>`). Empty →
  `'(Subagent completed but returned no output.)'`.
- Background: registry-tracked, deliberately NOT tied to parent abortController (survives
  ESC; kill via ctrl+x ctrl+k double-press), transcript to
  `<tmp>/<sessionId>/tasks/<id>.output` (5GB cap, 8MB tail reads). Completion =
  `<task-notification>` user-role XML message. Killed agents still deliver
  extractPartialResult.
- Resume: `SendMessage({to})` routing: running → queue for next tool round; stopped →
  auto-resume from disk transcript (filters unresolved tool_uses/orphaned thinking, restores
  worktree cwd); evicted → resume from disk. Stopped-then-continued is first-class.
- Worktree isolation: `createAgentWorktree('agent-<id8>')`; unchanged → auto-removed;
  changed → kept, `worktreePath/worktreeBranch` in result. Fork+worktree children get a
  stale-paths notice.

### Fork subagents (standout)
- Omitting `subagent_type` forks the parent: full conversation, **byte-identical rendered
  system prompt** (cached string, never re-rendered — config drift would bust cache), exact
  tool array, thinking config, model. `permissionMode:'bubble'`, maxTurns 200.
- **All pending tool_uses get an identical placeholder result** ("Fork started — processing
  in background") so sibling forks share an API cache prefix; only the final directive text
  differs. Directive boilerplate: "forked worker… do NOT spawn sub-agents… commit before
  reporting… report under 500 words… begin with 'Scope:'" + fixed output format.
- Recursive-fork guard via querySource tag (survives autocompact) + boilerplate scan
  fallback. Fork mode makes ALL spawns async for a unified notification model. Guidance:
  fork when intermediate tool output isn't worth keeping; don't set model on a fork; "Don't
  peek" (never read output file mid-flight); "Don't race" (never predict results).

### Context management
- Fresh child context (clone readFileState, fresh agentId, +1 depth); thinking disabled for
  regular subagents; cache-eviction hint fired at subagent end.
- **Agent-list cache lesson**: inline agent list in the tool description was ~10.2% of fleet
  cache_creation tokens (MCP connects mutate schema) → moved to `agent_listing_delta`
  system-reminder attachments with add/remove delta semantics, re-announced post-compaction.
- Compaction: auto at contextWindow−13K (warn −20K); 8-section structured summary with
  `<analysis>` scratchpad stripped; post-compact file restoration budgets (5 files / 50K
  tokens / 5K per file; 25K skills). **Microcompact**: API-native clear-tool-uses/thinking
  strategies, trigger 180K keep last 40K; time-based MC clears all but 5 tool results when
  session gap > 60min (cache already cold = rewriting free). querySource-aware cleanup so
  subagent compaction never resets main-thread state.
- **Background progress summaries**: every 30s a forked classifier over the child transcript
  produces a 3-5 word activity line, riding the child's own prompt cache (CacheSafeParams),
  denying tools via canUseTool instead of `tools:[]` (which would bust cache).
- Handoff safety classifier at handback (auto mode): prepends SECURITY WARNING to the result
  rather than blocking.
- **Agent memory**: `~/.claude/agent-memory/<type>/` (user), `.claude/agent-memory/<type>/`
  (project, VCS-shared), `agent-memory-local`; project snapshots seed/refresh local copies.

### Coordinator mode & teams
- Coordinator: main thread = pure orchestrator; workers get a restricted tool set + optional
  shared scratchpad dir. Prompt gems: phase table (Research∥ → Synthesis by coordinator →
  Implementation → Verification), read-only parallel / write-heavy serialized per file-set,
  **continue-vs-spawn table keyed on context overlap** (research touched edit files →
  continue; broad research/narrow impl → fresh; verification → fresh eyes; wrong approach →
  fresh to avoid anchoring), "never write 'based on your findings'", purpose statements
  calibrate depth, "prove the code works, don't confirm it exists".
- Teams (experimental, gated): `~/.claude/teams/{team}/config.json` + shared task list
  `~/.claude/tasks/{team}/` (per-task JSON, lockfile-guarded owner claim). Teammates =
  in-process (AsyncLocalStorage) or tmux/iTerm2 panes. **Durable file mailboxes** polled
  ~500ms between turns; messages arrive as conversation turns. Idle protocol: teammates
  auto-notify lead on idle with completed-task info; "idle is normal" drilled in prompt.
  Structured messages: shutdown_request/response, plan_approval_request/response. Flat
  roster (no teammate spawning teammates). Cross-session: `uds:` sockets / `bridge:` remote.
- UI: tree rows with colored agentType pills + live tool-use/token counts; footer pill
  ("3 local agents", team @name pills with idle dimming); detail dialog with activity feed,
  `x` stop; ctrl+b background; shift+↓ teammate tree.

### Not determined
No real user agent examples on this machine (`~/.claude` had no agents/ or teams/); live
GrowthBook gate values; internal-only paths (remote isolation, KAIROS).

---

## 2. opencode (sst/opencode)

### Agent model
- Runtime schema: `{name, description?, mode: "subagent"|"primary"|"all", native?, hidden?,
  topP?, temperature?, color?, permission: Ruleset, model?: {modelID, providerID}, variant?,
  prompt?, options (unknown-key catch-all), steps?}`.
- Markdown agents in `{agent,agents}/**/*.md` across config dirs (global
  `~/.config/opencode/`, every `.opencode/` cwd→worktree root, `OPENCODE_CONFIG_DIR`);
  inline JSON agents merge over markdown. **Lenient YAML parser** on purpose ("claude code
  allows invalid yaml"); unknown frontmatter keys → `options` (interop).
- **Permissions, not tool lists**: `{permission, pattern, action: allow|ask|deny}` rulesets;
  tool availability derived (fully-denied tools are hidden). Gems: `doom_loop: "ask"`
  (circuit breaker permission when last N tool calls are identical), `*.env` read → ask.
- Built-ins: build (primary default), plan (edit denied except `.opencode/plans/*.md`;
  `task:{general:"deny"}` so plan can't spawn the coder), general, explore (read-only,
  thoroughness levels), plus **hidden utility agents `compaction`/`title`/`summary`** —
  internal LLM jobs modeled as agents so users can override their model/prompt.
- AI-generated agents: `opencode agent create` → generateObject({identifier, whenToUse,
  systemPrompt}) with existing names forbidden.

### Task tool
- Params: `description`, `prompt`, `subagent_type`, `task_id?` (RESUME a previous child
  session), `command?`, `background?` (env-gated).
- **Child = full session** with `parentID`; `Session.children(parentID)` API; own
  cost/tokens/permissions. Title convention `"<desc> (@name subagent)"` (the TUI parses it).
- Permission inheritance: child gets parent session's **deny rules + external-directory
  rules only** (parent agent restrictions don't leak); `todowrite` and `task` denied for
  children unless explicitly granted (anti-recursion default).
- Model inheritance: agent-pinned model, else the exact model of the parent's current
  assistant message; variant passthrough only on inherited model.
- Child context: NOTHING from parent transcript; prompt template runs through
  resolvePromptParts (`@file` → file parts, `@agent` → agent parts).
- Result: last text part wrapped `<task id=… state=…><task_result>…</task_result></task>`;
  the child session id IS the documented task_id.
- Plumbing: tool receives `promptOps` injected via ctx.extra (avoids circular dep); every
  run registered in a **process-local, deliberately non-durable BackgroundJob registry**
  (Deferred-based: wait/promote/extend/cancel).
  - Foreground = race(wait, waitForPromotion): a running foreground task can be **promoted
    to background mid-flight** (TUI keybind) — tool returns "Background task started".
  - Background completion → `inject()` a synthetic user message into the parent (wakes it).
  - `extend`: task_id of a still-running job appends another prompt turn to the child.
- **Doom-loop breaker** (processor): identical tool+input N times → permission ask.
- **Steps cap**: at `agent.steps`, MAX_STEPS_PROMPT appended as assistant prefill forcing a
  text-only wrap-up.
- **Dynamic task description**: lists non-primary agents the CALLER may task; agents without
  descriptions listed as "should only be called manually by the user".

### Compaction (strongest file: session/compaction.ts)
- Trigger: tokens ≥ input_limit − reserved (reserved = min(20k, maxOutput), configurable).
- **Compaction is a message part** (synthetic user msg with CompactionPart) processed by the
  main loop via the hidden compaction agent → assistant message flagged `summary: true`;
  history filter hides pre-summary messages.
- Tail preservation: last `tail_turns` (2) verbatim within 2k-8k token budget, can split a
  turn; `tail_start_id` recorded. **Incremental**: prior summaries fed as previousSummary.
- **Pruning** (opt-in, cheaper): backwards walk stamping old tool outputs compacted;
  protects newest 40k of tool output + skill outputs; only acts if ≥20k reclaimable; runs
  after every loop exit.
- Overflow replay: giant-attachment user message held out, history compacted with media
  stripped (tool outputs clamped 2k), original message replayed post-summary.
- Auto-continue: post-auto-compaction synthetic "Continue if you have next steps…"
  (plugin-vetoable).

### Orchestration & UI
- No pipeline DSL. `SubtaskPart` user-message part → run loop converts to synthetic task
  call (how slash commands route to subagents, with pinned model). **`@agent` mention** →
  synthetic instruction + `bypassAgentCheck` for ONE turn (user invocation overrides deny).
- TUI (SolidJS): inline Task component live-renders the child's current tool via child
  session sync (`↳ Grep …`); click navigates into child session. Child view: subagent
  footer (name, "(2 of 3)" siblings, context%/cost, parent/prev/next nav; `up` = parent).
  **Permission/question requests from ALL child sessions bubble to the parent view.**
- No cross-session cost budget found (gap we fill with `agents.maxCostUsd`).

---

## 3. oh-my-pi (omp)

### Architecture
- Subagents = **in-process AgentSessions on the main thread** (names like `runSubprocess`
  are vestigial). Three process-global singletons: AgentRegistry, AgentLifecycleManager,
  IrcBus. **Keep-alive lifecycle: running → idle (TTL 420s default) → parked (session
  disposed, JSONL kept) → revived on message.** "Spawn once, converse forever."

### Agent definitions
- `AgentDefinition {name, description, systemPrompt, tools?, spawns?: string[]|"*",
  model?: string[], thinkingLevel?, output? (JTD schema), blocking?, autoloadSkills?,
  readSummarize?, source, filePath?}`.
- Discovery first-wins, **case-sensitive exact** (their `Tester` vs `tester` trap): project
  `.omp/agents` → user `~/.omp/agent/agents` → Claude-plugin agents dirs → bundled.
  `.claude/.codex/.gemini` dirs deliberately skipped (different contract).
- Bundled: explore (pi/smol, read-summarize off, structured output), plan (spawns explore),
  designer, reviewer (structured findings+verdict), librarian, Tester, task (spawns '*'),
  sonic (mechanical-updates-only twin of task).
- **Model roles**: `pi/<role>` aliases → `model-roles.ts` priority chains with cross-role
  alias recursion; settings `task.agentModelOverrides`, `task.disabledAgents`.

### task tool
- **Dual wire shapes** (batch default: `{agent, context (required), tasks:[{id?, description?,
  role?, assignment, isolated?}]}` vs flat), runtime permissive to both + a repair-args
  layer — their acknowledged complexity tax. `role` = per-spawn persona + display name,
  sanitized by `oneLineLabel` (strips control/ANSI/zero-width, 80-char code-point-safe cap)
  at every roster surface (anti prompt-injection/terminal-escape).
- Async by default (AsyncJobManager); results injected later as async-result messages with
  "now idle — message via irc; transcript at history://<id>". Sync when blocking.
- Concurrency: session Semaphore from `task.maxConcurrency` (32) — **sized once, never
  resized** (their bug). Depth: `task.maxRecursionDepth` 2; at cap, task tool stripped +
  spawns emptied; `PI_BLOCKED_AGENT` blocks self-recursion; eval bridge hard ceiling 3
  (min wins — users can't raise).
- Child session: isolated settings snapshot (async off, autoBackground off, approval yolo);
  tool assembly: agent.tools + auto task-if-spawns + irc always + yield auto; parent-owned
  todo stripped; plan-mode parents swap to a read-only effectiveAgent with spawns cleared.
- **Returns**: 5000-char inline preview; capture caps 500KB/5000 lines (env-tunable); full
  output at `<artifacts>/<id>.md` = `agent://<id>`; **selective pull**
  `agent://<id>/<json.path>` and `agent://<id>?q=<query>`; `history://<id>` renders the
  child JSONL as a concise transcript (live/idle/parked). Name-based unique ids
  (`Task`, `Task-2`, `Parent.Child`).
- **yield tool** (hidden, mandatory finish): `{type?: string|string[], result: {data}|{error}|{}}`;
  array type = incremental accumulating section; empty result+type = "use last turn as
  result". Schema validation MAX 3 retries then override-and-accept (`schemaOverridden`).
  Missing yield → 3 reminders, last forces toolChoice=yield, else SYSTEM WARNING result.
  Output-schema precedence: agent frontmatter → inherited parent session schema.
  `withSectionVariants` expands schema for strict-mode providers (bolted on late — pain).
- Budgets: softRequestBudget 90 (explore/sonic 40), maxRuntimeMs, budget-notice steering.
- Isolation: per-spawn `isolated` (requires git repo); native PAL backends
  (apfs/btrfs/zfs/reflink/overlayfs/...); merge patch (default) or branch cherry-pick;
  nested git repos handled; isolated agents torn down, not revivable.

### Chaining
- **No declarative chain construct.** Chaining is programmatic inside their `eval` tool:
  `agent(prompt, {agent, model, schema, isolated, handle})` returns DAG nodes
  (`handle: "agent://<id>"`), `parallel(thunks)`, `pipeline(items, ...stages)` with a pool
  live-tracking maxConcurrency. Artifacts: `local://` shared root, `agent://` handles,
  batch `context`. Verify loops composed, not first-class.

### A2A — irc
- Ops: send (to id|"all", replyTo, await sugar), wait (from?, timeout, 0=forever), inbox
  (peek), list (work-aware roster with unread/parent/activity gist).
- **Delivery: parked → revived; idle → woken with a real turn; busy → non-interrupting
  aside at next step boundary.** Receipts injected|woken|revived|failed. Delivered messages
  not double-buffered. MAILBOX_CAP 100, oldest silently dropped (their flaw).
- Deadlock escape: awaiting sender + recipient can't reach a boundary → ephemeral
  side-channel auto-reply.
- **Availability derived, not configured**: irc exists iff you have peers. Main id "Main".
  Child system prompt carries live peer roster + etiquette ("message the sibling who owns a
  file before editing it"). Advisor refs excluded from rosters.

### Context rot
- Blank-start children; carry-over = workspace tree/skills/context files, shared `local://`
  root, approved-plan verbatim injection ("NEVER re-read from path"), batch context as a
  CONTEXT prompt section.
- Blob/artifact architecture: OutputSink 50KB in-memory tail + `artifact://` file mirror;
  images to content-addressed `blob:sha256:` store (≥1KB).
- **Handoff pipeline**: cache-preserving side request — same transform pipeline +
  promptCacheKey as the live loop, handoff instruction as a trailing user message so the KV
  prefix stays aligned; unique side sessionId; result delivered as `<handoff-context>`
  custom message in the new session.
- Token display: lifetime billing vs current contextTokens split (cacheRead deliberately
  excluded from lifetime — misleading); progress coalesced 150ms; 8KB output tails.
- **Retry-state surfacing**: rate-limited child renders "blocked: rate-limited" instead of
  eternal in-progress (real operational pain solved).

### Orchestration & UI
- `task.eager: default|preferred|always` delegation aggressiveness. Tool prompt hard-pushes
  parallel fan-out ("NEVER serialize; agents resolve file collisions live"), per-spawn role
  specialization, **format contracts**: context = `# Goal / # Constraints / # Contract`;
  assignment = `# Target / # Change / # Acceptance`; "prefer messaging an existing agent
  over a fresh spawn". Teams emergent (registry+irc+lifecycle), no team object.
- Advisor/watchdog: passive second model reviewing transcript deltas, own read-only tools +
  advise injection; WATCHDOG.md roster.
- **Agent Hub**: one overlay — roster table (status glyph, unread, current task, age; r
  revive, x abort, Enter chat) + per-agent chat view (session-file tail + input; submit
  revives+steers). Task cards: live tool+args, output tail, context gauge, cost,
  resolved-model badge. Collab: E2E-encrypted session sharing exposes the Hub to guests.

### Their mistakes (pitfalls ledger)
1. Schema/prompt drift (id cap 48 vs prompt says 32; docs list nonexistent `oracle`).
2. Case-sensitive lookup + capitalized bundled `Tester`.
3. Dual wire shapes + repair layer.
4. Read-once config (semaphore sized once; stale blocking flag in async scheduling).
5. Vestigial naming after the subprocess→in-process pivot.
6. Process-global singletons (test resets bolted on; multi-session hosting complicated).
7. Strict-mode schema contortions bolted on late.
8. Silent drops (mailbox cap; empty handoff = "cancelled" not "failed").
9. Branch-merge stash/cherry-pick intricacy (patch default is sane).

---

## 4. pi (this repo) — primitives & prototypes

### Primitives
- **`createAgentSession(options)`** (core/sdk.ts): instance-scoped deps (AuthStorage,
  ModelRegistry, SettingsManager, SessionManager, ResourceLoader). Options include `cwd`,
  `agentDir`, `model`, `thinkingLevel`, `tools` (allowlist), `excludeTools`, `customTools`,
  `noTools`, `sessionManager`, `settingsManager`. Multiple sessions per process:
  structurally yes, **concurrency unverified** (Phase 0 spike). Per-session model cheap
  (auth resolved per request); `setModel()` live.
- **AgentSession** (3187 LoC): prompt/steer/followUp/sendUserMessage/abort;
  `subscribe(listener)` with full typed event stream (message_*, tool_execution_*,
  agent_end{willRetry}, compaction_*, queue_update) — everything delegate.ts hand-parses
  from JSONL exists in-process; compact(), getSessionStats() (tokens/cost),
  getContextUsage(), getLastAssistantText(), exportToJsonl(), dispose().
- **RPC**: `pi --mode rpc` stdin/stdout JSON; `modes/rpc/rpc-client.ts` (592 LoC) is a
  ready-made subprocess driver (fallback transport if in-process concurrency fails).
- **SessionManager**: JSONL v3, header `{id, timestamp, cwd, parentSession?}`; tree inside
  each file (branch/branchWithSummary/createBranchedSession); `forkFrom`; `inMemory()`.
  Gap: parentSession is one-way (children enumeration = header scan).
- **Extension API**: registerTool (with renderCall/renderResult/onUpdate — an agent tool
  can render its own live card), registerBackgroundTask (handle: log/setStatus/unregister;
  auto-cancel on runtime invalidation), events (context transform, before_agent_start,
  tool_call block/mutate, session_before_compact full override), sendMessage
  (deliverAs steer/followUp/nextTurn), newSession/fork/switchSession on command ctx,
  ctx.ui (setWidget/custom overlays/confirm). Loader gotcha: per-extension jiti graphs
  (moduleCache:false) — core placement avoids it.
- **BackgroundProcessRegistry** + BackgroundStatusWidget + BackgroundLogPanel (this fork):
  kinds incl. subagent/delegation; bounded ring logs; subscribe; createTaskHandle. Missing:
  kill/steer/attach, metrics fields, structured result slot.
- **Compaction** (core/compaction/): estimateContextTokens, findCutPoint (turn-aware),
  generateSummary + SUMMARIZATION_SYSTEM_PROMPT, branch summarization on tree navigation —
  `generateSummary` is exactly "collapse child transcript into parent-facing result".

### Prototype lessons (pi-harness) → missing primitives
- **delegate.ts** (1245 LoC): agent kinds axis; verify→assert→judge ladder (shell test →
  adversarial "REAL vs GAMED" diff audit → LLM judge, failures fed back);
  **capReturn/pullHandle** (>8000 chars → tmp spill, head + handle, JSON-subpath/regex
  pull) — research doc: better than anything in the surveyed libraries; chains persisted
  to `.pi/chains/*.yaml`; recursion caps enforced on both sides. Hacks naming missing
  primitives: hand-spawns `pi --mode json` + parses stdout (→ child-session primitive);
  `PI_DELEGATE_*` env vars (→ spawn policy as data); hardenEnv key scrubbing (→ in-process
  children); hand-parsed `.pi/agents/*.md` (→ agent defs as resource type); `router:resolve`
  event hack (→ model-role service); ctx stashing (→ UI handle outside events).
- **a2a.ts**: file mailboxes + A2A_ID env — entirely a workaround for missing parent↔child
  channel; free with in-process children.
- **ui-agent-cards.ts**: AgentCard {kind, intent, state, reqs, tokensK, costUsd, result};
  names the missing registry metrics + kill.
- **handoff.ts**: names the missing **side-request primitive** verbatim ("no 'side-request
  on the current cached prefix' primitive").
- **compress.ts / context-lcm.ts**: content-aware tool-result compression with
  externalize-and-recover; DAG context compression via context hook — both want a core
  externalized-output store and a cheap-model aux-completion helper.

### docs/subagent-research.md conclusions (prior research)
Reference shape = single-dispatch subagent tool spawning `pi --mode json`; extend agent
frontmatter toward Claude Code's; register on BackgroundProcessRegistry (highest-payoff
4-line move — since done); externalized returns with handles → promote to core;
run_in_background = the day-to-day UX win; **don't build live agent teams** (experimental
in CC, absent elsewhere — weak signal); auto-delegation = description frontmatter +
parent-LLM tool choice (three libraries converge; no selector model).

### Gap list (what core pi lacks)
1. Child-session spawn primitive. 2. Agent defs as resource type. 3. Registry control plane
(kill/steer/metrics). 4. Spawn policy as data. 5. Parent↔child messaging. 6. Return handles
in core. 7. Side-completion API. 8. Children enumeration. 9. Worktree helper.
10. Description-driven auto-delegation. 11. Credential-scoped children.

---

## 5. Cross-cutting synthesis (why the design is what it is)

| Decision | Source |
|---|---|
| Child = real session w/ parentSession | opencode (parentID), pi has the field already |
| In-process spawning | omp proved it; pi audit says structurally viable |
| Lifecycle idle→parked→revive | omp (best idea in the corpus) |
| Result-only + usage trailer + empty placeholder | Claude Code |
| Return handles + selective pull | delegate.ts (ours) + omp agent:// |
| Cache-stable agent listing | Claude Code's 10.2% lesson |
| One wire shape, strict-safe schemas | omp pitfalls 3+7 |
| Case-insensitive lookup, lenient parsing | omp pitfall 2 + opencode interop |
| Spawn policy as data; anti-recursion defaults | delegate.ts lesson + opencode deny default |
| A2A delivery matrix (aside/wake/revive) | omp irc |
| Derived A2A availability | omp |
| Fg→bg promotion | opencode + Claude Code |
| Doom-loop breaker, steps cap w/ forced wrap-up | opencode |
| Hidden utility agents (compaction/title as agents) | opencode |
| @agent one-hop bypass | opencode |
| omitProjectContext / thinking-off diets | Claude Code |
| Coordinator continue-vs-spawn table | Claude Code |
| Format contracts (Goal/Constraints/Contract) | omp |
| Chains as declarative YAML | delegate.ts precedent (omp has none; gap we fill) |
| Team presets first, live swarms later | prior research doc's negative signal + CC experimental status |
| Per-tree cost budget | opencode gap (nobody has it) |
| Retry-state surfacing ("blocked: rate-limited") | omp operational lesson |
| Fork spawns w/ placeholder tool results (Phase 4) | Claude Code standout |
| Side-request API | handoff.ts gap + CC 30s summarizer + omp handoff pipeline |
