# Subagent research — how others do it

> Comparative survey of how external systems shape "subagent" features. Source-grounded: each row of the matrix ties to a real doc page or library read this session. Built so we can decide which axes to bring into pi (and which to leave alone).

**Methodology.** Read each reference page in full, then a second pass to verify the load-bearing claims (especially around inheritance, isolation, and lifecycle). [INFERENCE] marks anything I'm extrapolating from the surface area rather than seeing verbatim.

**Scope.** Three reference classes:
1. **Shipped CLI tools** (how end-users actually call subagents).
2. **Library / SDK designs** (how integrators compose them).
3. **Existing-in-pi** (where the `delegate.ts` and `subagent/` extensions sit).

---

## §0. Scope honesty (what was *not* read for this survey)

The body of this doc is grounded in primary-source reads of:
- Claude Code subagents / agent view / SDK
- OpenAI Agents SDK (handoffs)
- LangChain / LangGraph subagents
- **CrewAI** (crews + processes — `docs.crewai.com/v1.15.2/en/concepts/{crews,processes}`, partially read; v1.15.2 docs index, plus the two concept pages)
- **AutoGen** (AgentChat quickstart + SelectorGroupChat — `microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/{quickstart,selector-group-chat}.html`, partially read)
- pi's own `subagent/` and `delegate.ts`

**Not covered in depth despite being on the original research list:**
- **Aider** (`--subagent` flag) — *not read*.
- **OpenHands** (runtime agent hierarchy, workspace isolation) — *not read*.
- **OpenAI Codex CLI agent mode** — *not read*.
- **Google Gemini CLI agent mode** — *not read*.
- **SWE-agent** delegation loops — *not read*.
- **Cursor / Composer** — *not read.*
The five reference systems in the table below cover the **library angle** (OpenAI, LangChain, AutoGen, CrewAI) and the **shipped-CLI angle** (Claude Code). The remainder is genuinely outside the survey; do not assume the comparative claims in §7-§8 apply to e.g. Aider or OpenHands. If those become design targets, primary reads are needed before any compatibility claim.

The **Microsoft AutoGen GroupChat landing page** (`microsoft.github.io/autogen/dev/user-guide/core-user-guide/framework/group-chat.html`) returned **HTTP 404** during this session — the canonical concept appears to live under `agentchat-user-guide/teams.html` or `core-user-guide/design-patterns/group-chat.html`. If you need the older Core-API group chat design, fetch those two URLs first.

---

## §1. The five reference systems

| System | Class | Where to read |
|---|---|---|
| **Claude Code subagents** | shipped CLI | [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents); [code.claude.com/docs/en/agents](https://code.claude.com/docs/en/agents); [code.claude.com/docs/en/agent-sdk/subagents](https://code.claude.com/docs/en/agent-sdk/subagents) |
| **Claude Code agent view / agent teams / dynamic workflows** | shipped CLI | [code.claude.com/docs/en/agents](https://code.claude.com/docs/en/agents) (single page) |
| **OpenAI Agents SDK — Handoffs** | library | [openai.github.io/openai-agents-python/handoffs/](https://openai.github.io/openai-agents-python/handoffs/) |
| **LangChain / LangGraph — Subagents** | library | [docs.langchain.com/oss/python/langchain/multi-agent/subagents](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents) |
| **pi + pi-harness `delegate.ts`** | existing-in-pi | `packages/coding-agent/examples/extensions/{subagent/,pi-harness/extensions/delegate.ts}` |

The Claude Code page alone collapses three productised shapes ("subagents," "agent view," "agent teams," plus "dynamic workflows") with a single sentence of contrast each, which is a useful taxonomy. I'll keep that taxonomy.

---

## §2. Claude Code's four coordination shapes

From `code.claude.com/docs/en/agents`, **in the same single session**:

> "Subagents, agent view, agent teams, and dynamic workflows each parallelize work in a different way. The right one depends on whether you want to stay in each conversation yourself, hand tasks off and check back later, or have Claude coordinate a group of workers for you."

| Approach | What it gives you | Used when |
|---|---|---|
| **Subagents** | Delegated workers inside one session that do a side task in their own context and return a summary | A side task would flood your main conversation with search results, logs, or file contents you won't reference again |
| **Agent view** | One screen to dispatch and monitor sessions running in the background, opened with `claude agents`. Research preview | You have several independent tasks and want to hand them off, check status at a glance, and step in only when one needs you |
| **Agent teams** | Multiple coordinated sessions with a shared task list and inter-agent messaging, managed by a lead. Experimental, default-disabled | You want Claude to split a project into pieces, assign them, and keep the workers in sync |
| **Dynamic workflows** | A script that runs many subagents and cross-checks their results, for work too big to coordinate one turn at a time | A job outgrows a handful of subagents, or you want findings verified against each other: codebase-wide audit, 500-file migration, cross-checked research |

**Workers are Claude sessions in every approach.** To involve a different tool, expose it as an MCP server (Claude Code's MCP docs). Two more features work alongside but are not coordination shapes themselves:
- **Worktrees** give each session a separate git checkout, so parallel sessions never edit the same files. Subagents and sessions you run yourself can each use one. Agent view moves each dispatched session into its own worktree **automatically**.
- **`/batch`** is a skill that splits one large change into 5-30 worktree-isolated subagents that each open a PR.

Two things that **aren't** subagents:
- **Background bash command** runs one shell command without blocking. Doesn't spawn an agent.
- **Forked subagent** is a subagent that *inherits* your full conversation context. Same surface, different inheritance.

### The decision tree (verbatim from the page)

The "Choose an approach" section spells out the fork:

> *Who coordinates the work?*
> - Claude delegates and collects results inside one conversation: **subagents**.
> - You hand off independent tasks and check back later: **agent view**.
> - Claude plans, assigns, and supervises a group of workers: **agent teams** (experimental, default disabled).
> - A script holds the plan instead of Claude's turn-by-turn judgment: **dynamic workflows**.
>
> *Do the workers need to talk to each other?* Subagents report results back to the conversation that spawned them; agent view sessions report only to you. Teammates in an agent team share a task list and message each other directly.
>
> *Do the tasks touch the same files?* Isolate with worktrees. Agent teams don't isolate teammates, so **partition the work** so each teammate owns a different set of files.

### Monitoring surface (also verbatim)

> For background sessions, `claude agents` opens agent view: one screen showing every session, its state, and which ones need your input.
> For subagents in the current session, named background subagents appear in the @-mention typeahead with their status. (v2.1.198+) `/agents` no longer opens a panel; it prints a notice pointing to subagent file locations. Despite the similar name, `/agents` is separate from `claude agents`.
> For anything running in the background of the current session, `/tasks` lists each item and lets you check on, attach to, or stop it.
> For dynamic workflows, `/workflows` lists running and completed runs, the phase each is in, and how many agents have finished.

**Implication for pi.** This is the *user-facing* surface Claude Code built: a per-class panel (`claude agents` vs `/tasks` vs `/workflows`) that maps 1-to-1 to the underlying shape. pi's `BackgroundLogPanel` (consumed by the empty-state down-arrow) is **one of these surfaces folded into one** — that single panel would need to grow into three to match Claude Code's UX.

---

## §3. Claude Code subagents — the shape pi would imitate

From `code.claude.com/docs/en/sub-agents`:

> "Subagents are specialized AI assistants that handle specific types of tasks. Use one when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary."

### 3.1 Built-in vs custom

Three built-ins ship and inherit the parent's permissions with additional restrictions:

| Agent | Model | Tools | Purpose |
|---|---|---|---|
| **Explore** | inherits; capped at Opus on Claude API | read-only | file discovery, code search |
| **Plan** | inherits | read-only | pre-planning research |
| **General-purpose** | inherits | all | complex multi-step exploration+action |

`Explore` and `Plan` skip CLAUDE.md and parent git status to stay cheap. As of v2.1.198, `Explore` inherits the main conversation's model (capped at Opus on Claude API; on Bedrock/Vertex/Foundry/AWS/Claude-on-AWS it inherits directly without a cap).

**Custom subagents** are markdown files in `.claude/agents/<name>.md` (project) or `~/.claude/agents/<name>.md` (user), with YAML frontmatter + body. Built-ins can be disabled:
- `permissions.deny` blocks specific kinds.
- Deny the `Agent` tool itself to block **all** subagents.
- `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` removes Explore and Plan; Claude reads files directly.
- Non-interactive / SDK: `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes **all** built-ins.

Subagent definitions are also discoverable from plugins (`plugin/agents/<file>.md` registers as `plugin-name:<dir>:<name>`).

### 3.2 Scope and loading order (verbatim priority table)

| Priority | Location | Scope |
|---|---|---|
| 1 (highest) | Managed settings | Org-wide |
| 2 | `--agents` CLI flag | Current session |
| 3 | `.claude/agents/` | Current project |
| 4 | `~/.claude/agents/` | All your projects |
| 5 (lowest) | Plugin `agents/` | Where plugin is enabled |

Project subagents are discovered by walking up from cwd. A user-or-project subagent named `Explore` overrides the built-in and keeps its own `model` field, so `model: haiku` keeps exploration on cheap.

### 3.3 Frontmatter (the contract)

Only `name` and `description` are required. The full set of fields:

| Field | Required | What |
|---|---|---|
| `name` | ✓ | lowercase + hyphens. Hooks get this as `agent_type` |
| `description` | ✓ | When to delegate to this subagent |
| `tools` | | Allowed tool list; inherits all if omitted |
| `disallowedTools` | | Subtract from inherited or specified list |
| `model` | | `sonnet` / `opus` / `haiku` / `fable` / full id / `inherit`. Defaults to inherit |
| `permissionMode` | | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual` |
| `maxTurns` | | Cap on agentic turns |
| `skills` | | Preload skill content into context |
| `mcpServers` | | Per-agent MCP servers |
| `hooks` | | Per-subagent hooks (`SubagentStart` etc.) |
| `memory` | | `user` / `project` / `local` |
| `background` | | Always run as background task |
| `effort` | | `low` / `medium` / `high` / `xhigh` / `max` |
| `isolation` | | `worktree` — spawn in a temp git worktree |
| `color` | | Display color in task list |
| `initialPrompt` | | Auto-submitted when run as the main session agent |

**Plugin subagents cannot have `hooks`, `mcpServers`, or `permissionMode`** — those fields are ignored. Documented security choice.

### 3.4 What a subagent inherits (verbatim)

| Receives | Does NOT receive |
|---|---|
| Its own system prompt (`AgentDefinition.prompt`) + the Agent tool's prompt | Parent's conversation history or tool results |
| Project CLAUDE.md (loaded via `settingSources`) | Preloaded skill content unless listed in `AgentDefinition.skills` |
| Tool definitions (inherited, or subset in `tools`) | Parent's system prompt |

The only channel from parent to subagent is the Agent tool's prompt string — file paths, errors, decisions need to be inlined.

> "The parent receives the subagent's final message verbatim as the Agent tool result, but may summarize it in its own response. To preserve subagent output verbatim in the user-facing response, include an instruction to do so in the prompt or `systemPrompt` option you pass to the main `query()` call."

API errors: rate limits and overload never replace the subagent's result. If the subagent produced text, that text is returned with a "didn't finish" note. If it produced nothing, an error is returned (`Agent terminated early due to an API error`).

### 3.5 Invocation: automatic vs explicit

Two ways:
- **Automatic**: Claude picks based on `description` matching.
- **Explicit**: "Use the code-reviewer agent to check the authentication module".

### 3.6 Sync vs background (the v2.1.198 switch)

> "Two subagent behaviors changed in Claude Code v2.1.198:
> - Subagents run in the background **by default**. An Agent tool call that omits the `run_in_background` input launches a background subagent, and Claude sets `run_in_background: false` when it needs the result before continuing. Before v2.1.198, omitting `run_in_background` ran the subagent synchronously. Set the `background` field to `true` to force background execution for a specific agent regardless of what Claude requests.
> - A subagent inherits the main session's extended thinking configuration. On earlier versions, extended thinking is disabled inside subagents regardless of the main session's setting."

Three further rules:
- **`isolation: worktree`** gives the subagent a temp git worktree branched from the **default branch**, not parent HEAD. Worktree is auto-cleaned if the subagent doesn't change anything.
- **Nested subagents** (v2.1.172+): a subagent can spawn its own subagents. **Five-level depth cap** regardless of foreground or background.
- Omit `Agent` from `tools` (or add to `disallowedTools`) to prevent further spawning at all.

### 3.7 Built-in monitoring surface (also verbatim)

> "Named background subagents appear in the @-mention typeahead with their status. As of v2.1.198 `/agents` no longer opens a panel; it prints a notice pointing to the subagent file locations."
> "For anything running in the background of the current session, `/tasks` lists each item and lets you check on, attach to, or stop it."

[INFERENCE] pi's `BackgroundProcessRegistry` was reserved for exactly this kind of `/tasks`-shaped UI — see `background-process-registry.ts:5-23` quote in §6.

---

## §4. OpenAI Agents SDK — Handoffs

From `openai.github.io/openai-agents-python/handoffs/`:

> "Handoffs allow an agent to delegate tasks to another agent. This is particularly useful in scenarios where different agents specialize in distinct areas."
> "Handoffs are represented as **tools** to the LLM. So if there's a handoff to an agent named `Refund Agent`, the tool would be called `transfer_to_refund_agent`."

The `handoff()` function is the only way to declare one. Its named params:
- `agent` — destination
- `tool_name_override` — default `transfer_to_<snake_case_name>`
- `tool_description_override`
- `on_handoff(ctx, [input_data])` — fires when invoked; can kick off data fetch side-effects
- `input_type` — Pydantic model, schema exposed to model as tool parameters, JSON validated locally, parsed value passed to `on_handoff`
- `input_filter` — replaces `HandoffInputData` to control what the receiving agent sees
- `is_enabled` — runtime gate (callable)
- `nest_handoff_history` — opt-in to collapsed history nesting per call

### 4.1 Input type vs input filter vs context (cleanly separated)

- **`input_type`** — model-generated metadata at handoff time (reason, language, priority). One handoff per destination; doesn't dispatch.
- **`input_filter`** — wipes or trims the new agent's history. Built-in helpers in `agents.extensions.handoff_filters` like `remove_all_tools`.
- **`RunContextWrapper.context`** — application state you already have. Not for model-decided metadata.

### 4.2 What the receiver sees

By default: full input history. To compress, use `input_filter` or `RunConfig.nest_handoff_history` (beta). When enabled, the runner collapses the prior transcript into a single assistant summary wrapped in `<CONVERSATION HISTORY>` that keeps appending on subsequent handoffs. `set_conversation_history_wrappers` / `reset_conversation_history_wrappers` lets you change the wrapper text. Per-handoff `nest_handoff_history=True|False` overrides the run-level setting.

> "If both the handoff and the active `RunConfig.handoff_input_filter` define a filter, the per-handoff `input_filter` takes precedence for that specific handoff."

### 4.3 Guardrails

> "Handoffs stay within a single run. **Input guardrails still apply only to the first agent** in the chain, and **output guardrails only to the agent that produces the final output**. Use tool guardrails when you need checks around each custom function-tool call inside the workflow."

[INFERENCE] This is the sharpest single sentence about why handoffs and tool calls have different lifecycle hooks. Implication: if you build a multi-pi runtime in pi where subagents are tool calls, the `tool_call` extension hook should fire on each invocation. If you build subagents as session-tree branches (fork), the `session_before_fork` hook fires once.

### 4.4 The recommended prompt prefix

`agents.extensions.handoff_prompt.RECOMMENDED_PROMPT_PREFIX` is a string you should prepend to every agent that may be a handoff target. `prompt_with_handoff_instructions` injects it automatically.

[INFERENCE] This is the *only* library I've seen treat "prompt shape for handoff-targets" as a first-class concern. Worth copying: a deterministic prompt prefix is cheaper than asking each user to write one.

---

## §5. LangChain / LangGraph — Subagents

From `docs.langchain.com/oss/python/langchain/multi-agent/subagents`:

The central image: `User → Main Agent → {Subagent A, B, C}` with all results flowing back through the main agent. Terminology: "the **main agent** (often a **supervisor**) coordinates subagents by calling them as tools... Subagents are stateless — they don't remember past interactions, with all conversation memory maintained by the main agent."

> "Supervisor vs. Router: a supervisor agent (this pattern) is different from a router. The supervisor is a full agent that maintains conversation context and dynamically decides which subagents to call across multiple turns. A router is typically a single classification step that dispatches to agents without maintaining ongoing conversation state."

### 5.1 Sync vs async (their words, mine diagram)

| Mode | Main-agent behaviour | Best for | Tradeoff |
|---|---|---|---|
| **Sync** | Waits for each subagent to finish | Main needs result to continue | Simple, blocks conversation |
| **Async** | Kicks off background job, stays responsive | Independent tasks, user shouldn't wait | More complex |

Async takes the shape:
```
Main ──► job_system.run_agent(name, task) ──► returns job_id
Main ──► user "started (job_123)"
          [subagent runs]
User ──► Main ──► job_system.check_status(job_123) ──► "running"
User ──► Main ──► job_system.get_result(job_123) ──► analysis
```

Three tools when you compose this: `start_job` / `check_status` / `get_result`. The page notes "Not to be confused with Python's async/await. Here, 'async' means the main agent kicks off a background job (typically in a separate process or service) and continues without blocking."

### 5.2 Tool patterns

| Pattern | Best for | Tradeoff |
|---|---|---|
| **Tool-per-agent** | Fine-grained control over per-agent input/output | More setup, more customization |
| **Single dispatch tool** (`task(agent_name, description)`) | Many agents, distributed teams, convention over configuration | Less per-agent customization |

The single-dispatch tool is what `pi-harness/extensions/subagent/index.ts:460` ships. Note the LangChain version accepts `agent_name` and `description` as a single parameter; pi's takes the same shape plus `tasks`, `chain`, `agentScope`, `confirmProjectAgents`.

> "An interesting aspect of this approach is that sub-agents may have the exact same capabilities as the main agent. In such cases, invoking a sub-agent is **really about context isolation** as the primary reason — allowing complex, multi-step tasks to run in isolated context windows without bloating the main agent's conversation history. The sub-agent completes its work autonomously and returns only a concise summary, keeping the main thread focused and efficient."

### 5.3 Design decisions table (long, useful)

| Decision | Options |
|---|---|
| Sync vs async | Sync (blocking) or async (background). Mixing both in one run is normal — one tool may block, another may fire-and-forget |
| Tool patterns | Tool-per-agent or single-dispatch |
| Subagent specs | System prompt vs enum-constrained name vs tool-based discovery (single-dispatch only) |
| Subagent inputs | Query only (default) vs full context |
| Subagent outputs | Subagent's last message vs full conversation history |

The "outputs" decision is the one I think pi's `delegate.ts` is most interesting on — see §6. The default is "return last message." Returning full history is rare, expensive, and usually wrong.

### 5.4 When to choose what (verbatim)

Their decision matrix maps closely to Claude Code's:

| Need | Use |
|---|---|
| Central agent controls everything | Subagents |
| Worker agents return results to supervisor | Subagents |
| Multiple specialists called in parallel | Subagents or router |
| Specialist must talk to user directly | **Handoffs** |
| Active agent persists across turns | **Handoffs** |
| Sequential staged workflow | **Handoffs** |
| Simple classification then dispatch | Router |
| Built-in higher-level framework | Deep Agents |

**Insight.** "Specialist must talk to user directly" is the precise crossover point where subagents stop fitting and handoffs take over. In pi terms: if the parent LLM calls a `delegate` tool, that's a subagent. If the user types `/continue-with-debugger` and the session transfers to a new specialist, that's a handoff. pi has nothing like the latter today.

### 5.5 Recommended pattern (verbatim from LangChain docs)

> "For most new LangGraph/LangChain projects:
> 1. Start with the **subagents/supervisor-as-tool-caller** pattern.
> 2. Wrap each specialist agent as a tool.
> 3. Return only the specialist's final answer to avoid context bloat.
> 4. Use handoffs only if a specialist must become the active conversational agent.
> 5. Use `langgraph-supervisor` if you want prebuilt hierarchy/handoff helpers, but prefer manual tools if you need precise control over context engineering."

[INFERENCE] This is good institutional advice. It matches Anthropic's well. Adopt it.

---

## §6. pi's existing-in-pi surface

`packages/coding-agent/examples/extensions/{subagent/,pi-harness/extensions/delegate.ts}`. We have the full map in `/tmp/subagent-map.md` — this section is just the comparison-relevant bits.

### 6.1 `subagent/` example (off-the-shelf, shipped with pi)

- 1015 LoC in `index.ts` + 126 in `agents.ts` + 4 agent markdown files + 3 prompt templates.
- Tools: 3 modes — single / parallel / chain. **Limits**: `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `COLLAPSED_ITEM_COUNT=10`, `PER_TASK_OUTPUT_CAP=50*1024` (`:33-36`).
- Spawns `pi --mode json -p --no-session --append-system-prompt <tmp>` per call (`:294-296, :327`).
- Output: parses JSONL stdout, accumulates `result`, fires `onUpdate` per message_end/tool_result_end (`:355-376, 611-622`).
- Abort: SIGTERM then SIGKILL after 5s (`:400-408`).
- **Does NOT** register on `BackgroundProcessRegistry`. The empty-state down-arrow panel stays empty.

### 6.2 `pi-harness/extensions/delegate.ts` (richer)

- 768 LoC. Actions: `run_agent`, `run_chain`, `orchestrate`, `create_chain`, `list`, `pull`.
- **Kinds** (typed axis): `reviewer | debugger | implementer | refactorer | explorer | custom`. Each kind has a fixed model + toolset (`AGENT_KINDS` map at `:222-226`, `KIND_ALIAS` for synonyms at `:228-234`).
- **Verify** shell-command loops up to `MAX_ITERS=4` (`:135-138`).
- **Assert** runs adversarial audit (looks for `^REAL` vs `^GAMED`) — retry on failure (`:476-493`).
- **Chains** persist to `.pi/chains/<name>.yaml` (`:570-577`); plan-mode `plan:chain` event writes them (`:633-641`).
- **Recursion cap** `MAX_DEPTH=KP_DELEGATE_MAX_DEPTH` (default 2, `:144`). Depth rides in `PI_DELEGATE_DEPTH` (`:145`). At-cap children get `delegate` and `task` tools stripped (`:159 SPAWN_TOOLS`).
- **Self-recursion block**: `spawnGuard()` (`:355-365`) refuses if a kind would spawn its own name.
- **In-child lockdown** at `tool_call` seam (`:601-626`).
- **Env hardening** `hardenEnv()` (`:189-204`): strips provider credentials via `SECRET_ENV_RE` + `SECRET_ENV_EXACT`.
- **Read-only allowlist** for plan-mode-propagated children (`:163-169 READONLY_TOOLS`).
- **Externalized returns with handles** — `RETURN_MAX=8000` (`:77`), `pullHandle()` (`:105-133`) for selective recovery. **Better than anything in the libraries.**
- **DLC ledger hydration** renders the parent's discovery ledger into the child's system prompt so each stage starts hydrated (`:292-325`).

### 6.3 The empty slot

`packages/coding-agent/src/core/background-process-registry.ts:5-23`:
> "Today: no callers register. The registry is wired and ready; future subagent/parallel-tool/MCP work plugs in by calling `register()`."
>
> `BackgroundProcessKind = "subagent" | "delegation" | "mcp" | "shell-suspend" | "other"`

`BackgroundLogPanel` is the renderer. The empty-state down-arrow handler in `interactive-mode.ts` queries the registry. So the TUI plumbing is done; nothing fills it. The cost of registering here from a subagent extension is low; the payoff is the **first working `/tasks`-shaped UI in pi**.

### 6.4 What pi-harness has that the libraries don't

| Feature | pi-harness delegate.ts | Claude Code | OpenAI Agents SDK | LangChain |
|---|:-:|:-:|:-:|:-:|
| Externalized worker returns with selectable pull | ✓ | partial (`isolation: worktree` ≠ spill) | – | – |
| Adversarial audit (verify_work) as gate | ✓ (`assert`) | – | – | – |
| Plan-mode read-only propagation | ✓ (`READONLY_TOOLS`) | – | – | – |
| Self-recursion block by kind | ✓ | – | – | – |
| Pre-spawn env hardening | ✓ (`hardenEnv`) | – | – | – |
| Depth rides in `PI_DELEGATE_DEPTH` | ✓ | – | – | – |
| Persistent structured chains | ✓ (`.pi/chains/*.yaml`) | – | – | – |
| Pre-spawn panel of running subagents | – | ✓ (agent view, `/tasks`) | – | – |
| Auto-delegation by LLM matching description | – | ✓ | – (handoff via tool-call) | ✓ |
| Tool-restricted per-subagent | – | ✓ (frontmatter `tools`) | – | – (via `as_tool`) |
| Worktree isolation | – | ✓ (`isolation: worktree`) | – | – |
| Built-in Explore/Plan/General-purpose | – | ✓ | – | – |

### 6.5 What pi is missing relative to libraries

| Missing | Where to put it |
|---|---|
| Tool-restricted per-subagent (Claude Code's `tools:` frontmatter) | A `subagent/agents/*.md` frontmatter field that maps to `--tools <csv>` at spawn time |
| Auto-delegation (LLM picks by description) | Either keep `delegate` as a single tool whose params describe when to use it (LangChain style — already partly the case) or accept `description` per agent and have the parent LLM pick via Tool selection — Claude Code style |
| Persistent agent memory (`memory: user\|project\|local` field) | Would need a per-agent note store; pi's `~/.pi/agent/` directory is plausibly the location |
| Worktree isolation per subagent | Add `isolation: worktree\|none` frontmatter; spawn a fresh git worktree before `--append-system-prompt <tmp>` |
| Nested-subagent depth cap with explicit UI enforcement | Already partially there (`MAX_DEPTH`); the registry isn't seeing it though |
| `run_in_background: true\|false` per subagent | `pi-harness delegate.ts` already has the affordance implicit but no UI |

---

## §7. The axes that matter, ranked

Cross-cutting the four external surfaces, here are the design axes that diverge:

### 7.1 Spawn model — what runs the worker

| Choice | Cost | Examples |
|---|---|---|
| **Same process, separate message-list** | Free; no isolation | pi's `fork`; LangChain subagents |
| **Subprocess of the same binary** | One fork; same model provider | pi's `subagent/`, `delegate.ts` |
| **Sibling long-lived process** | Persistent; operator-supervised | pi's orchestrator |
| **Remote/managed runtime** | Cloud billing + coordination | Claude Code **routines** (Anthropic cloud), possibly Codex CLI |

[INFERENCE] Claude Code's "routines" is the only reference to managed-runtime subagents in this set.

### 7.2 Context isolation — what reaches the worker

| Choice | Mechanism |
|---|---|
| **No parent conversation** (clean window) | Default everywhere — Claude Code Agent tool, LangChain subagents, OpenAI handoffs (unless `input_filter` rewrites it) |
| **Filtered parent conversation** | OpenAI's `input_filter`; LangChain's `nest_handoff_history` |
| **Full parent conversation (forked)** | Claude Code "forked subagent" — same surface, different inheritance |
| **Worker → parent summary only** | The default everywhere except Claude Code which lets you preserve verbatim. |

### 7.3 Tool permissions

| Choice | Mechanism |
|---|---|
| **Inherit parent** | Most libraries' default |
| **Explicit allow-list** | Claude Code `tools:`, OpenAI `tools` on the agent |
| **Explicit deny-list** | Claude Code `disallowedTools`, OpenAI `disallowedTools` |
| **Read-only allow-list propagation** | pi-harness `READONLY_TOOLS` (we have this) |
| **Strip specific tools at depth cap** | pi-harness `SPAWN_TOOLS = ["delegate","task"]` (we have this) |

### 7.4 Lifecycle / depth cap

| Choice | Mechanism |
|---|---|
| **No cap** | Default |
| **Hard cap by depth env / config** | pi-harness `MAX_DEPTH`; Claude Code 5-level cap (v2.1.172+) |
| **Block on tool** | OpenAI guardrails (only run-level), `tool_call` in pi-harness |
| **Strip spawn tools at cap** | pi-harness (we have this) |

### 7.5 Progress / cancellation

| Choice | Cost / payoff |
|---|---|
| **In-tool streaming**: parent LLM sees `onUpdate` events | What `subagent/` ships today |
| **Panel of running tasks** (`/tasks`, `claude agents`) | Best UX, requires UI work |
| **Background, polled via tool calls** | What LangChain's async pattern is |
| **Background registry, no panel** | What pi's empty slot is |
| **Job IDs** | LangChain async |

### 7.6 Result merging

| Choice | When |
|---|---|
| **Last assistant text only** | All four — Claude Code, OpenAI, LangChain, pi |
| **Synthesize a multi-source verdict** | Claude Code dynamic workflows ("run many, cross-check") |
| **Externalized + selective pull** | pi-harness only |
| **Combine parallel streams + cross-verify** | LangChain subagents in single-turn parallel calls |

### 7.7 Persistence

| Choice | Mechanism |
|---|---|
| **Ephemeral** | `subagent/index.ts` `run_agent` mode |
| **Saved pipeline** | pi-harness chains in YAML |
| **Cross-session memory per agent** | Claude Code `memory:` field |
| **Task list shared across teammates** | Claude Code **agent teams** (experimental) |

---

## §8. Where this leaves pi

A small, defensible reading list of *decisions* for the next subagent work, all grounded above.

1. **Treat `subagent/index.ts` as the reference.** It's already the LangChain *single-dispatch-tool* shape, which both Claude Code and LangChain recommend. Don't fork the shape — extend it.

2. **Add frontmatter to `agents/*.md`.** pi's current agent markdown carries `name`, `description`, `tools`, `model`, `systemPrompt` (we read this in the previous subagent survey). Claude Code matches this with the same five plus `permissionMode`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `isolation`, `color`. Add `isolation: worktree` so a scout can take a temp checkout — that's the one missing structural axis.

3. **Register on `BackgroundProcessRegistry`.** This is the *only* line of code that fixes `/logs`. The registry is wired; no caller. `register({kind:"delegation", label:"delegate:scout(<task>)", summary:"..."})` from inside `runSingleAgent()` is the smallest change with the biggest visible payoff. Two to four functions touched, end-to-end.

4. **Adopt the LangChain decision matrix.** "Specialist must talk to user directly → handoffs" is the right cross-over. pi's `/fork` is *almost* a handoff (it creates a new session), but it's user-initiated. An *automatic* handoff, where the LLM transfers control to a new session tree node, is a missing feature. [INFERENCE] this is a bigger change; not first-priority.

5. **Externalized returns with handles** (already shipped in `delegate.ts`) is **better than anything in the libraries.** Promote it to a shared helper or move it into the core.

6. **`run_in_background` per-agent** is the day-to-day UX win. With `BackgroundProcessRegistry` populated, the LLM can fire-and-forget then `attach` to the panel later. LangChain's async pattern + Claude Code's `/tasks` panel converge on this.

7. **Don't ship "agent teams"** (multi-pi with shared task list and inter-agent messaging). Claude Code marks it experimental; LangChain doesn't have it; OpenAI Agents SDK doesn't have it. That's a strong negative signal. Build only if a concrete use case demands it.

[INFERENCE, opinion] The single-feature move that buys the most is **#3**: register on the registry. It's a four-line change. It makes the empty `/logs` panel come alive for any extension that opts in. Everything else is bigger structural work with weaker near-term payoff.

---

## §10. CrewAI and AutoGen (partially read — see §0)

Two reference designs that are *not* listed in §1's table because the read was narrower. Both warrant full reads before any claim-comparison in §7-§8 is extended to them.

### 10.1 CrewAI — Flow + Crew architecture (read: crews + processes)

CrewAI's mental model has two units that map cleanly onto the §7 axes:

| CrewAI unit | Maps to | Job |
|---|---|---|
| **Flow** | The process / supervisor | The "manager" or "process definition"; manages state and execution order; can trigger crews |
| **Crew** | A team of role-playing agents | Does the actual work; returns a `CrewOutput` (raw string + Pydantic + JSON + per-task outputs + token usage) back to the Flow |

From `docs.crewai.com/v1.15.2/en/introduction`:

> "Crews are the 'teams' that do the heavy lifting. Within a Flow, you can trigger a Crew to tackle a complex problem requiring creativity and collaboration."
>
> "Crews provide: Role-Playing Agents (specialized agents with specific goals and tools), Autonomous Collaboration (agents work together to solve tasks), Task Delegation (tasks assigned and executed based on agent capabilities)."

Most production pages repeat the same one-liner: *"Use both. For any production-ready application, start with a Flow. Use a Flow to define the overall structure, state, and logic; use a Crew within a Flow step when you need a team of agents to perform a specific, complex task that requires autonomy."*

### 10.2 CrewAI Processes — sequential vs hierarchical

From `docs.crewai.com/v1.15.2/en/concepts/processes`:

- **Sequential** — "Executes tasks sequentially, ensuring tasks are completed in an orderly progression." Uses each task's `context` parameter to control which upstream outputs feed it.
- **Hierarchical** — "Tasks are not pre-assigned; the manager allocates tasks to agents based on their capabilities, reviews outputs, and assesses task completion." Requires either `manager_llm` or a custom `manager_agent` to be specified.

**Important subagent-y detail:** the hierarchical form has a manager agent picking which worker talks next — *the same problem statement as AutoGen's `SelectorGroupChat` and LangChain's Supervisor.* Different libraries, identical shape.

### 10.3 CrewAI config surface (selected from `docs.crewai.com/v1.15.2/en/concepts/crews`)

Most fields are first-class on the Crew, not the agent:

- `process: sequential | hierarchical` — coordination topology
- `manager_llm | manager_agent` — only for hierarchical
- `function_calling_llm` — separate model for tool-selection routing (clever split: *the chat model and the function-calling model can differ*)
- `planning | planning_llm` — an "AgentPlanner" ingests all Crew data and prepends a plan to each task description
- `memory: short_term, long_term, entity` — built into Crews (not agents)
- `cache: bool` — caches tool execution; default True
- `max_rpm` — rate limiting per crew
- `step_callback | task_callback` — both fire on every step / task
- `before_kickoff_callbacks | after_kickoff_callbacks` — input/output mutators
- `output_log_file: true|str` — saved as `.txt` or `.json`
- `tracing: bool` — OpenTelemetry; `None` = inherit
- `security_config` — identity fingerprinting
- `checkpoint | CheckpointConfig` — `[INFERENCE]` the only design here with first-class long-running-resume support; auto-saves after task completion; max checkpoints to retain

Field-by-field, CrewAI has more knobs on the *group* than OpenAI or LangChain have on the supervisor; the cost is that all those knobs leak into JSON configs and become YAML-management surface area. JSONC is the recommended config format (`crew.jsonc` + `agents/<name>.jsonc`), with a documented warning that "Only run JSON crew projects from sources you trust. `custom:<name>` tools and `{"python": "module.attribute"}` references execute local Python code when the crew loads." — i.e., CrewAI's plugin system is **explicitly trusted-source only**.

### 10.4 CrewAI agents per agent

Each agent in `agents/<name>.jsonc` is just `role`, `goal`, `backstory`, `llm`, `tools`. **That's it.** Per-agent fields: nothing on permission mode, memory, isolation, hooks, or worktree. So CrewAI delegates everything orthogonal (memory, rate-limit, callbacks) up to the Crew level. pi-harness's `AGENT_KINDS` map (`:222-226`) is closer to this shape than to Claude Code's broad frontmatter.

### 10.5 What CrewAI ships that we don't

| Feature | CrewAI | pi-harness | Implication |
|---|---|---|---|
| Automatic task planning (`planning` field) | ✓ — AgentPlanner prepends a plan to each task | – | Could be a pre-spawn LLM step |
| Hierarchical process with explicit manager | ✓ — required `manager_llm` | partial — `manager_agent` shape not wired | Bigger change |
| Auto-resume on long-running crews (`checkpoint`) | ✓ — `Crew.from_checkpoint()` | – | Could be a JSONL extension |
| `function_calling_llm` separate from chat model | ✓ | – | A model router improvement |
| Crew-level tracing, callbacks | ✓ | partial — `eventBus` exists | Wiring work, not new design |

### 10.6 AutoGen AgentChat — `SelectorGroupChat` (read: quickstart + selector-group-chat)

From `microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html`:

> "`SelectorGroupChat` implements a team where participants take turns broadcasting messages to all other members. A generative model (e.g., an LLM) selects the next speaker based on the shared context, enabling dynamic, context-aware collaboration."

Key features (verbatim):

- **Model-based speaker selection.**
- **Configurable participant roles and descriptions.**
- **Prevention of consecutive turns by the same speaker** (optional; off by default).
- **Customizable selection prompting.**
- **Customizable selection function** to override the default model-based selection.
- **Customizable candidate function** to narrow-down the set of agents for selection using model.

Algorithm (verbatim from the page):

> 1. The team analyzes the current conversation context, including the conversation history and participants' `name` and `description` attributes, to determine the next speaker using a model. By default, the team will not select the same speaker consecutively unless it is the only agent available.
> 2. The team prompts the selected speaker agent to provide a response, which is then broadcasted to all other participants.
> 3. The termination condition is checked to determine if the conversation should end, if not, the process repeats from step 1.
> 4. When the conversation ends, the team returns the `TaskResult` containing the conversation history from this task.

> "Once the team finishes the task, the conversation context is kept within the team and all participants, so the next task can continue from the previous conversation context. You can reset the conversation context by calling `reset()`."

`AssistantAgent` (the basic worker, read in the quickstart page): `name`, `description`, `model_client`, `tools`, `system_message`, `reflect_on_tool_use` (synthesis step on tool output), `model_client_stream`. **Notably lighter than Claude Code's AgentDefinition** — no permission modes, no memory scope, no isolation, no per-agent hooks.

### 10.7 What AutoGen `SelectorGroupChat` does that pi doesn't

| AutoGen concept | Equivalent in pi today |
|---|---|
| Termination conditions composed by `|` (e.g. `TextMentionTermination("TERMINATE") \| MaxMessageTermination(max_messages=25)`) | pi's `delegate.ts` has `MAX_ITERS=4`; no text-termination condition. **Worth adding.** |
| Sequence-wide `reset()` between tasks | pi's session JSONL handles this; equivalent exists at `/fork` + `/clone` boundary |
| Allow-repeated-speaker toggle | Not relevant — pi's "subagent" is a single-shot worker, not a chat loop |
| Custom selection function | Not relevant — pi uses description-driven selection at the LLM level, not a separate selector step |
| `reflect_on_tool_use: True` (turns raw tool output into natural language before returning it) | pi's tool rendering handles this via `renderResult`; per-tool choice is what the extension author writes |
| `selector_prompt` template substitution `{roles}` / `{participants}` / `{history}` | pi has no selector prompt — selection happens via parent-LLM tool-choice |

### 10.8 The pattern that three libraries converge on

CrewAI hierarchical process, AutoGen SelectorGroupChat, and LangChain Supervisor all encode the **same thing**: a model picks the next worker based on a description matching the conversation context. Different APIs, identical shape:

| Library | Selection mechanism | Worker description lives in |
|---|---|---|
| CrewAI hierarchical | `manager_llm` decides | `agents/<name>.jsonc` role+goal+backstory |
| AutoGen SelectorGroupChat | `selector_prompt` + model (override-able) | `AssistantAgent(name=..., description=..., system_message=...)` |
| LangChain Supervisor | `langgraph-supervisor` package | `create_supervisor([subagents])` |
| Claude Code subagents | Parent LLM picks the tool | Agent frontmatter `description` |
| OpenAI Agents SDK handoffs | Each `handoff()` is a tool the LLM picks | `Agent.handoff_description` + tool description |

[INFERENCE] If pi ever wants automatic delegation (parent picks among workers), the cleanest path is **descending from Claude Code**: add a `description` frontmatter field to `subagent/agents/*.md` and let the LLM pick which pre-registered tool to call, rather than building a separate selector. That aligns with the "subagent as tool-calling pattern" LangChain and Anthropic both recommend, and skips reinventing a selector model.

### 10.9 Where the AutoGen / CrewAI reads leave §8

Decisions re-evaluated after the partial reads:

- Decision #6 (`run_in_background: true|false` per agent) — **stays valid.** Both AutoGen and CrewAI treat each agent/run as a unit; none of them have a `background`-as-default toggle the way Claude Code introduced in v2.1.198. pi's `BackgroundProcessRegistry` still anchors the right design.
- Decision #5 (externalized returns with handles) — **stays valid, and is still ahead of all the libraries.** AutoGen returns the full `TaskResult` (conversation history); LangChain defaults to "last message"; CrewAI returns structured `CrewOutput`. None externalize by default.
- Decision #3 (register on the registry) — **stays the highest payoff move.**
- **New observation**: building automatic delegation requires picking one of three library patterns (parent-LLM-picks-the-tool / explicit selector-model / manager-LLM). The first is the path of least resistance, and matches what `subagent/index.ts:460` already does — just make the `description` field first-class in agent markdown.

---

## §11. Sources (verified this session)

| Claim cluster | Source |
|---|---|
| Claude Code four coordination shapes (subagents / agent view / agent teams / dynamic workflows) | https://code.claude.com/docs/en/agents (read 300 lines) |
| Subagent scope, frontmatter, built-ins, model inheritance, isolation | https://code.claude.com/docs/en/sub-agents (read 300 lines, 1147 total) |
| SDK programmatic `AgentDefinition`, what subagents inherit, foreground→background default flip in v2.1.198, `nest_handoff_history` opt-in | https://code.claude.com/docs/en/agent-sdk/subagents (read 300 lines, 650 total) |
| OpenAI handoffs as tools, `input_type` vs `input_filter` vs context | https://openai.github.io/openai-agents-python/handoffs/ (full read) |
| LangChain subagents as tool-calling pattern, sync vs async three-tool pattern, design-decisions table | https://docs.langchain.com/oss/python/langchain/multi-agent/subagents (read 300 of 526) |
| Existing-in-pi: `delegate.ts` ergonomics, kinds, recursion cap, env hardening, return handles, plan-mode read-only propagation, depth cap env | `packages/coding-agent/examples/extensions/pi-harness/extensions/delegate.ts` (full read) |
| Existing-in-pi: `subagent/index.ts` spawn shape (`--mode json -p --no-session --append-system-prompt <tmp>`) and limits | `packages/coding-agent/examples/extensions/subagent/index.ts` (sampled `:33-36, :265-296, :313-320, 530-581, 611-622`) |
| BackgroundProcessRegistry reserved plug | `packages/coding-agent/src/core/background-process-registry.ts:5-23` |

[INFERENCE] Anything above not tied to a source line is opinion. Names: "agent view" vs "agent teams" vs "dynamic workflows" is Claude Code's terminology; I matched it.
