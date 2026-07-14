# pi Subagent System — Design

Synthesis of four deep-dives (2026-07-08): Claude Code source (`~/claude`), opencode (`~/opencode`),
oh-my-pi (`~/omp`), and pi's own primitives/prototypes (delegate.ts, a2a.ts, ui-agent-cards.ts,
docs/subagent-research.md). Goal: a world-class, in-core subagent system that stays
upstream-mergeable per AGENTS.md (additive modules + minimal seams).

## Design pillars

1. **A subagent is a real pi session** (opencode). In-process `AgentSession` (omp proved this
   scales; pi's audit confirms instance scoping), persisted via `SessionManager.create(cwd, dir,
   { parentSession })` so lineage, resume, cost attribution, and tree UI come free. Ephemeral
   agents use `SessionManager.inMemory()`.
2. **Spawn once, converse forever** (omp). Lifecycle `running → idle → parked → revived`, not
   fire-and-forget. Finished agents stay addressable; messaging a parked agent revives it from
   its session file.
3. **Result-only returns with handles** (delegate.ts, promoted to core — best-in-class per the
   research doc). Parent gets last-assistant-text + usage trailer, inline-capped (~4k chars);
   full output spills to an artifact addressable as `agent://<id>` with JSON-path/regex
   selective pull (`agent://<id>/findings.0.file`).
4. **Context rot is fought at every boundary** (all three): blank-start children (no parent
   history), per-agent context slimming (`omitProjectContext` — Claude Code's omitClaudeMd),
   thinking disabled for one-shot workers, capped tool-output capture, cache-stable agent
   listing (delta attachments, not tool-schema mutation), and a side-completion API for
   summaries that never touches the transcript.
5. **One wire shape** (omp pitfall). A single `agent` tool with an array `tasks` param — no
   batch/flat mode switch, no permissive dual parsing.
6. **Everything is data, not env vars** (delegate.ts lesson). Depth, spawn policy, tool
   allowlist, plan-mode read-only ride typed spawn options on the child session — in-process
   children make env scrubbing and `PI_DELEGATE_*` vars obsolete.

## Agent definitions

Markdown + YAML frontmatter, body = system prompt. Lenient parsing (opencode: unknown keys
collected, never fatal for user files), **case-insensitive name lookup** (omp shipped a
capitalized `Tester` nobody could spawn).

Storage precedence (first wins): project `.pi/agents/*.md` → user `~/.pi/agent/agents/*.md` →
bundled. Loaded through ResourceLoader as a first-class resource type (gap #2), so packages and
extensions can also ship agents.

```yaml
---
name: reviewer               # required; the agent type
description: >               # required; the ROUTING text the parent model sees.
  Use after any non-trivial diff. Proactively review for correctness.
tools: read, grep, find, lsp # allowlist; '*' = all; task-spawning NOT inherited by default
spawns: explore              # child spawn policy: '*' | none (default) | CSV allowlist
model: pi/slow               # model id, provider/model, or role alias (pi/smol, pi/slow, …)
thinkingLevel: high
maxTurns: 40                 # soft budget; final turn forces text-only wrap-up (opencode)
background: false            # spawn async by default
isolation: none              # none | worktree (auto-clean if unchanged — Claude Code)
omitProjectContext: true     # drop AGENTS.md/context files for token diet (Explore-style)
output:                      # optional structured-output schema (omp yield contract)
  type: object
  properties: { summary: {type: string}, findings: {type: array} }
color: cyan                  # UI pill color
---
You are a code reviewer... (system prompt body)
```

**Model roles**: a small `model-roles` map in settings (`agents.roles: { smol: [...], slow:
[...], plan: [...] }` with priority chains, omp-style) resolved through the existing
ModelRegistry/model-resolver. This is the "AI team with different models per subagent type"
axis: every agent type pins a role or model; settings override per-type via
`agents.modelOverrides: Record<string, string>`.

**Bundled agents**: `explore` (read-only scout, smol model, omitProjectContext), `plan`
(read-only architect), `worker` (general implementer, spawns: '*'), `reviewer` (structured
findings). Internal LLM jobs (compaction summary, branch summary, chain judge) become hidden
agents too (opencode) so users can override their models.

## The `agent` tool

```ts
{
  context?: string,          // shared briefing rendered into every child's system prompt
  tasks: [{
    agent?: string,          // default "worker"
    description: string,     // 3-5 words, UI-only
    prompt: string,          // the full assignment (never sees parent history)
    model?: string,          // override; alias matching parent tier reuses parent's exact model
    background?: boolean,
    isolation?: "worktree",
    name?: string,           // makes the agent addressable by name in agent_message
  }]
}
```

- Tool description is **dynamic**: enumerates `- name: description` for agents the caller may
  spawn (Claude Code / opencode), emitted as a stable block; when definitions change
  mid-session, re-announce via a system-reminder message, never by mutating the tool schema
  (cache stability — Claude Code measured 10.2% of fleet cache-creation tokens from that
  mistake).
- Sync tasks stream in the parent turn; a running foreground task can be **promoted to
  background** with one keypress (opencode/Claude Code). Background completion is injected as
  a visible `<task-notification>` user-role message and triggers an immediate parent turn (or
  a follow-up when the parent is already streaming).
- **Recursion guards**: `spawns` allowlist per agent (default none), depth cap
  (`agents.maxDepth`, default 2) carried on the child session options, self-spawn ban by type.
  Plan-mode parents spawn read-only children with spawns cleared (delegate.ts, both-sides
  enforcement now unnecessary — one enforcement point in core).
- **Concurrency**: per-session semaphore `agents.maxConcurrency` (default 8), re-read on
  change (omp's read-once Semaphore was a bug).
- **Prompt guidance baked into the tool** (Claude Code): "brief like a smart colleague",
  "never delegate understanding", parallel = multiple tasks in one call, results invisible to
  user so parent must summarize.

## Lifecycle & registry

Extend `BackgroundProcessRegistry` into the agent control plane (it was designed for this):
- New fields per entry: `tokens`, `costUsd`, `requests`, `contextPct`, `resultHandle`,
  `sessionFile`, `parentId`, `agentType`; new capabilities: `kill()`, `steer(text)`,
  `attach()` (live event stream for UI).
- Statuses gain `idle` and `parked`. Idle TTL (default 7 min) parks: session disposed, file
  kept; revival reopens the JSONL (single-writer). Registry survives across the parent's
  session switches; abandoned running agents are cancelled by the existing
  runtime-invalidation sweep.
- UI: BackgroundStatusWidget already shows running agents below the prompt; BackgroundLogPanel
  grows into an **Agent Hub** (roster → per-agent chat view with steer input, `x` kill,
  `r` revive — omp's hub, reusing our overlay seam). Retry states surface as "blocked:
  rate-limited" (omp's operational lesson).

## A2A messaging

`agent_message` tool (parent and children get it automatically when peers exist — availability
is **derived, not configured**, omp):

```ts
{ to: string | "*",          // name, id, or broadcast
  message: string,
  await?: boolean,           // wait for a reply (with timeout + deadlock escape hatch)
}
```

Delivery semantics (omp's, the best of the three):
- **running** recipient → non-interrupting aside at its next step boundary
- **idle** → woken with a real turn
- **parked** → revived from disk, then delivered
- Parent is addressable as `main`. Roster + etiquette rendered into child system prompts.
- Mailbox cap with explicit overflow notice (silent drops are omp's acknowledged mistake).

In-process children make this cheap: parent→child = `session.steer()`, child→parent =
`sendMessage` custom messages. No file mailboxes (a2a.ts retires).

## Chains (declarative orchestration)

`.pi/chains/*.yaml` (delegate.ts precedent, made first-class). "Nice-looking" both in config
and in the TUI:

```yaml
name: feature-flow
description: Plan → implement → review, with a verify gate
stages:
  - id: plan
    agent: plan
    prompt: "Design: {{input}}"
  - id: build
    agent: worker
    model: pi/slow            # per-stage model override
    prompt: "Implement this plan:\n{{plan.result}}"   # handle interpolation
    verify: "npm run check"   # shell gate; failure feeds back, max_iters retries
  - id: review
    agent: reviewer
    prompt: "Review the diff. Plan was: {{plan.handle}}"  # pass by handle, not inline
    parallel_with: []         # stages with no deps run concurrently
```

- Stage outputs pass as **handles** (`agent://<id>`), interpolated inline only when small.
- Verify ladder per stage: shell gate → adversarial "real vs gamed" judge (delegate.ts's
  `drive()` loop, kept — it worked).
- Runner is deterministic core code (not model-driven), stages spawn through the same `agent`
  tool path, so the Hub/status widget show chain progress as a grouped tree; a `ChainCard`
  component renders stage boxes with status glyphs.
- Invocable as `/chain feature-flow <input>` and from the `agent` tool.

## Teams

The research doc flags live swarms as a weak signal (experimental in Claude Code, absent
elsewhere) — so teams land in two tiers:

1. **Team presets (now)**: `.pi/teams/*.yaml` — a named roster binding agent types to models,
   default context, and a coordinator prompt style. `pi --team fast-review` or `/team` applies
   it: model overrides per type, which agents are spawnable, chain defaults. This is the
   "different model for different type of subagents" ask, as configuration.
2. **Live teams (later, behind a setting)**: shared task list + A2A roster + idle
   notifications (Claude Code teams). The A2A layer above is designed so this tier is additive.

## Context-rot toolkit (cross-cutting)

- Blank-start children; `context` field is the only inherited briefing.
- Inline return cap + spill handles; capture caps (500KB/5k lines, env-tunable).
- `omitProjectContext` per agent; thinking off for one-shot workers.
- **Side-completion API** (gap #7, named by handoff.ts): `session.sideRequest(prompt)` — an
  aux LLM call on the current cached prefix that never enters the transcript. Powers: 30s
  activity summaries for agent cards (Claude Code's summarizer), chain judges, handoff docs.
- Compaction reuse: `generateSummary` collapses a child transcript into a parent-facing
  result; branch summarization folds abandoned child branches.
- Fork-style spawn (later): child inherits parent context with placeholder tool results so
  sibling forks share an API cache prefix (Claude Code's standout trick) — worth adding once
  the base system is stable.

## Implementation phases (all additive modules per AGENTS.md)

| Phase | Scope | New modules |
|---|---|---|
| 1 | Agent defs loader, `agent` tool (sync+background, in-process child sessions), registry control-plane fields, result caps + `agent://` handles, spawn policy/depth | `core/agents/{definitions,spawn,handles}.ts`, `core/tools/agent.ts` |
| 2 | Lifecycle (idle/park/revive), `agent_message` A2A, Agent Hub UI, task-notifications | `core/agents/{lifecycle,messaging}.ts`, `components/agent-hub.ts` |
| 3 | Chains: YAML loader, runner, verify gates, ChainCard TUI, `/chain` | `core/agents/chains.ts`, `components/chain-card.ts` |
| 4 | Team presets, model roles UI, side-completion API, per-agent memory, fork spawns | `core/agents/{teams,side-request}.ts` |

Seam inventory needed from upstream files (all hook-sized): tool registration entry (exists),
`registerBackgroundTask` (exists), a `session.sideRequest` seam on AgentSession (new, phase 4),
resource-type registration in ResourceLoader (one entry), interactive-mode wiring lines for the
Hub (mirrors BackgroundLogPanel).

## Pitfalls ledger (from the research — do not repeat)

- omp: case-sensitive agent lookup; dual wire shapes + args-repair layer; read-once config
  (semaphore/blocking flags); vestigial naming after architecture pivots; process-global
  singletons without multi-session story; strict-mode schema contortions bolted on late;
  silent mailbox drops.
- opencode: no cross-session cost budget (add `agents.maxCostUsd` per spawn tree).
- Claude Code: agent list inside the tool schema busts prompt cache; empty subagent output
  must be replaced with an explicit placeholder or some models end their turn confused.
