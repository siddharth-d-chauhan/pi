# pi — onboarding & deep-dive

> *A friendly, opinionated tour of the pi codebase. Read top-to-bottom if you're new; jump to §11 (reading order) if you just want pointers into the source. Load-bearing claims carry `path:line` so you can verify; opinions, structure, and the "what is this thing" prose don't.*

## 0. The 30-second pitch

**pi is one process that talks to a language model and reads your files for it.** That's it. Everything else — the TUI, the slash commands, the session JSONL, the extension system, the orchestrator, the subagent tool — is in service of *that one job*.

You run it as `pi`. You type something. It streams a reply. If the reply includes tool calls, pi runs them and feeds the results back. When the run ends, the entire conversation (every user prompt, every assistant message, every tool call and tool result) is appended to a JSONL file on disk. Next time you run pi, you can resume that session. If you'd rather branch off, you can fork it. If you'd rather run a separate pi session in parallel on a different task, you can fork a process.

That's the product. Now let's look at how it's built.

---

## 1. The mental model — five things to keep in your head

If you remember these, the rest is detail:

1. **One process, one conversation.** pi is not multi-tenant, not multi-session-in-memory. It runs one session at a time. If you want two conversations going, run two `pi` invocations. (Or use the *extensions* layer — see §9.)

2. **The conversation is a JSONL file.** Every message, every tool call, every tool result is a line in that file. Compaction is "rewrite old lines into a summary line." Forking is "copy the first N lines into a new file." It is not a database. It is not a graph. It's an append-only log with parent-id pointers.

3. **The agent loop runs once per turn.** It does: call the LLM → if it returned tool calls, run them and feed results back → repeat until the assistant stops without tool calls. That's literally 80% of the runtime.

4. **Extensions are Lua-config-equivalent, but in TypeScript.** A factory function `(pi) => { ... }` that registers tools, subscribes to events, mutates messages, draws overlays. The whole extension system is bookkeeping around "give an extension a handle into the runtime and a bus to subscribe to."

5. **Anything "many pi sessions"-shaped** (parallel scouts, child processes, recursive delegation, cloud-presence) **lives outside the runtime.** You get it by either (a) writing an extension that spawns `pi --mode json -p --no-session <args>` as a subprocess, or (b) running `@earendil-works/pi-orchestrator`, an experimental daemon that owns many `pi --mode rpc` children.

That's it. If those five land, every later section is a deepening of one of them.

---

## 2. The shape of the monorepo

```
~/pi/
├── packages/
│   ├── ai/                 # Provider shim. One file per provider (anthropic, openai, google, …).
│   ├── agent/              # The runtime. Headless turn loop. Single-session. No UI. (One layer below — `harness/env/nodejs.ts` — does call `spawn` for the bash tool's child process; the runtime *itself* has no stdin/stdout.)
│   ├── coding-agent/       # The pi binary. Modes, TUI, slash cmds, session JSONL, extensions.
│   ├── orchestrator/       # Experimental. A long-lived daemon that supervises many pi children.
│   └── tui/                # Terminal rendering primitives (Editor, Component, Container, Theme).
├── examples/extensions/    # Example extensions. subagent/, plan-mode/, pi-harness/…
├── docs/                   # 28 markdown files. extensions.md is 2700 lines and is the source of truth for the extension API.
├── package.json            # npm workspaces. Note the workspaces list — examples count.
└── rebuild.sh              # Single command to rebuild everything you edited.
```

Three things to keep distinct:

| Layer | Job | Owns |
|---|---|---|
| **ai** | One provider, one interface | `stream()`, model definitions |
| **agent** | One turn | `runAgentLoop`, parallel tools, message types |
| **coding-agent** | Make `pi` runnable | `cli.ts`, modes, session JSONL, extensions |
| **orchestrator** | Many `pi`s, one operator | Unix socket, presence, supervision |

The three modes in `coding-agent/src/modes/` (interactive / rpc / print) all instantiate the same `AgentSession` and feed it prompts and events. The differences are I/O framing.

---

## 3. The agent loop, in 100 lines

`packages/agent/src/agent-loop.ts` is the place. `runAgentLoop` is ~95 LoC of setup that hands off to a `do/while`. Inside the loop:

```
┌───────────────────────────┐
│  Add a new user prompt    │  (or steered/followUp messages arrive mid-loop)
└────────────┬──────────────┘
             ▼
┌───────────────────────────┐
│  Call LLM with full       │  ◄─── providers/anthropic.ts or openai.ts or …
│  message history          │       returns an async iterator of events
└────────────┬──────────────┘
             ▼
┌───────────────────────────┐
│  Got an assistant message │
│  with N tool calls?       │
└─────┬───────────────┬─────┘
      │no            │yes
      ▼              ▼
   (emit        Split into N toolCalls.
   agent_end)   Decide: SEQUENTIAL or PARALLEL?
                Sequential tools block.
                Parallel tools all run via Promise.all.
                ┌─────────────────────────┐
                │  Each tool runs, emits  │
                │  tool_execution_start,  │
                │  then _update (stream), │
                │  then _end (final).     │
                └────────────┬────────────┘
                             ▼
                Tool results appended to the message list.
                Loop back to the LLM call.
```

Three seams in this loop are extension-visible:

- **Before the LLM call** — fires `context` event with the message list, extensions can drop/rewrite.
- **Before each tool** — fires `tool_call` event; extensions can block.
- **After each tool** — fires `tool_result` event; extensions can rewrite the result.

That's the entire mechanism for "in-harness context control" that the pi-harness README keeps talking about. An extension like `guardrails.ts` registers a `tool_call` handler that returns `{block: true}` if `rm -rf /` is in the args.

`agent-loop.ts:451 executeToolCallsParallel` is the only async-fan-out in the loop. **It fans out tools, NOT sessions.** If you've heard the phrase "parallel pi sessions" — that doesn't exist here. Parallel sessions are an extension's job.

---

## 4. The session JSONL — your data model

Path: `~/.pi/agent/sessions/<id>.jsonl`.

Schema: each line is one *entry* with `{type, parentId, ...}`. Types include `user`, `assistant`, `toolCall`, `toolResult`, `compaction`, `branchSummary`, `custom` (for extension-added entries), plus a few more. The renderer turns this flat list into a tree by walking parent ids.

What this means:

```
sessions/abc.jsonl
[1] type=sessionStart, parent=null              ← root
[2] type=user,        parent=[1], text="hi"
[3] type=assistant,   parent=[2], content="hello"
[4] type=user,        parent=[3], text="read x.ts"
[5] type=assistant,   parent=[4], toolCalls=[…]
[6] type=toolCall,    parent=[5]
[7] type=toolResult,  parent=[6]
[8] type=assistant,   parent=[7], content="it says ..."
[9] type=user,        parent=[8], text="/fork here"   ◄── user picks entry [4] to fork at
```

`/fork` at [4] copies entries [1..4] into a new file. The new session restarts from [4]. The original session file is unchanged.

`/clone` (slash-commands.ts:31) does the same fork but with an *additional* current entry, so the clone has the branched work too.

`/tree` (slash-commands.ts:32) navigates *within* one JSONL when the conversation has internal branches (think git log --oneline with parent-ids).

`compaction` is an entry that summarises a bunch of older entries into one. The loop's `context` event fires before compaction too, so an extension can supply its own summary and `cancel: true` the default path.

What you should take away:

- **All *session state* is in JSONL.** Conversation, history, tool calls, compactions, custom entries, the parent-id graph. Nothing else of the session lives elsewhere.
- **There's no forks-as-processes concept**, despite the verb "fork." Forking is branching.
- **Branching is on entries, not on processes.**

---

## 5. The three modes (interactive / rpc / print)

`packages/coding-agent/src/modes/`. They're just three different I/O adapters on top of `AgentSession`.

### interactive
`modes/interactive/`. ~6100 lines, dominated by `interactive-mode.ts` (the "Pi" controller). Components live in `components/`: `CustomEditor`, message list, footer, slash-command pickers, modals, the BackgroundLogPanel.

The interactive mode holds your cursor, draws your messages, listens for keybindings, and routes events back to `AgentSession`. When the agent is running, it's basically a fancy stdout forwarder onto the message-list component.

### rpc
`modes/rpc/`. JSON-in JSON-out over stdio. Documented at `docs/rpc.md` (1470 lines). Commands like `{type: "prompt", message: "..."}` go in; events come out async; each command's response comes back on the same `id` so you can correlate.

This mode is the *integration surface for headless usage.* Any tool that wants to drive pi programmatically uses RPC mode. IDE plugins. CI bots. The orchestrator.

### print
`modes/print-mode.ts`. The "one-shot" mode used by extensions that spawn `pi --mode json -p --no-session ...` as a subprocess. It runs the loop once, prints the assistant reply, exits. No TUI, no session resume, no slash commands.

If you've ever seen the `subagent/` extension, that's print mode in action, streaming the assistant's events out as JSONL that the parent extension parses back in.

When the modes differ:

| Feature | interactive | rpc | print |
|---|:-:|:-:|:-:|
| TUI | ✓ | | |
| Slash commands | ✓ | (extension-cmds only) | (extension-cmds only) |
| Session JSONL persisted | ✓ | ✓ | (off via `--no-session`) |
| Sub-process spawnable | n/a | ✓ (used by orchestrator) | ✓ (used by subagent/) |

---

## 6. Extensions — what they are

A factory function:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "foo", ... });
  pi.on("session_start", (event, ctx) => { ... });
}
```

That's the whole shape. Everything else is what the `pi` object can do.

### Where they live

Loading slots, in order (`extensions/loader.ts:651 discoverAndLoadExtensions`):

1. `<cwd>/.pi/extensions/` (project-local)
2. `~/.pi/agent/extensions/` (user-global)
3. `<settings.packages[]>` (explicit paths)

Each factory is loaded, given a unique `ExtensionAPI`, and registered. Failures don't crash pi; they're surfaced as `ExtensionError` events.

### What they can register

From `extensions/types.ts` (1638 lines, the source of truth):

| Method | Purpose | Lifetime |
|---|---|---|
| `registerTool(def)` | Add a tool the LLM can call | session |
| `registerCommand(name, {description, handler})` | Add a slash command | session |
| `registerShortcut(keys, handler)` | Add a keybinding | session |
| `registerProvider(name, config)` | Add a brand-new LLM provider | runtime |
| `registerWidget(placement, component)` | Add a TUI widget | session |
| `on(event, handler)` | Subscribe to a runtime event | session |
| `sendUserMessage(text)` | Push a message into the loop | runtime |
| `appendEntry(customType, data)` | Write a custom JSONL entry | session |
| `ui.*` (status, notify, confirm, select, input, …) | Draw UI | session |

### What they can't do

- They can't talk to another pi process directly. (You have to spawn one.)
- They can't change the `AgentSession`'s core loop. They can only filter events.
- They can't outlive the session. (Reload `/reload` if you want fresh.)

### The events in the bus

All from `extensions/types.ts:1002` `ExtensionEvent` union (with `hread` substitution for the `on(...)` ones):

```
project_trust            ─► granted? y/n; halts project load
resources_discover       ─► extensions return extra resource paths
session_start             ─► fresh JSONL is open
session_info_changed      ─► name/metadata mutated
session_before_switch     ─► pre-flight; can cancel
session_before_fork       ─► pre-flight; can cancel
session_before_compact    ─► pre-flight; can replace summary
session_before_tree       ─► pre-flight; can replace label/summary
session_shutdown          ─► teardown imminent
context                   ─► BEFORE each LLM call; can mutate message list
before_provider_request   ─► can replace the outgoing provider payload
after_provider_response   ─► can mutate the response before stream consumption
before_agent_start        ─► can mutate the system prompt
agent_start / agent_end   ─► outer bounds of the loop run
turn_start / turn_end     ─► per turn (a turn = one LLM→tool round-trip sequence)
message_start/update/end   ─► streaming events for one message
tool_execution_start/update/end ─► tool calls
model_select, thinking_level_select, input, user_bash, tool_call, tool_result
```

Hooks you actually write every day:

- `session_start` — install once-and-done things.
- `context` — bound context; rewrite/drop messages before they go to the LLM.
- `tool_call` — block a tool or modify args (guardrails, gates).
- `tool_result` — rewrite an oversized tool output before it floods the context.

The general rule: `on(event)` is *observe*; `pi.sendUserMessage`, `appendEntry`, `registerTool` are *mutate the world*.

---

## 7. Tools and the provider layer

### Built-in tools
`packages/coding-agent/src/core/tools/`: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. All implemented by extending the same `ToolDefinition` interface. Each tool has:

- `parameters` — a TypeBox schema (the LLM sees it as JSON-Schema).
- `execute(id, args, signal, onUpdate, ctx) => Promise<AgentToolResult>`.
- `renderCall(args, theme, ctx)` and `renderResult(result, theme, opts, ctx)` for TUI rendering.

An extension-supplied `registerTool(...)` follows the same shape. Tools are not "commands" — they're LLM-callable functions; commands are slash-typed-by-the-user.

### Providers
`packages/ai/src/providers/`. Each provider file (anthropic, openai, google, …) exports a uniform interface that takes messages + a `Model` and yields a streaming event iterator. The coding-agent doesn't import providers directly — it goes through `ModelRegistry` (`coding-agent/src/core/model-registry.ts`), which handles selection ("given this `model: provider/id` string, find the right provider") and per-tool configuration (cache_control placement, thinking level, etc.).

Models are auto-discovered from each provider's static catalogue. Adding a brand-new provider means writing one file under `ai/src/providers/`, or shipping a community package that registers via `registerProvider(...)` (see `pi-lmstudio` for an example).

---

## 8. The orchestrator — `packages/orchestrator/`

Around 2000 LoC, ~13 files. Marked experimental; the README literally says so.

What it is:
- A long-running process that owns *N* `pi` children.
- Exposes one Unix socket (`~/.pi/orchestrator/orchestrator.sock` or `PI_ORCHESTRATOR_DIR`-configurable).
- Speaks JSONL on the socket: `{type: "spawn" | "list" | "stop" | "rpc" | "rpc-stream" | "status", ...}` in, typed response out.
- Optionally publishes presence to `radius.pi.dev`.

What it is **not**:
- A parallel-agents scheduler. There's no in-process fan-out, no concurrency primitives, no global queue.
- A window into a running pi session the user is currently using. It's external.

The actual shapes:
- `serve` — fork in the background, hit it via socket.
- `spawn --cwd <p> --label <l>` — child id is generated; returns it.
- `rpc <id> <jsonCmd>` — send one typed RPC command (`RpcCommand`), get one response.
- `rpc-stream <id>` — open a long socket; stdin is JSONL commands; stdout is JSONL events.

Internally the supervisor keeps a single `OrchestratorSupervisor` instance (`supervisor.ts:342`), mapping `liveInstances: Map<id, LiveInstance>` with `rpcProcess: RpcProcessInstance` (`rpc-process.ts:25`). Each child was spawned via `getSpawnCommand()` (`rpc-process.ts:50-61`), which picks `<bin>/pi --mode rpc` under Bun or `node @earendil-works/pi-coding-agent/rpc-entry` under Node.

The orchestrator is the *right* answer if you have many long-lived pi sessions that need to survive across shell logins and need a single dashboard. It's the *wrong* answer if you want fan-out parallelism — the child processes just sit there.

### The cloud presence layer

`radius.pi.dev/v1/machines/register`, `/heartbeat`, `/disconnect`, `/pis/register` (verified). Heartbeats use exponential backoff with `1s`-base, `30s`-cap, random jitter. Auth: `AuthStorage` reads from `~/.pi/agent/auth.json`, with `PI_RADIUS_API_KEY` as override.

**[INFERENCE]** Treat any radius line as recent and likely to change. The radius package is not a documented product; it's an internal coordination surface.

---

## 9. The "subagent" patterns in the codebase

The word **subagent** has two related but distinct meanings inside the repo.

### 9a. `examples/extensions/subagent/` — the off-the-shelf one

`index.ts` is 1015 lines. Registers a tool called `subagent` with three modes:

- *Single*: `{agent, task}` — one custom-prompted child.
- *Parallel*: `{tasks: [...]}` — up to 8 tasks (with 4 concurrent; `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `index.ts:33-34`).
- *Chain*: `[{agent, task}, ...]` — sequential; `{previous}` placeholder is replaced with the prior step's output.

Each child is `pi --mode json -p --no-session --append-system-prompt <tmp>`. Spawn reads JSONL from stdout, parses `message_end`/`tool_result_end`, accumulates into a streaming `result`, and reports per-task usage and per-message events to the parent's loop via `onUpdate`. On abort, SIGTERM then SIGKILL after 5s.

Agent markdown is loaded from `~/.pi/agent/agents/*.md` (user) or `.pi/agents/*.md` (project, opt-in via `agentScope: "project" | "both"`). The example confirms project-local agents via a UI dialog; user-only is the default.

How to think about it: the simplest possible "child pi" tool. No persistence. No retry. No judges. You give it a system prompt; it gives you back its last assistant text. That is the entire contract.

### 9b. `examples/extensions/pi-harness/extensions/delegate.ts` — the rich one

768 lines. Implements `actions`: `run_agent`, `run_chain`, `orchestrate`, `create_chain`, `list`, `pull`. Adds:

- *Kinds*: `reviewer | debugger | implementer | refactorer | explorer | custom`. Each kind has a fixed model + tool list at spawn time.
- *Verify loop*: optional `verify` shell command; re-prompts until it passes (max `max_iters`, default 4).
- *Assert loop*: optional `assert` claim; spawns an adversarial audit sub-process that looks for `^REAL` vs `^GAMED` in its output. Retries on failure.
- *Chains*: `create_chain` persists steps to `.pi/chains/<name>.yaml` for reuse.
- *Plan-mode handoff*: listens for `plan:chain` events and writes them.
- *Recursion cap*: `KP_DELEGATE_MAX_DEPTH=2` (default). Depth rides in `PI_DELEGATE_DEPTH`. At the cap, the child has the `delegate` and `task` tools **stripped** at spawn — so the cap holds across the process tree.
- *Self-recursion block*: a `kind` can't spawn its own name.
- *In-child lockdown*: even if a child gets the tools back, `tool_call` block at the seam rejects re-spawns.
- *Env hardening*: provider credentials are scrubbed from the child env (gated by `KP_DELEGATE_ENV_HARDEN`).
- *UI*: rich task cards via `./ui-agent-cards.ts`, surfaceable in `/logs` via `./process-registry.ts`.

This is roughly an order of magnitude more sophisticated than `subagent/`. It is what you write when one prompt isn't enough and you want retries-with-judges.

### The shape comparison

| | subagent/ | delegate.ts |
|---|---|---|
| Persistence | None | YAML chains in `.pi/chains/` |
| Per-call retries | No | Yes (verify/assert loops) |
| Kinds | Flat (md files) | 5 built-in + custom |
| UI | Simple status | Rich agent cards |
| Plan mode | Unaware | Cooperates via `plan:chain` |
| Depth cap | None | `KP_DELEGATE_MAX_DEPTH` |
| Env hardening | No | Yes |
| Lines | ~1316 | 768 |

Pick `subagent/` if you want "single-specialist, one task, no ceremony." Pick `delegate.ts` if you want "pipeline with verification, possibly chains of specialists."

### The reserved slot

`packages/coding-agent/src/core/background-process-registry.ts:5-23` is a registry whose doc-comment says, verbatim: *"Today: no callers register. The registry is wired and ready; future subagent/parallel-tool/MCP work plugs in by calling `register()`."*

The kind enum is already `"subagent" | "delegation" | "mcp" | "shell-suspend" | "other"`.

The TUI's empty-state down-arrow handler already queries it (and shows nothing today, since nothing registers). The `BackgroundLogPanel` component is the renderer.

**If you are about to ship a subagent feature, register on this registry.** That's the missing piece between "the extension works in the parent model" and "the user can see it work in the TUI."

---

## 10. The two ways to think about "concurrent pi"

If someone says "I want concurrent pi," figure out which one they mean:

1. **Concurrent *tool calls* in one turn.** This is `executeToolCallsParallel` in `agent-loop.ts:451`. The LLM emits N tool calls in one assistant message; pi runs them all with `Promise.all`. No children, no extra sessions. Native.

2. **Concurrent *sessions* over a task.** This is what `subagent/` and `delegate.ts` provide. The parent extension spawns N `pi --mode ...` processes, parses their JSONL, and merges results. Not native — written on top of `child_process.spawn`.

3. **Many long-lived *attended* sessions.** This is the orchestrator. Each session is a unique pi process you control via the orchestrator's socket. No fan-out — but they survive across shell logins.

Three modes, three different problems. Don't conflate them.

---

## 11. Reading order if you want to learn from the code

The shortest path to "I get it":

1. **`packages/agent/src/agent-loop.ts`** — one file, one idea: the turn loop. Skim to the end; it's all there.
2. **`packages/coding-agent/src/core/agent-session.ts`** — the JSONL store + lifecycle + extension hooks. Big file, but ~80% of it is bookkeeping once you see the shape.
3. **`packages/coding-agent/src/core/extensions/runner.ts`** — event dispatch. Look at `ExtensionRunner.emit()` and how it walks extensions.
4. **`packages/coding-agent/src/core/extensions/types.ts`** — the contract. Read `ExtensionAPI` (≈1379 lines), then skim the `ExtensionEvent` union to see every event the bus supports.
5. **`packages/coding-agent/src/modes/interactive/interactive-mode.ts`** — the controller. Read it last because it ties everything together. ~6100 lines, but it's structured: constructor sets up components; methods respond to events.
6. **`examples/extensions/subagent/index.ts`** — the cleanest example of a non-trivial extension. Once you've read this you can read any other extension.
7. **`examples/extensions/pi-harness/extensions/delegate.ts`** — same shape, much richer. Read last because the safety rails (recursion cap, env hardening) will distract you.

If you only have an hour: items 1, 2, and 6.

If you have a day: items 1-7 above.

After that, the `docs/` directory is your reference:
- `extensions.md` (2728 lines) — authoritative extension reference.
- `rpc.md` (1470 lines) — protocol reference.
- `sessions.md` — the JSONL format and slash commands.
- `packages.md` — installable packages.
- `keybindings.md` — how keybindings map.

---

## 12. Glossary

> Terms you'll trip on. Defined in the most useful way, with cross-references.

**adapter** — a code path that takes one interface and emits another. `modes/{interactive,rpc,print}/` are adapters over `AgentSession`.

**branch** — a JSONL node with two or more children. Internal to one session; navigable via `/tree`.

**BackgroundProcessRegistry** — `coding-agent/src/core/background-process-registry.ts`. The reserved-but-empty plug for surfacing subagent progress in the TUI. `BackgroundProcessKind = "subagent" | "delegation" | "mcp" | "shell-suspend" | "other"`. See §9.

**chain** — In `delegate.ts`: a YAML file under `.pi/chains/<name>.yaml` describing a sequence of stages (kind + prompt + optional verify/assert). At runtime: the parent runs each stage sequentially, threading `previous` between them. In `subagent/index.ts`: the more pedestrian `{chain: [...]}` mode.

**chunk** — An HTTP/network chunk from the streaming provider. Not a domain term; just SSE/WebSocket output.

**compaction** — A JSONL entry of type `compaction` that summarises older entries. Triggered by `session_before_compact` (extensions can supply their own summary or `cancel: true`).

**context** — Two meanings.
- *The message list being sent to the LLM.* `context` event fires before each send; mutations happen here.
- *The user-facing term* for "the conversation's working memory." Same thing.

**delegate** — `examples/extensions/pi-harness/extensions/delegate.ts`. The rich subagent extension. Contrast `subagent/`.

**ephemeral worker** — A sub-pi process spawned for one task with no persistence. `subagent/` spawns only ephemeral workers; `delegate.ts` supports both ephemeral (`run_agent`) and persisted (`create_chain`).

**extension** — A factory function `(pi) => ...` registered in one of three locations. See §6.

**fork** — Both *JSONL branch copy* (slash-commands `/fork`, `/clone`) and *process fork* (the orchestrator spawning a child). The JSONL kind is the everyday case; the process kind is structural — `pi` doesn't have any other "fork" semantics.

**harness** — A loaded term in this codebase; cf. the `examples/extensions/pi-harness/` directory which is *your* belt-and-suspenders extension set. Don't conflate with the `packages/agent/src/harness/` directory (an unrelated abstract-`AgentHarness` class for embedding pi in TS apps).

**interactive-mode** — `modes/interactive/interactive-mode.ts`, the giant controller file. The TUI controller.

**kind** — A named agent role in `delegate.ts`: `reviewer | debugger | implementer | refactorer | explorer | custom`. Each kind binds a model and toolset at spawn.

**[INFERENCE]** marker — A tag I (or any reader) attach to claims that aren't directly grounded in code. Use it as a flag for "verify this before you bet on it."

**kinds** — Plural of kind. See above.

**mode** — `interactive | rpc | print`. Three adapters sharing an `AgentSession` core.

**orchestrator** — `packages/orchestrator/`. The experimental long-lived supervisor. See §8.

**presence** — The cloud-published "is this pi/this machine online" signal, sent to `radius.pi.dev`.

**radius** — The orchestrator's cloud sync service. `radius.pi.dev`. Endpoints verified: `machines/register`, `machines/{id}/heartbeat`, `machines/{id}/disconnect`, `pis/register`.

**runtime** — Refers to one of two things. (a) `packages/agent/` — the headless turn loop. (b) Loose term for "the pi process."

**scout** — In `subagent/agents/scout.md`, an agent kind optimised for fast read-only recon. A convention from `subagent/`, not a built-in concept.

**session** — One JSONL file plus its in-memory state (`SessionManager`). One per `pi` invocation.

**slash command** — A `/`-prefixed command typed in the prompt: `/model`, `/fork`, etc. Built-ins in `slash-commands.ts:18-41`. Extensions add more via `pi.registerCommand(...)`.

**spawn tool** — `delegate.ts:159 SPAWN_TOOLS = ["delegate", "task"]`. The tools that, if kept in a child at the recursion cap, would let it spawn its own children. The protocol strips them at the cap.

**subagent** — Either (a) anything-not-the-parent-pi in a delegation chain — `delegate.ts`'s "agents"; or (b) the literal `examples/extensions/subagent/` extension. The two usages overlap in spirit; the word is not strictly defined upstream.

**tool** — An LLM-callable function registered via `pi.registerTool(def)`. Distinct from a "command" (slash-typed) and from a "keybinding" (keyed in the TUI).

**tree** — The parent-id graph of a session JSONL. Navigable via `/tree`. Not a git tree.

**verify / assert** — `delegate.ts`'s two loop primitives. `verify` is a shell command (deterministic pass/fail); `assert` is an LLM-judge prompt (semantic pass/fail). If a `verify` always passes by gaming tests, `assert` catches it.

**[further INFERENCE]** entries — `[INFERENCE]` appears throughout this doc where I'm extrapolating from the surface area. If something says `[INFERENCE]`, verify before relying.

---

## 13. Five things to read once and never forget

1. **The runtime is single-session.** Every "concurrent" or "parallel" pi is somebody's job to build (yours, the orchestrator's, an extension's). [INFERENCE]

2. **The session is a JSONL log with parent ids.** Forking is copying. Branching is sharing nodes. Compaction is summarisation. That's the data model.

3. **Extensions cannot mutate the agent loop.** They can mutate its inputs (messages, args, results) and its outputs (entries, UI, side-effects). That's *almost* everything; the things they can't do (run two sessions, change core scheduling) is the territory of the orchestrator or your own daemon.

4. **The orchestrator and the subagent extensions solve different problems.** The orchestrator is "many long-lived attended sessions with a single dashboard." The subagent extensions are "fire-and-forget specialists with my own retry/judge policy." [INFERENCE]

5. **pi authors have anticipated subagent support and left a hook that's currently empty.** `BackgroundProcessRegistry` is wired but unused. If you build a subagent extension, wire it there so users see progress in the TUI. [INFERENCE only by absence-of-evidence — the registry's own doc-comment explicitly invites this.]

---

## 14. Where to go from here

If you want to actually *build* something, you have plenty of room:

- **Add a subagent hook.** One of the subagent extensions registers against `BackgroundProcessRegistry` and suddenly the `/logs` panel comes alive for in-flight work.
- **Add a provider.** Write one file under `packages/ai/src/providers/` or ship a community package that calls `registerProvider`.
- **Add an extension event.** The extension runner is mechanical; adding a new event is mostly a types-file change plus an `emit()` somewhere.
- **Add a mode.** Implement three adapter methods (`prompt`, `subscribe`, `terminal`) and `modes/<name>/` slots in. The hardest part is convincing yourself it's worth it.
- **Replace print-mode for agents.** A blocking prompt → response loop is a thin slice that anyone could swap for a more sophisticated asynchronous dispatch.

If you want to *understand*, start with the reading order in §11.

Either way: the source is the documentation. The docs reference the code; the code references nothing. When in doubt, find the function and read it.
