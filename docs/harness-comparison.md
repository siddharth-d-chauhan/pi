# Coding-agent harness comparison — opencode · omp · claude-code · our pi fork

Definitive cross-harness study (2026-07-12) to decide what our fork should adopt.
Four harnesses inventoried against 12 dimensions from real source. Evidence-backed;
file paths in the per-harness sections below.

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
- **claude-code** (Anthropic, leaked) — mature single-binary ink TUI. Coordinator mode
  (orchestrator + fresh-context workers), auto-dream memory consolidation, forked
  subagents (cache-shared prefix), rich hooks, cron, PR subscriptions. Prompt-craft is
  best-in-class.
- **our pi fork** — extension-first (34 extensions, minimal core edits) + a governed
  Python memory service (KP, Graphiti/FalkorDB). Verified-convergence loop (criteria →
  review → gate → best-of-n) with two-tier self-optimization, executable procedural
  memory (devbrain), full memory taxonomy (semantic/procedural/working/episodic/prospective)
  under one `/recall`, governed propose-first writes, area-drift context injection.

## Comparison matrix (◐ = partial)

| Dimension | opencode | omp | claude-code | our pi fork |
|---|---|---|---|---|
| Runtime | Bun/TS + Effect | Bun/TS + **Rust core** | Node/TS + ink | Bun/TS (pi base) |
| Architecture | **client-server + SDKs** | monolith TUI | monolith TUI | monolith TUI + MCP memory svc |
| Core loop | gather→act (no verify) | gather→act + advisor | gather→act (coordinator) | **gather→act→verify (loop)** |
| Edit strategy | **9-strategy fuzzy replacer + patch** | **AST (tree-sitter) + hash-anchored** | line-based | line/anchor (pi) |
| Orchestration | 1-level task delegation | **IRC agent-bus + revivable agents** (swarm YAML on top) | **coordinator + workers** | **verified loop + chains** |
| Subagent isolation | child session | **CoW fs clone (8 backends)** | worktree/remote/**fork** | worktree (via agent tool) |
| Memory | ✗ (instruction files) | **mnemopi (research-grade) + 3 more** | 5 subsystems (memdir/dream/extract/session/team-sync) | **KP governed graph + full taxonomy** |
| Memory retrieval | lexical only | **4-voice RRF + hybrid + graph** | file recall | hot-FTS + semantic + graph, `/recall` |
| Compaction | structured summary | **snapcompact (bitmap images)** | microcompact | pi built-in + topic/scope gating |
| Extensibility | ~20 hooks + code-mode | unified ext + marketplace | hooks + skills + MCP | 34 exts + MCP + slash-seam |
| Providers | ~19 (AI SDK) + zen gateway | **~72 + auth-broker** | Anthropic-first | pi registry (multi) |
| Safety | **rule engine + doom-loop** | approval tiers + **advisor-watchdog** | allow/deny + hooks | **KP pre-action gate + advisories** |
| Scheduling | ✗ | ◐ | **cron + PR subs** | **/every + /intend + /dream** |
| Self-improvement | ✗ | ◐ (local skill-gen) | dream (memory only) | **loop GEPA (online+offline, measured)** |
| Multi-surface | **desktop/VSCode/Zed/Slack/web** | ◐ collab-web | VS Code panel | ✗ |

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

**claude-code** — the *craft*. Coordinator mode's doctrine (always-synthesize, per-worker
purpose statements, continue-vs-spawn) is the clearest articulation of orchestration prompt-craft
anywhere. **Forked subagents** share a byte-identical prompt-cache prefix (cheap parallel fan-out).
Auto-dream memory consolidation (orient→gather→consolidate→prune). LLM-generated agent definitions.
Rich hook surface, cron scheduling, PR-activity subscriptions, worktree/remote isolation.

**our pi fork** — the *verification + memory governance*. The only harness whose loop
**mechanically gates "done"**: criteria.json (done-as-data) → independent diverse-model review →
devbrain execution gate → best-of-n on repeated rejection, with two-tier GEPA self-optimization
(online prompt-rewrite + offline distillation, measured recurrence). **devbrain** =
executable procedural memory with typed triage (env/flake/product_bug). Full memory taxonomy
unified under `/recall`. **Governed memory** — every write is propose-first, evidence-gated
(user→confirmed, machine→supported, model→proposed); memory can't be silently corrupted.
Area-drift context injection with cross-channel dedup and KV-cache discipline.

## What our fork already leads on (don't chase)

- **Verified-done loop** — nobody else mechanically gates completion. opencode/omp/claude
  all rely on the model choosing to verify. Keep and deepen.
- **Governed, evidence-gated memory writes** — omp's mnemopi is more *sophisticated* at
  storage/recall, but writes are ungoverned; ours can't be corrupted by a bad inference.
- **Executable procedural memory (devbrain)** — unique; nobody has verify-blocks as memory.
- **Two-tier measured self-optimization** — claude-dream consolidates memory but doesn't
  optimize prompts against a metric; ours does, with before/after recurrence numbers.
- **Prospective memory** (`/intend` event + `/every` time) — only claude has cron; nobody
  else has event-triggered future intentions.

## Include decision — ranked (what to adopt, and why)

### Tier 1 — high value, fits our architecture, clear win

0. **Hashline edit format (from omp `packages/hashline`) — the new #1.** Content-hash-anchored
   line patches: each file section headed `[PATH#TAG]` (4-hex hash of normalized content); ops
   name original line numbers and supply only new text (the model never retypes context lines);
   **stale anchors are rejected before applying**, killing the "string not found"/whitespace
   retry loops. omp's own TS edit benchmark proves the *format*, not the model, drives edit
   reliability: Grok Code Fast 1 **6.7% → 68.3%**, MiniMax **2.1×**, Grok 4 Fast **−61% tokens**.
   That is our exact "strong harness makes a weak model reliable" thesis, and it's a **format
   change** (TS + a lark grammar) — far cheaper than native adoption, works with any model. Ship
   as a new `edit` mode with per-model fallback. **Highest leverage on the whole list.**
1. **AST-based editing via a native engine (from omp `pi-ast`).** Complements hashline (its
   `.BLK` block ops already use tree-sitter). tree-sitter-accurate across 57 languages with
   overlap rejection and staged-flush atomicity. Path: consume `@oh-my-pi/pi-natives` (published
   npm addon) or the `pi-ast` crate as an optional native accelerator behind a JS fallback.
2. **Copy-on-write task sandboxing (from omp `pi-iso`).** Our loop workers use git worktrees;
   `pi-iso` gives cheap CoW clones with git-apply-ready diffs across 8 fs backends — better
   isolation for best-of-n candidate workers and safer autonomous runs. Pairs naturally with
   the loop. Same native-addon adoption path as #1.
3. **Advisor-watchdog (from omp).** A second LLM reviewing every turn and injecting
   severity-tagged advice complements our loop review (which only fires on done-claims). A
   continuous critic catches drift mid-work. We have the steer/context seams already; this is
   an extension, ~a day. Reuse our diverse-model + governed patterns.
4. **doom-loop guard + bash arity-permissioning (from opencode).** Two cheap safety guards:
   (a) same tool + identical input repeated → intervene (trivial in our tool_call hook;
   catches thrash our loop budget only sees at round granularity — **cheapest win**);
   (b) arity-permissioning extracts the human-meaningful command prefix (`git status` vs
   `git push` — an LLM-generated arity dictionary, longest-prefix-wins) so allow/deny is
   per-subcommand not per-opaque-string — a real upgrade to our KP pre-action gate.

### Tier 2 — valuable, more effort or narrower

5. **Richer recall ranking (from omp mnemopi).** We have hot-FTS + semantic + graph but a
   simple blend; omp's RRF multi-voice fusion (esp. the graph-traversal voice) and per-type
   decay are measurably better retrieval. Adopt the *ideas* (RRF fusion over our existing
   lanes; recency/type weighting) into KP's `context_task`, not the whole engine — our
   governance model is the thing to keep.
6. **snapcompact bitmap compaction (from omp).** Genuinely novel and cheaper for vision
   models, but it's a big self-contained system and our compaction is pi-inherited and fine.
   Adopt only if compaction cost becomes a measured problem. **Watch, don't build yet.**
7. **ACP editor integration (from opencode).** Lets Zed/other editors drive our fork. High
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
1. **doom-loop guard** (hours) — immediate thrash protection.
2. **Native addon adoption** → unlocks **AST editing (#1)** and **CoW sandboxing (#2)** together
   (they share the `pi-natives` boundary). Biggest capability jump.
3. **Advisor-watchdog (#3)** — continuous critic, reuses our review/steer machinery.
4. **RRF recall ranking (#5)** — retrieval quality, inside KP, keeps governance.

Everything else is watch-or-skip. The through-line: adopt omp's *native engineering* (AST,
sandbox) and *continuous critique* (watchdog), take opencode's *cheap safety guard*, borrow
*recall ideas* not engines — and keep our differentiators (verified-done loop, governed
memory, executable procedural memory, self-optimization) exactly as they are, because on those
axes we already lead the field.

## Coverage status — what's covered, partial, and not checked

All the parallel agents eventually reported (the session-limit ones finished late),
so coverage is far more complete than mid-sweep. Honest final state:

**Fully covered (exhaustive, mechanism-level, source-cited):**
- **opencode** — all 12 dimensions (core loop v1+v2, 9-strategy fuzzy edit + apply_patch,
  task delegation, instruction-file memory, compaction/Context-Epochs, plugins/MCP/code-mode,
  SolidJS+opentui TUI + multi-surface, ~20 provider IDs / route decomposition, rule-engine +
  doom-loop + arity permissioning, snapshots/GH-action).
- **omp** — memory/mnemopi (deep), compaction/snapcompact, context-files/handoff/collab,
  extensions/approval/providers, Rust crates (pi-ast/pi-shell/pi-iso/pi-walker), IRC agent-bus +
  revivable-agent runtime, hashline edit format, goals/TTSR/eval/LSP-diagnostics, tool system.
- **claude-code** — AgentTool/subagent internals, tool system + edit (with corrections), the
  5 memory subsystems, hooks (4 persistable types)/plugins/MCP/skills, permissions/sandbox
  (external sandbox-runtime, YOLO classifier), coordinator mode.

**Partial (known from earlier direct exploration this session, NOT freshly source-verified):**
- **claude-code providers/model-routing** — `useMainLoopModel`, fast mode, provider support:
  known in outline, not deeply inventoried.
- **claude-code TUI details** — ink rendering, footer/pills, Shift+Down task dialog, statusline:
  known in outline.
- **claude-code automation depth** — `ScheduleCronTool`, PR-activity subscriptions, RemoteTrigger,
  insights: known that they exist (we borrowed the /loop cron idea), but the dedicated automation
  agent timed out with no report, so mechanisms aren't source-cited.
- **omp session mechanics from docs not source** — goal/plan-mode, /tree, steering queue, TUI
  append-only renderer: covered from omp's docs, fewer line-level source citations than the rest.

**Not checked at all — and the one that matters:**
- **Adoption feasibility of the Tier-1 winners.** Can `packages/hashline` (the #1 recommend) and
  `@oh-my-pi/pi-natives` (`pi-ast`/`pi-iso`) be consumed **standalone against OUR pi base**?
  Unverified: hashline's coupling to omp internals (does it need `pi-ast` for `.BLK` block ops,
  or is the hash-anchoring self-contained?), the native addon's napi version / prebuilts /
  platform matrix / license, and whether the JS API (`astEdit`, `isoStart/Stop/Diff`) is usable
  without the whole omp coding-agent. **This gates whether the top recommendations are a week of
  work or a non-starter — do this check first.**

**Not persisted anywhere durable:** the individual exhaustive per-harness inventories (mnemopi
schema, Rust-crate mechanisms, opencode route decomposition, claude-code hook contract) live only
in this session's agent transcripts. This doc is the *synthesis*; if the raw deep-dives are worth
keeping, they'd need to be written out separately (not done — the synthesis captures the decisions).
