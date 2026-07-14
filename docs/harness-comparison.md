# Coding-agent harness comparison — opencode · omp · claude-code · our pi fork

Cross-harness study (updated 2026-07-14) to decide what our fork should adopt.
Four harnesses inventoried against 16 dimensions from local source snapshots. Claims below
distinguish source/API verification from executable integration testing.

## Evidence roots

- opencode: `~/opencode/opencode/packages/opencode`
- omp: `~/omp/oh-my-pi` (`@oh-my-pi/*` 16.3.11 in the audited checkout)
- claude-code: `~/claude/claude-code/src` plus `~/claude/claude-code/package.json`, its
  reconstruction build shim, and the installed client's `~/.claude/cache/changelog.md`. These are
  two different evidence layers: the checkout identifies itself as an unofficial leaked snapshot
  dated 2026-03-31, while the installed changelog describes a newer product. A changelog-only
  feature is not treated as source-verified in the snapshot.
- our fork: this repository (`packages/`, production `extensions/`, and the separate
  `packages/coding-agent/examples/extensions/pi-harness/` prototype package)

“Implemented” means present in source. “Shipped” below means loaded by the normal production
extension directory. Neither word implies an executable cross-package integration unless a test
is explicitly named.

## The four, in one line each

- **opencode** (SST, opencode.ai) — a **headless Effect/TS server** with generated
  multi-runtime SDKs; the agent is a service, and TUI/desktop/VS Code/Zed(ACP)/Slack/web
  console are interchangeable clients. Event-sourced durable sessions. No memory/RAG,
  no scheduler, no verification gate, no swarm.
- **omp / oh-my-pi** (can1357, `@oh-my-pi/pi-coding-agent`) — a **sibling fork of the same
  `pi` base we fork**, far more built out. Rust native core (tree-sitter AST edits,
  in-process bash+coreutils, copy-on-write task sandboxing), a research-grade memory engine
  (mnemopi), a second-LLM advisor-watchdog, ~72 providers, YAML swarm orchestration,
  bitmap-image compaction.
- **claude-code** (Anthropic; audited checkout is an unofficial leaked reconstruction) — a
  mature React/Ink TUI with several distinct concurrency systems: ordinary subagents, experimental
  cache-sharing forks, long-lived agent teams/coordinator workers, local background tasks, remote
  agents, and—per the newer installed changelog—a daemon-backed cross-session agent dashboard.
  It also has typed hooks, durable/session cron, layered file memory, and remote triggers. Its
  strongest reusable ideas are lifecycle separation, navigation, and orchestration prompt-craft.
- **our pi fork** — Node-first, extension-first (34 production extensions, minimal core edits) + a governed
  Python memory service (KP, Graphiti/FalkorDB). Verified-convergence loop (criteria →
  review → gate → best-of-n) with two-tier self-optimization, executable procedural
  memory (devbrain), full memory taxonomy (semantic/procedural/working/episodic/prospective)
  under one `/recall`, governed propose-first writes, area-drift context injection, and a
  unified `/agents` activity view for subagents, loops, and background shells.

## Comparison matrix (◐ = partial)

| Dimension | opencode | omp | claude-code | our pi fork |
|---|---|---|---|---|
| Runtime | Bun/TS + Effect | Bun/TS + **Rust core** | Bun-oriented TS + React/Ink in snapshot; reconstruction emits Node 20 bundle | **Node ≥22/TS**; optional Bun compiled binary |
| Architecture | **client-server + SDKs** | monolith TUI | monolith TUI | monolith TUI + MCP memory svc |
| Core loop | gather→act (no verify) | gather→act + advisor | gather→act (coordinator) | **gather→act→verify (loop)** |
| Edit strategy | **9-strategy fuzzy replacer + patch** | **AST (tree-sitter) + hash-anchored** | line-based | line/anchor (pi) |
| Orchestration | 1-level task delegation | **IRC agent-bus + revivable agents** (swarm YAML on top) | **subagents + fork fan-out + teams + coordinator + remote workers** (gated by surface/build) | **verified loop + chains + revivable agents** |
| Subagent isolation | child session | **CoW fs clone (8 backends)** | worktree/remote/**fork** | worktree (via agent tool) |
| Memory | ✗ (instruction files) | **mnemopi (research-grade) + 3 more** | layered files: typed auto-memory, turn extraction, session notes, dream consolidation, agent/team memory | **KP governed graph + full taxonomy** |
| Memory retrieval | lexical only | **4-voice RRF + hybrid + graph** | Sonnet header selector (≤5 files) + `MEMORY.md`, freshness warnings; no vector/graph index | hot-FTS + semantic + graph, `/recall` |
| Compaction | structured summary + old-result pruning | **snapcompact (bitmap images)** | cache-aware microcompact | pi built-in + 160k mid-run ceiling + cache-collapse/task-shift recovery |
| Extensibility | ~20 hooks + code-mode | unified ext + marketplace | hooks + skills + MCP | 34 production exts + MCP + slash-seam; separate pi-harness prototypes |
| Providers | ~19 (AI SDK) + zen gateway | **~72 + auth-broker** | Anthropic-first | pi registry (multi) |
| Safety | **rule engine + doom-loop** | approval tiers + **advisor-watchdog** | allow/deny + 27 typed hook events; Stop/SubagentStop/TaskCompleted/TeammateIdle can re-drive work | **KP pre-action gate + advisories**; production exact/normalized/A-B doom-loop and optional bash-arity policy; advisor prototype |
| Scheduling | ✗ | ◐ | **session or durable cron + remote triggers**; PR subscriptions partially present/gated | ◐ `/every` while a session is open + `/intend`; `/dream` maintenance |
| Self-improvement | ✗ | ◐ (local skill-gen) | dream (memory only) | **loop GEPA (online+offline, measured)** |
| Activity / navigation | task delegation rows | task/agent panels | snapshot: typed running-task dialog + teammate transcript navigation; installed changelog: **daemon-backed all-session agents view** | **unified `/agents` + filters/detail/log navigation; `/bashes` shell-only** |
| Multi-surface | **desktop/VSCode/Zed/Slack/web** | ◐ collab-web | terminal + VS Code/web/remote panels | ◐ RPC/JSON/SDK, no first-party frontend fleet |

## Standout feature per harness (what each does best)

**opencode** — the *architecture*. One authoritative HTTP API → Promise + Effect + embedded
SDKs → a swappable frontend fleet (TUI, Electron, VS Code, Zed via ACP, Slack, hosted
console). Event-sourced durable sessions with formally-specified "Context Epochs" and
"safe provider-turn boundaries." Rule-based last-match-wins permission engine with a
**doom-loop guard** (same tool + identical input repeated → prompt). Git-dir snapshots for
undo. ~19 providers on models.dev + a hosted BYOK "zen" gateway.

**omp** — the *engineering depth*. **Rust native core** compiled to one N-API cdylib:
`pi-ast` (tree-sitter, 57 languages, AST-accurate edits staged-then-flushed),
`pi-shell` (embedded `brush` bash + in-process coreutils/ripgrep — no subprocess, no host-tool
dependency), `pi-iso` (copy-on-write task sandboxing across clonefile/btrfs/zfs/overlayfs/
ProjFS/reflink/git-worktree with git-apply-ready diffs), `pi-walker` (parallel cached
gitignore-aware traversal). **mnemopi** memory: two-tier working/episodic store, per-type
**Weibull forgetting curves**, 4-voice **RRF polyphonic recall** (vector/graph/fact/temporal),
**SHMR** belief-harmonization, bitemporal triples, veracity/trust provenance — plus 3 other
backends. **snapcompact** renders discarded history to **PNG bitmap frames** priced against
each provider's image-token billing. **Advisor-watchdog**: a second LLM reviews every turn
and injects severity-tagged advisories (with two dedup layers, secret redaction). ~72
providers + an off-box **auth-broker** for OAuth tokens.

**claude-code** — the *lifecycle and interaction craft*. Coordinator mode's doctrine
(always-synthesize, per-worker purpose statements, continue-vs-spawn, independent verification) is
the clearest articulation of orchestration prompt-craft in this comparison. Its task model separates
local shells, local agents, in-process teammates, remote agents, workflows, monitors, dreams, and a
backgrounded main session instead of erasing their different lifecycle needs behind one process
type. Experimental **forked subagents** preserve a byte-identical parent prompt/tool prefix for
cache sharing. Auto-memory combines typed Markdown files, LLM relevance selection, end-of-turn
extraction, session notes, team sync, and dream consolidation. Hooks can use command, prompt, HTTP,
or agent verifiers. Cron supports both in-memory and durable jobs. The source snapshot's running-task
dialog and teammate transcript view are separate from the newer daemon-backed `claude agents`
dashboard described by the installed changelog; the latter is not present as inspectable source in
this checkout.

**our pi fork** — the *verification + memory governance*. It has the strongest first-class
**verified convergence loop** in this comparison: criteria.json (done-as-data) → independent diverse-model review →
devbrain execution gate → best-of-n on repeated rejection, with two-tier GEPA self-optimization
(online prompt-rewrite + offline distillation, measured recurrence). **devbrain** =
executable procedural memory with typed triage (env/flake/product_bug). Full memory taxonomy
unified under `/recall`. **Governed memory** — every write is propose-first, evidence-gated
(user→confirmed, machine→supported, model→proposed); memory can't be silently corrupted.
Area-drift context injection with cross-channel dedup and KV-cache discipline. Claude can also
mechanically block `Stop`/`TaskCompleted` through configured hooks; our distinction is that
criteria + independent review + executable gate are built into the loop rather than delegated to
user hook configuration. The production TUI now exposes agents, orchestrated loops, and background
shells through one registry-backed `/agents` view.

## Claude deep dive — mechanisms, boundaries, and lessons

The prior analysis flattened several independent Claude systems into “coordinator + background
workers.” That is too coarse to guide implementation. The source exposes six distinguishable
concurrency planes, while the evidence splits activity behavior between a snapshot TUI and a newer
installed-product dashboard.

### 1. Concurrency planes are deliberately different

| Plane | Creation and context | Lifecycle/control | Isolation and persistence |
|---|---|---|---|
| Ordinary `Agent` subagent | `AgentTool`; selected agent definition, model, tools, permissions, optional memory | synchronous foreground or async `local_agent`; progress counts, recent tools, completion XML, stop, queued follow-up, resume from transcript | optional agent-definition worktree; per-agent transcript symlink and task-output file |
| Fork subagent | compile-gated `FORK_SUBAGENT`; omitting `subagent_type` inherits the full rendered prompt and conversation | always async; recursive forks rejected; parent receives task notification | exact parent tool pool/system-prompt bytes for cache identity; `permissionMode: bubble`; optional worktree notice/path translation |
| Agent-team teammate | `TeamCreate` + shared spawn path; in-process runner or tmux split-pane/separate-window backend | long-lived teammate identity, mailbox messages, task ownership, idle state, kill, foreground transcript; can be continued without respawning | same cwd unless separately configured; team file/mailbox provide cross-process state; teammate crons are session-only and owner-routed |
| Coordinator worker | compile/runtime-gated coordinator mode; `Agent(subagent_type="worker")` | coordinator is tool-restricted to orchestration; workers notify asynchronously; `SendMessage` continues loaded workers and `TaskStop` stops them | fresh worker context by default; coordinator prompt requires synthesis before continuation/spawn and recommends fresh independent verifiers |
| Background main session | compile-gated `BG_SESSIONS`; backgrounds the active query or starts a fresh query from copied messages | query continues while main UI clears; can be foregrounded/re-backgrounded; isolated abort controller, transcript, completion notification | snapshot implementation is process/task-registry scoped; newer installed changelog describes daemon survival/restart behavior not present in these files |
| Remote agent | remote session API, including review/plan/autofix variants | polls remote state/log deltas, debounces transient idle, notifies, archives on kill; review timeout is 30 minutes | remote environment; status fetched rather than trusted from stale local state |

Reusable lesson: one registry can normalize identity, status, timestamps, output, and control
capabilities, but it should not pretend every task supports the same operations. Claude dispatches
detail views and kill/foreground behavior by type. Our activity registry already follows this
direction; it should keep capability checks explicit as more process types are added.

### 2. Snapshot TUI versus installed agents dashboard

The snapshot contains a `BackgroundTasksDialog`, not the full current `claude agents` dashboard.
Its behavior is source-verified:

- `isBackgroundTask` admits only `running`/`pending` tasks and excludes explicitly foregrounded
  tasks. Completed history therefore is not a durable list in this dialog.
- Rows are typed and grouped: agent-team members, shells, MCP monitors, remote agents, local agents,
  workflows, and dream tasks. A synthetic leader row lets the user return from a teammate view.
- One task skips the list and opens detail directly; Back closes only when there is still at most
  one task, otherwise it reveals the now-relevant list. Selection is clamped as tasks disappear.
- Up/Down selects, Enter opens detail, `x` stops when supported, `f` foregrounds a teammate, and a
  separate binding stops all local agents. Each type gets its own detail component.
- Shift+Up/Down has a second, transcript-oriented path. With teammates it cycles leader → workers →
  hide, wrapping at both ends. `f` or Enter opens a teammate transcript. Escape while a teammate is
  running aborts only its current work; Escape on a terminal teammate exits the view. Without
  teammates, the same navigation opens the ordinary background-task dialog.
- Task output is disk-backed. Agent/main-session task output is symlinked to isolated sidechain
  transcripts; shell output is streamed through `TaskOutput`; remote output is appended from poll
  deltas. This lets detail views read progress without holding the entire output in React state.

The installed changelog describes a newer, broader surface introduced as an “agent view”: `claude
agents` groups every Claude session by working/needs-input/completed state, supports dispatch and
reply, attach/detach, JSON listing, filtering by URL, pinning, renaming, background shell dispatch,
and daemon restart recovery. It also reports web/desktop/VS Code task panels. Those claims are
product/changelog evidence only here: `src/cli/handlers/agents.ts` in the audited snapshot merely
prints configured agent definitions, and `src/commands/agents/agents.tsx` opens the agent-definition
menu. The dashboard implementation is absent, so its state machine and renderer cannot be copied
from this checkout.

For our fork, the source-backed patterns worth retaining are typed detail views, contextual
controls, transcript foregrounding, disk-backed output, selection clamping, and explicit leader
navigation. The daemon dashboard is a separate product decision; our current registry-backed
`/agents` should not be described as daemon-equivalent.

### 3. Completion and hooks are stronger than a generic “Stop hook”

The snapshot defines 27 hook events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`,
`PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`,
`ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`,
`CwdChanged`, and `FileChanged`.

Hooks are not shell-only. Persisted configuration supports command, prompt-model, HTTP, and
agent-verifier hooks; callbacks also exist for runtime registration. Important mechanical effects:

- `PreToolUse` can deny or rewrite input; `PermissionRequest` can allow/deny and update permissions.
- `Stop` exit 2 returns feedback to the main model and continues the conversation.
- `SubagentStop` does the same inside the subagent and includes agent ID/type/transcript plus the
  last assistant message.
- For teammates, stop handling first runs `TaskCompleted` for every in-progress task they own, then
  `TeammateIdle`. Either can inject feedback and prevent the teammate from becoming idle.
- `TaskCreated` can prevent creation; `PreCompact` can prevent compaction; `ConfigChange` can block a
  changed configuration from entering the live session.
- `StopFailure` is intentionally observability-only/fire-and-forget for API failures and should not
  be counted as a correctness gate.

This narrows our differentiation. Claude already supplies configurable, mechanical, agentic
verification points. Our loop remains different because acceptance criteria, an independent
reviewer, executable gates, rejection accounting, and best-of-n escalation are one persisted
protocol rather than user-authored hook policy. The fair claim is “first-class convergence
protocol,” not “only system that can block done.”

### 4. Scheduling has three durability levels

Claude's local cron tools are more nuanced than “cron while the TUI is open”:

1. `durable: false` (default) stores a one-shot or recurring job in process memory. It dies with the
   session.
2. `durable: true` writes `<project>/.claude/scheduled_tasks.json`. Jobs resume on restart;
   missed durable one-shots are surfaced for catch-up.
3. System-installed `permanent` jobs are exempt from the normal recurring-job expiry. Users cannot
   set this through `CronCreate`.

The scheduler uses five-field local-time cron, caps the tool at 50 jobs, applies deterministic
jitter, defaults recurring jobs to a seven-day maximum age, routes teammate-owned fires back to the
teammate queue, and removes orphaned teammate jobs. Normal fires enter the command queue at “later”
priority. A runtime kill switch stops active schedulers. Durable teammate jobs are rejected because
teammate identity does not survive a session.

Remote triggers are a different plane: `RemoteTriggerTool` calls the authenticated claude.ai trigger
API for list/get/create/update/run, keeps OAuth out of shell commands, and is gated by entitlement
and policy. PR activity is less fully evidenced: coordinator/tool-pool code recognizes MCP tools
whose names end in `subscribe_pr_activity`/`unsubscribe_pr_activity`, and the bridge can render
feature-gated GitHub webhook messages. The locally referenced built-in `SubscribePRTool` and webhook
sanitizer files are absent from this snapshot, so built-in subscription execution is not
source-verified here.

### 5. Memory is file-native but not merely lexical

Claude's auto-memory should be described as an LLM-routed file system, not plain “file recall”:

- Per-project memory uses `MEMORY.md` as a bounded index plus Markdown topic files. Canonical git
  root selection makes worktrees share project memory. The default taxonomy is `user`, `feedback`,
  `project`, and `reference`; it explicitly rejects derivable code structure, git history, fix
  recipes, CLAUDE.md duplicates, and ephemeral task state.
- Recall scans at most 200 Markdown headers, reads frontmatter/type/mtime, and asks Sonnet for at
  most five clearly relevant files. Already-surfaced files are removed before selection. Recent
  tool names suppress redundant tool-reference memories. `MEMORY.md` is already in the prompt.
- Mtime is surfaced as human-readable age. Memories older than one day receive a staleness warning,
  and the prompt directs the model to verify code/resource claims and update or delete drifted
  memory.
- End-of-turn extraction is a cache-sharing fork with read-only exploration and write access only
  inside memory roots. It skips extraction when the main agent already wrote memory and serializes
  overlapping runs with a trailing-run queue.
- Session memory is separate: after token/tool thresholds, a forked agent updates a private session
  note. Experimental compaction can use that note while preserving a recent message segment and
  API tool-use/tool-result invariants.
- Auto-dream defaults to requiring both 24 hours and five intervening sessions, takes a filesystem
  lock, then runs orient → gather → consolidate → prune/index. Failure rolls the lock timestamp back;
  the background dream is registered as a killable task.
- Feature-gated team memory adds private/team scope, startup pull plus debounced push, secret
  scanning, and symlink-aware path-containment checks.

This is materially stronger than lexical instruction files, but it still lacks our semantic/vector
and graph lanes, evidence-state governance, and propose-first write policy. Claude's useful ideas
for KP are freshness presentation, negative retrieval instructions, capped selective routing, and
mutual exclusion between direct writes and background extraction—not replacing KP with Markdown.

### 6. Source and shipping boundary

The checkout's `package.json` declares Bun and `bun:bundle` feature constants; its reconstruction
script aliases those constants to an environment-driven shim and emits a Node 20 bundle. Several
referenced production flags are absent from that shim, and several gated internal files are absent
from the checkout. Therefore:

- ordinary local-agent/background-task mechanics, fork/coordinator source, cron internals, hook
  semantics, memory internals, and remote-trigger client code are source/API verified;
- whether a gated path is enabled in Anthropic's production build is not established by merely
  finding its source;
- daemon-backed `claude agents`, its current persistence behavior, and some webhook/PR behavior are
  supported by the installed changelog, not executable/source validation in this checkout;
- no Claude binary was instrumented or PTY-tested during this documentation audit.

## Deep token/lifecycle comparison — the other three

This pass compared the mechanics that determine whether a long run stays cheap and controllable,
not just the feature names. The important distinction is *when* each harness rewrites context,
whether omitted data remains recoverable, and whether continuation is explicit or inferred.

### Claude Code: cache-aware rewriting, not generic compaction

The audited Claude source has four separate mechanisms that are easy to conflate:

1. `apiMicrocompact.ts` uses provider cache-editing support to clear old tool uses/results toward a
   target size. This is an API capability optimization, not a generally portable transcript
   algorithm. It is main-thread-only because applying it inside a child could invalidate cache state
   shared with the parent.
2. `timeBasedMCConfig.ts` treats an idle gap over 60 minutes as proof that the server prompt cache is
   already cold. On the next request it transiently replaces old compactable tool results, retaining
   the five newest. The persisted transcript remains intact. This avoids paying to rewrite a large
   prefix whose cache entry has certainly expired.
3. `grouping.ts` groups history by provider/API round rather than by the visual human turn, so a
   rewrite does not separate an assistant tool call from its result. `postCompactCleanup.ts` then
   invalidates only the caches whose source history actually changed.
4. `tokenBudget.ts` implements an explicit user-requested continuation budget. It continues only on
   the main thread, stops near 90% of the requested amount, and terminates after repeated marginal
   continuations. This is a user-controlled research mode, not a default completion policy.

Claude also persists scoped agent memory plus project snapshots (`agentMemory.ts`,
`agentMemorySnapshot.ts`) and can fork a subagent with a byte-identical rendered parent prefix.
Those improve reuse, but duplicating them here would overlap the governed knowledge platform and
increase memory ownership ambiguity.

**Pi decision:** do not imitate provider cache editing, automatic high-token continuation, or a
second memory authority. A cold-cache transient trim is technically compatible with the `context`
extension hook, but should remain deferred until an A/B trace shows that removed old results do not
cause more rereads than they save. Pi's existing compaction preserves tool call/result boundaries
and now runs inside long tool loops; cache-specific rewriting is an optimization after that baseline,
not a correctness fix.

### OpenCode: request accounting, recoverable truncation, and explicit continuation

OpenCode's strongest token behavior is architectural rather than model-prompt wording:

- `session/compaction.ts` estimates the serialized request before each provider call, including the
  system prompt, messages, and tools. It reserves the larger of the model output allowance or 20k,
  retains roughly 8k recent tokens, and caps tool output included in the summary input at 2k. An
  overflow gets one deterministic compact-and-retry path.
- `session/context-epoch.ts` snapshots baseline system context and emits only a delta when repository
  instructions change. After compaction it replaces the baseline epoch. This prevents dynamic
  project context from being re-injected as a growing sequence of near-duplicates.
- `tool/truncate.ts` limits a tool result to 2,000 lines or 50 KiB but writes the complete output to
  a retained file. The returned notice instructs the model to search or read a narrow range. The
  expensive operation never has to be repeated merely because its display was bounded.
- `tool/task.ts` accepts a `task_id` to continue the exact child session. This makes reuse an explicit
  action on the same task surface instead of asking the model to infer that it should switch tools.
- Child permissions inherit parent denials, and the subagent inspector keeps bounded snapshots
  (calls, commits, roles, errors, questions) rather than replaying an unbounded event log into UI
  state.

**Pi decision:** recoverable truncation is the immediate win. Primary-session results already spilled
to disk; core child-session limiting now does the same, including a narrow-read instruction and a
focused regression test. Pi's `agent_message` already provides ID-based continuation, and the new
idle-agent context inventory makes the IDs model-visible. Adding a second `task_id` alias to the
large `agent` schema would duplicate lifecycle logic and charge schema tokens on every request, so
defer it unless traces still show needless respawns. Pi now applies the context-epoch idea at the
boundary where ownership is already explicit: older `pi_context_task`/`pi_context_shift` packets are
transiently replaced once a newer broker WorkFrame is active, while the original JSONL stays intact.
General epochs for changing project/system instructions remain a larger design because those sources
do not yet share one version/ownership contract.

### oh-my-pi: maintenance during the run, measurable savings, and completion guards

OMP contains the most directly comparable long-run machinery because it shares Pi's ancestry:

- Its mid-run guard waits for the just-finished tool turn to be persisted, compares billed provider
  usage with a stored-context estimate, promotes to a larger model when configured, then compacts in
  place before the next provider request. Handoff is suppressed at that boundary to avoid racing the
  live message array.
- It prunes superseded/stale tool results before threshold compaction and records actual savings in
  an append-only, per-session JSONL journal with tool-call deduplication
  (`snapcompact-savings-journal.ts`). This distinguishes measured avoided context from an estimate.
- After 12 successful mutating tool results without touching the todo state, it injects a hidden,
  capped reconciliation nudge. Read-only calls and errors do not advance the counter. This fixes a
  stale HUD without turning todo maintenance into another foreground loop.
- `unexpected-stop-classifier.ts` asks a small model whether a normal-looking stop actually abandoned
  a promised next action, then can re-drive the run up to three times. It improves completion but
  adds another request and can amplify a runaway task; it is not a token optimization.
- Its loop guard uses cross-turn tool/result summaries, while snapcompact can encode archived context
  as an image for vision-capable models. Both are substantial systems, not small extension patterns.

**Pi decision:** Pi's newly added core mid-run compact-and-resume path matches the critical safety
boundary, including the live tool-loop continuation. The plan extension now adopts the cheaper OMP
pattern: after eight successful file mutations it can emit at most two hidden reconciliation nudges,
and any real `update_plan` call resets the runway. Do not adopt the unexpected-stop classifier by
default: it spends tokens on every candidate stop and conflicts with the hard child boundary. Add a
savings journal only after deciding which counters are stable enough to expose; otherwise it would
measure characters or estimates while presenting them as avoided provider tokens.

### Resulting priority after the deep pass

| Mechanism | Current Pi state | Decision |
|---|---|---|
| Mid-run compact-and-resume | implemented and focused-test verified | keep; PTY/A-B validate on a fresh long session |
| Recoverable oversized output | primary and child paths now spill full text | keep; count avoided reruns next |
| Parked-agent continuation | explicit `agent_message` plus scoped ID inventory | measure respawn rate before adding another schema field |
| Stale plan/todo state | bounded mutation-based hidden reconciliation | keep; no autonomous todo loop |
| Context epochs | implemented for broker WorkFrame packets; not general project instructions | keep the scoped version; design ownership before generalizing |
| Cold-cache transient trim | absent | gated experiment only after reread-rate measurement |
| Unexpected-stop classifier | absent | default-off at most; correctness/cost tradeoff |
| Provider cache editing / snapcompact | absent | provider/model-specific; defer |
| Savings journal | absent | add only with provider-token-grounded counters |

## What our fork already leads on (don't chase)

- **First-class verified-done loop** — Claude hooks can block completion, but no other compared
  harness combines explicit acceptance criteria, independent review, executable gates, and
  best-of-n escalation as one convergence mechanism. Keep and deepen.
- **Governed, evidence-gated memory writes** — omp's mnemopi is more *sophisticated* at
  storage/recall, but writes are ungoverned; ours can't be corrupted by a bad inference.
- **Executable procedural memory (devbrain)** — unique; nobody has verify-blocks as memory.
- **Two-tier measured self-optimization** — claude-dream consolidates memory but doesn't
  optimize prompts against a metric; ours does, with before/after recurrence numbers.
- **Prospective memory** (`/intend` event + `/every` time) — only claude has cron; nobody
  else has event-triggered future intentions. `/every` is not a daemon: it fires only while a Pi
  session for the repository is open, so do not claim full cron parity.

## Adoption status in our fork

**Shipped in the production `extensions/` directory:**

- Registry-backed background subagents and background bash (`run_in_background`), completion
  notifications, status/footer widgets, and a unified `/agents` view. The view groups Needs input /
  Working / Completed, filters All/Agents/Processes, recognizes orchestrated loops, and provides
  detail/log scrolling plus kill/steer/revive navigation. `/bashes` remains the shell-only view.
- The orchestrated verification loop: persisted progress/criteria/guardrails, independent review,
  gate checks, watchdog parking, steerable budgets, and best-of-n after repeated rejection.
- Session-open interval scheduling (`/every`), event-triggered one-shot intentions (`/intend`),
  governed recall/writeback, and dream maintenance.
- Production token controls: universal 12,000-character text-result spill with head/tail retention
  for shell/errors and core child runs (full omitted output remains recoverable), unchanged
  read/search suppression, 12-call discovery and 24-call finish
  checkpoints, hard 32-call primary and 14-call child budgets, and 160,000-token mid-run
  compact-and-resume so one continuous tool loop cannot bypass the normal post-run ceiling.
- The plan widget uses a neutral active marker and a capped reconciliation checkpoint after sustained
  successful mutations, preventing long implementation runs from leaving the visible checklist stale.
- The knowledge broker keeps only the current task/shift WorkFrame packet active in provider context;
  older packet payloads remain persisted but are replaced by short epoch tombstones for requests.
- Production doom-loop detection: exact calls trip at 3, operation-normalized repeats at 6, and
  A/B cycles at 12; state resets per agent run. Optional `.pi/bash-arity.json` policy applies
  longest-prefix allow/ask/deny rules to normalized shell subcommands.

**Implemented only in the separate `pi-harness` example/prototype package:**

- `hashline.ts`: a smaller 3-character line-hash `hread`/`hedit` prototype with seen-line and stale-
  anchor rejection. It validates the approach but is not omp's `[PATH#TAG]` language, recovery
  machinery, or tree-sitter block-edit implementation.
- `permissions.ts`: an older configurable identical/A-B doom-loop prototype, superseded by the
  production `extensions/doom-loop.ts` guard.
- `advisor.ts`: opt-in (`KP_ADVISOR=1`) second-model reviewer with bounded delta, severity contract,
  FIFO dedupe, and append-only cache-safe injection.

**Not adopted:** omp's native AST/CoW package, official hashline package, RRF recall fusion,
snapcompact, and ACP frontend support.

**Claude mechanisms not matched by current production behavior:** daemon-backed sessions that keep
running across Pi process exits, attach/detach to a live main-session TUI, durable scheduled execution
while no Pi session is open, and a hook taxonomy as broad as Claude's 27 events. These are not all
recommendations: the current `/agents` registry already has the higher-value in-session pieces
(typed kinds, capability flags such as `canKill`/`canSteer`, status grouping, detail logs, revive,
and loop recognition). Replacing it with Claude's older snapshot dialog would be a regression.

## Include decision — ranked (what to adopt, and why)

### Tier 1 — high value, fits our architecture, clear win

0. **Graduate hashline from prototype to production — still #1.** Content-hash-anchored
   line patches: each file section headed `[PATH#TAG]` (4-hex hash of normalized content); ops
   name original line numbers and supply only new text (the model never retypes context lines);
   **stale anchors are rejected before applying**, killing the "string not found"/whitespace
   retry loops. omp's own TS edit benchmark proves the *format*, not the model, drives edit
   reliability: Grok Code Fast 1 **6.7% → 68.3%**, MiniMax **2.1×**, Grok 4 Fast **−61% tokens**.
   That is our exact "strong harness makes a weak model reliable" thesis, and it's a **format
   change** — far cheaper than native adoption, works with any model. Our current pi-harness
   `hread`/`hedit` prototype is evidence that the ExtensionAPI seam works, but it is a simpler and
   incompatible dialect. The official package is MIT and internally decoupled (only `diff` and
   `lru-cache`; pluggable filesystem); plain line operations need no native code. However, its npm
   surface exports TypeScript and declares Bun ≥1.3.14, while our production runtime is Node ≥22,
   so direct import is not yet a tested drop-in. Productionize by vendoring/building a Node-ready
   adapter or upstreaming compiled JS, with builtin edit fallback. **Highest leverage on the list.**
1. **AST-based editing via a native engine (from omp `pi-ast`).** Complements hashline (its
   `.BLK` block ops already use tree-sitter). tree-sitter-accurate across 57 languages with
   overlap rejection and staged-flush atomicity. Path: consume `@oh-my-pi/pi-natives` (published
   npm addon) as an optional accelerator behind a JS fallback. Source/API feasibility is now
   verified: the MIT N-API package exports `astEdit`, `blockRangeAt`, and related APIs through JS.
   The hashline package accepts an injected `BlockResolver`, so `.BLK` is optional rather than a
   core-package dependency. Executable integration in this Node fork remains untested.
2. **Copy-on-write task sandboxing (from omp `pi-iso`).** Our loop workers use git worktrees;
   `pi-iso` gives cheap CoW clones with git-apply-ready diffs across 8 fs backends — better
   isolation for best-of-n candidate workers and safer autonomous runs. `@oh-my-pi/pi-natives`
   directly exports `isoProbe/Resolve/Start/Diff/Stop`; published leaves cover linux x64/arm64,
   macOS x64/arm64, and Windows x64 (x64 baseline/modern variants). The loader has Node fallbacks
   despite the package's Bun engine declaration. Same optional-addon path as #1; still needs a
   real install/smoke test and fallback behavior on unsupported filesystems/platforms.
3. **Productionize the advisor-watchdog prototype (from omp).** A second LLM reviewing every turn and injecting
   severity-tagged advice complements our loop review (which only fires on done-claims). A
   continuous critic catches drift mid-work. The isolated-review, dedupe, and cache-stable
   injection implementation already exists in pi-harness; the remaining work is production
   configuration, cost/latency measurement, and adversarial false-positive testing.
4. **Measure and tune the production doom-loop and bash-arity guards.** Both are implemented.
   Exact repeats trip at 3; normalized identical and A/B operation cycles use the more conservative
   threshold of 6. Bash arity applies longest-prefix policy (`git status` versus `git push`) when a
   repository supplies `.pi/bash-arity.json`. Remaining work is representative false-positive,
   avoided-call, and policy-coverage measurement, not another implementation.

### Tier 2 — valuable, more effort or narrower

5. **Durable prospective execution (from Claude cron/daemon).** Our `/every` persists definitions
   but only arms them inside a live Pi process. If unattended work is a real goal, split definition
   persistence from execution ownership: a small per-project daemon/service should lease due jobs,
   enqueue them once, record last-fire state, catch up missed one-shots, cap recurrence, and expose
   them through the existing registry. Do not bolt timers onto the TUI and call it daemon support.
   This is high product value but a larger operational/security commitment, so build it only for a
   concrete unattended-use requirement.
6. **Richer recall ranking (from omp mnemopi).** We have hot-FTS + semantic + graph but a
   simple blend; omp's RRF multi-voice fusion (esp. the graph-traversal voice) and per-type
   decay are measurably better retrieval. Adopt the *ideas* (RRF fusion over our existing
   lanes; recency/type weighting) into KP's `context_task`, not the whole engine — our
   governance model is the thing to keep.
7. **snapcompact bitmap compaction (from omp).** Genuinely novel and cheaper for vision
   models, but it's a big self-contained system and our compaction is pi-inherited and fine.
   Adopt only if compaction cost becomes a measured problem. **Watch, don't build yet.**
8. **ACP editor integration (from opencode).** Lets Zed/other editors drive our fork. High
   value *if* you want editor-native use; pure addition (implement the ACP agent surface).
   Defer unless that's a goal.

### Tier 3 — deliberately skip (poor fit or we already win)

- **Client-server + multi-surface SDK fleet (opencode).** Huge architecture change; our
  value is a tight single-binary + governed memory. Only worth it if productizing multiple
  frontends becomes the goal. **Skip.**
- **YAML swarm DAG (omp) / more orchestration constructs.** We already decided: loop + chain +
  prompt-based collaboration, one coordinator. A swarm is a third construct we rejected. **Skip.**
- **mnemopi wholesale / 4 memory backends.** More sophisticated storage, but ungoverned and a
  massive surface; our governed KP + full taxonomy is the right base. Take the *ranking ideas*
  (#5), not the engine. **Skip the engine.**
- **In-process bash+coreutils (omp `pi-shell`).** Nice, but a large native surface whose main
  win (no host-tool dependency) we don't currently need. Reconsider only alongside #1/#2 if we
  adopt the native addon anyway (it'd come partly for free). **Defer.**
- **Hosted gateway / auth-broker / console / enterprise (opencode, omp).** Infra/productization,
  not harness capability. **Skip.**

## Sequenced recommendation

If you act on this, the order that compounds:
1. **Measure the now-production doom-loop, output, and run-budget controls** on fresh sessions;
   tune thresholds only from avoided-call and false-positive evidence.
2. **Graduate hashline** from the simple `hread`/`hedit` prototype to the official snapshot-tag
   semantics, keeping Node compatibility and builtin-edit fallback explicit.
3. **Run a scoped `pi-natives` executable POC on linux-x64** (`astEdit` + `isoProbe/Start/Diff/Stop`)
   before adding a dependency; if green, AST editing and CoW sandboxing share that boundary.
4. **Productionize advisor-watchdog** only after measuring reviewer latency, cost, duplicate rate,
   and false-positive rate on real sessions.
5. **RRF recall ranking** — retrieval quality inside KP while preserving governance.
6. **Only if unattended execution becomes a concrete goal:** design durable scheduling around a
   lease-owning service and the existing activity registry; do not extend `/every` timers piecemeal.

Everything else is watch-or-skip. The through-line: finish and measure the prototypes already in
the tree, then adopt omp's *native engineering* (AST, sandbox) and *continuous critique*
(watchdog), take opencode's *cheap safety guard*, and borrow *recall ideas* rather than engines.
From Claude, keep the typed lifecycle/navigation patterns already present and treat daemon-grade
execution as a separate product boundary. Preserve our differentiators: verified-done loop,
governed memory, executable procedural memory, and measured self-optimization.

## Token-consistency audit — 2026-07-14 licensing session

This snapshot is evidence for prioritization, not validation of the new controls: the captured Pi
process started before the latest extensions were loaded, so it did not yet have the new hard caps,
universal result bound, or mid-run ceiling.

- Main session: 113 model requests, 220 tool calls, 472,169 fresh tokens (input + output),
  13,079,552 cache-read tokens, 96.8% prompt cache hit, $10.0491, and a 193,717-token maximum
  prompt. It recorded zero compactions even though the configured post-run ceiling was 160,000.
- The failure was run length, not initial prompt/tool-schema size. The first request was 7,136
  input tokens. A single `continue` expanded to 66 requests and 131 tool calls; `complete cleanup`
  expanded to 35 requests and 64 calls.
- Tool results contributed 581,854 text characters: reads 213,606, bash 182,052, and grep 165,316.
  Six individual results exceeded the new 12,000-character cap (three bash, three read); the largest
  was 39,255 characters. Tool arguments added another 121,488 characters, including full-file
  writes and inline Python rewrite scripts.
- Five child agents made 551 tool calls, used 976,849 fresh tokens plus 10,095,616 cache-read
  tokens, and cost $11.2971. The largest reviewer alone made 188 calls across 72 requests, used
  447,832 fresh plus 5,553,152 cached tokens, and cost $5.5783. This is why displaying only
  `3,023k tok` was misleading: processed/cache-read volume and fresh traffic must be separate.
- Exact duplicate calls were rare in the main session; broad unique rediscovery dominated. Read
  dedup and doom-loop detection are safety nets, while the 32/14 hard run budgets and mid-run
  compaction ceiling address the measured failure mode directly.

Expected behavior after a fresh Pi restart: a primary run cannot execute more than 32 tools, a child
run cannot execute more than 14, every oversized text result spills to disk with a bounded preview,
and an active run crossing 160,000 context tokens aborts safely, compacts, and resumes from a
checkpoint. Outcome savings and false positives still require a fresh-session A/B; no counterfactual
token-saving percentage is claimed from this historical trace.

## Coverage status — verified, partial, and still requiring execution

### Source/API verified

- **opencode:** core loop v1+v2, fuzzy edit/apply-patch paths, task delegation,
  instruction-file memory, compaction/Context Epochs, plugins/MCP/code-mode, SolidJS+opentui and
  multi-surface clients, provider routing, permission rules, doom-loop/arity handling, and git-dir
  snapshots.
- **omp:** mnemopi, snapcompact, context/handoff/collaboration, extensions/approval/providers,
  `pi-ast`/`pi-shell`/`pi-iso`/`pi-walker`, IRC/revivable agents, hashline language, goals/TTSR/eval,
  LSP diagnostics, and tool/session mechanics.
- **claude-code snapshot:**
  - ordinary async/foreground agents, progress/notification/stop/resume, fork prompt-cache
    construction, coordinator worker policy, in-process and tmux teammate spawn, background main
    session plumbing, and remote-agent polling;
  - task taxonomy and disk output: `src/tasks/`, `src/utils/task/`; typed list/detail dispatch:
    `src/components/tasks/BackgroundTasksDialog.tsx`; teammate transcript state/navigation:
    `src/state/teammateViewHelpers.ts`, `src/hooks/useBackgroundTaskNavigation.ts`;
  - all 27 declared hook events and their command/prompt/HTTP/agent schemas, including the exact
    Stop/SubagentStop/TaskCompleted/TeammateIdle continuation paths: `src/entrypoints/sdk/coreTypes.ts`,
    `src/schemas/hooks.ts`, `src/query/stopHooks.ts`, `src/utils/hooks.ts`;
  - session-only versus durable cron, one-shot catch-up, recurring expiry/jitter, teammate routing,
    and remote trigger API client: `src/tools/ScheduleCronTool/`, `src/utils/cronTasks.ts`,
    `src/utils/cronScheduler.ts`, `src/hooks/useScheduledTasks.ts`, `src/tools/RemoteTriggerTool/`;
  - typed auto-memory, Sonnet top-five header selection, extraction serialization, session notes,
    compaction invariants, auto-dream gates/lock, and feature-gated team-memory sync/security:
    `src/memdir/`, `src/services/extractMemories/`, `src/services/SessionMemory/`,
    `src/services/autoDream/`, `src/services/teamMemorySync/`;
  - tools/edit, plugins/MCP/skills, permission/sandbox, and insights internals.
- **our fork:** production registry/background-agent/background-shell/loop/TUI behavior; KP gates and
  memory; `/every`, `/intend`, `/dream`, `/recall`; production token budgets, cache recovery,
  doom-loop, and bash-arity; plus source inspection of pi-harness hashline and advisor prototypes.
  The unified activity overlay was additionally
  exercised in a real PTY with agent + failed/completed shell fixtures: sectioning, filters, detail,
  PageUp log scrolling, and Esc-back all passed. Its focused tests pass 3/3.
- **Tier-1 static feasibility:**
  - `@oh-my-pi/hashline` is MIT, filesystem-pluggable, and independent of omp coding-agent. Its
    plain line language is native-free; `.BLK` uses an injected `BlockResolver` and can be omitted.
  - `@oh-my-pi/pi-natives` is MIT N-API with direct JS exports for `astEdit`, block resolution, and
    `isoProbe/Resolve/Start/Diff/Stop`. Release scripts publish optional leaves for linux x64/arm64,
    Darwin x64/arm64, and Windows x64; x64 has baseline/modern ISA variants. Loader source contains
    Node fallbacks as well as Bun-compiled support.

### Partial

- **Claude installed product versus snapshot:** the current installed changelog supports the claims
  about the daemon-backed all-session `claude agents` dashboard, web/desktop/VS Code task panels,
  attach/detach, pinning, JSON listing, and restart recovery. That implementation is not in the
  audited source snapshot. The snapshot's `claude agents` CLI handler lists configured agent types;
  it is not the current session dashboard.
- **Claude PR subscriptions:** coordinator policy and tool filtering recognize subscription MCP
  tools, and bridge/UI code recognizes GitHub webhook messages. The referenced built-in
  `SubscribePRTool` and `webhookSanitizer` implementation files are absent, so built-in execution,
  payload validation, and subscription persistence are not source-verified.
- **Claude build flags:** gated source shows design/API feasibility, not production availability.
  The reconstruction shim omits several flags referenced by source and defaults the flags it does
  know to off.
- **Claude provider/model routing:** first-party, Bedrock, Vertex, Foundry, gateway/model overrides,
  `useMainLoopModel`, and fast-mode paths are source-confirmed, but this audit did not enumerate every
  entitlement/fallback branch or produce a provider-count table. The comparison only needs the
  Anthropic-first conclusion, so deeper enumeration is low priority.
- **omp UI/session detail:** mechanisms are source-confirmed where they affect adoption, but the
  append-only renderer and every session command were not exhaustively re-indexed line by line.
- **Performance claims:** benchmark numbers quoted for omp hashline come from omp's benchmark/report;
  they were not reproduced against our models, prompts, or repositories.

### Still untested executably

- Building or running the Claude snapshot with the gated paths enabled, and PTY-validating its
  background-task dialog, teammate transcript navigation, cron restart behavior, hook blocking, or
  memory extraction. No current Claude binary instrumentation was performed; installed-product
  statements above remain changelog evidence.
- Installing `@oh-my-pi/hashline` into this Node workspace. Its source-level decoupling is verified,
  but the published package exports `.ts` and declares Bun, so a Node-ready build/vendor strategy must
  be proven before production adoption.
- Loading the published `@oh-my-pi/pi-natives` leaf in this fork and actually running
  `astEdit` plus `isoProbe/Start/Diff/Stop`. Static API/platform/license compatibility is verified;
  binary loading, glibc/ISA behavior, filesystem backend selection, packaging, and fallback remain
  executable POC work. The audited omp checkout contains the loader/declarations but no local
  `.node` artifact or installed platform leaf, so this cannot be smoke-tested locally without a
  build or package install.
- Production quality of the remaining pi-harness prototypes. Hashline edit success/token savings
  and advisor cost/latency/duplicate/false-positive rates have not been measured on representative
  real sessions. Production doom-loop false positives and avoided calls also still need measurement.
- Daemon-grade scheduling parity. `/every` persists definitions but only arms timers while a Pi
  session is open; it does not yet match Claude's daemon/remote trigger or PR-subscription behavior.

The raw per-harness inventories are still not persisted as separate reports; this document now
contains the adoption-relevant mechanisms, evidence roots, corrections, and verification boundary.
