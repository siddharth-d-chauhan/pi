# pi-harness — the coding plane, built on pi

Extensions for [pi coding-agent](https://github.com/earendil-works/pi) that turn it into this
system's interactive coding harness: knowledge-first retrieval from the brain, harness-enforced
gates, and (next) KP-backed context management. Hermes keeps the companion role; pi takes the
coding role; both share the brain.

Why pi: minimal loop + real TUI, and every seam we need is sanctioned — per-turn message rewrite
(`context` event), compaction takeover (`session_before_compact`), tool registration/override,
custom providers with `cache_control` control, RPC/SDK modes for programmatic driving. We build
in extensions, never by patching pi itself (same pristine-vendor policy as `kp_lcm`).

## Setup (from source — `git pull` is the deploy, like the Hermes editable install)

```bash
git clone https://github.com/earendil-works/pi.git ~/project/pi
cd ~/project/pi && npm install && npm run build
cd <monorepo>/pi-harness && npm i         # MCP client SDK for the bridge
# brain must be up: cd ../knowledge-platform && docker compose up -d
```

Run from the monorepo root (`pi-test.sh` runs pi from source via tsx, keeps caller cwd):

```bash
~/project/pi/pi-test.sh \
  -e "$PWD/pi-harness/extensions/knowledge.ts" \
  -e "$PWD/pi-harness/extensions/gates.ts"
```

Startup notice `knowledge brain: 22/38 tools mounted (read-only)` confirms the bridge is live.

(Once trusted, these can move to `.pi/extensions/` for auto-load; note project-local extensions
only load after project trust.)

## Extensions

| file | seam | what it does |
|---|---|---|
| `extensions/knowledge.ts` | `registerTool` at `session_start` | Bridges the KP MCP server (`kp serve --mcp-stdio`, spec read from root `.mcp.json`) into pi tools. Read-only surface by default; mutating tools need `KP_PI_ALLOW_WRITE=1`. Injects knowledge-first prompt guidelines. |
| `extensions/gates.ts` | `tool_call` block | draft → confirm for gated bash (git commit/push, gh, dep installs) and KP mutations. Enforced in-harness, not by prompt. |
| `extensions/guardrails.ts` | `tool_call` block + `/guardrails` | safety rails (inspired by @aliou/pi-guardrails, MIT; rebuilt dependency-free): glob file policies (secrets are noAccess by default — read/write/edit AND referenced in bash), structural dangerous-command matchers (rm -rf in any flag form, sudo/doas, dd to devices, mkfs/fdisk, find -delete, git clean -fdx, kill -9 -1, fork bombs) plus pipe-to-shell detection upstream lacks, auto-deny regexes (rm -rf on / or ~ — never prompted), allow-once/session prompts in the TUI with headless block fallback, and a JSONL audit trail. Config: `.pi/guardrails.json` over `~/.pi/agent/pi-harness/guardrails.json`. Division: gates.ts = workflow gates (draft→confirm), guardrails.ts = safety rails. |
| `extensions/context-economy.ts` | `tool_result` rewrite | mechanical output cap: any tool result >30k chars is externalized to a file; context gets head+tail excerpt + recovery instructions (rg / bounded read). Complements pi's builtin per-tool line truncation (catches single-huge-line and capless tools); knowledge_* and edit/write exempt. Prompt side: "Context economy" policy block (script-over-reads, filter-at-source, bounded reads) in knowledge.ts. Interim until the M2 LCM sidecar owns history eviction. |

Shared library modules (imported by the extensions, NOT listed in `settings.json`
packages — they export helpers, not a registrar): `extensions/lsp-registry.ts`
(rootMarker ∩ binary language-server autodetect, project-local bins preferred,
linter vs type-intel tagging — used by `lsp-rename.ts` + `diagnostics.ts`) and
`extensions/scan-cache.ts` (dir-prefix invalidate-on-mutate scan cache +
`withRefreshRetry` empty-result recheck — used by `scope.ts`).

### Config knobs adopted from oh-my-pi

Extension env gates (all default-on unless noted): `KP_LSP_ENABLED`,
`KP_DIAG_ENABLED`, `KP_SCOPE_RECHECK` (empty-result refresh-then-retry),
`KP_CODEMAP_RECHECK`, `KP_PERM_TIER` (declared read/write/exec tier — the
fail-closed default layer under the glob rules; a write/exec tool no rule covers is
gated), `KP_PERM_TIER_CHILD=1` (force the tier back on inside a headless delegate
child — off by default there so the child never wedges on an ask it can't confirm;
DENY rules still inherit). LSP server overrides live in `.pi/lsp.json`
(`{"<ext>":{"command":[...]}}`).

**Provider/cache economics (rank 12 — config-only, set in your env / provider
config, no code default here since pi's `settings.json` has no `env` block it
reads):**
- `PI_CACHE_RETENTION=long` — keep the cached prompt prefix warm longer, so the
  KV-cache-safe stable prefix (see MEMORY: KV-cache-safe context) actually pays off
  across turns instead of expiring between them.
- `ANTHROPIC_SEARCH_MODEL=<cheap-model>` — route the search/retrieval leg (the
  `ANTHROPIC_SEARCH_MODEL` used by search-backed calls) to a cheap model; mechanical
  retrieval doesn't need the frontier model. Pairs with M3 effort-routing
  (`model-router.ts`, owned elsewhere — not edited here).

## Roadmap (dependency order)

1. **M1 — brain bridge + gates** (this package). Smoke-test: ask pi "how does X work" and watch
   it call `knowledge_ask` instead of grepping.
2. **M2 — kp-context**: `context` event evicts cold spans per-request and mirrors them to KP
   blobs (`blob://sha256`), with `lcm_expand`-style recovery tools; `session_before_compact`
   either supplies a KP-grounded summary or `cancel: true` once eviction makes compaction moot.
   pi's session JSONL stays lossless — same philosophy as `kp_lossless`.
3. **M3 — provider/cache economics**: provider config with `cache_control` placement, effort
   routing (cheap model for mechanical stretches via `model_select`), and a token-accounting
   report over pi session files (port of `/harness tokens`).
4. **M4 — memory loop**: correction detection + `turn_end` write-back through the gated KP
   tools — the self-evolving loop, pi-side. **Auto turn-start recall injection is OUT** — the
   fork tried it and reverted (commit 7a772c7): a warm fact-search costs 10-15s on the
   CPU-embedder brain, stalling every prompt and rarely landing. Retrieval stays model-initiated
   (the knowledge-first policy + mounted tools); if injection ever returns it must be
   opt-in/soft-wait and ride a trailing user message (cache rule).
5. **M5 — agent-platform concepts, pi-side** (agent-platform itself is retired; no pipeline, no
   orchestrator):
   - **ACI**: tool results shaped by the contract spine (`tools_common.agent_protocol`) —
     `CodeContextBundle` connectedness (flow_steps/neighbors/coverage) preserved in what the
     bridge returns, never flattened to chunks; recoverable errors keep their semantics
     (`INDEX_STALE` → surface "refresh the index", never guess).
   - **Shared context**: cross-session and cross-agent working context lives in the brain, not
     in any one harness — what pi learns (gaps, decisions, run context) is written back so
     Hermes-companion and future pi sessions recall it.
   - **Capability tools**: freshness surfacing (never silently stale), gated mutations (in
     `gates.ts`), token/cost accounting.

## Ecosystem: adopt before build

pi has a real package ecosystem (`npm search keywords:pi-package`, `pi install npm:<pkg>`).
Candidates already sitting on our roadmap — evaluate these before writing the milestone:

| roadmap item | existing package | note |
|---|---|---|
| MCP bridging (M1) | `pi-mcp-adapter`, `pi-mcp-extension` | adapter = lazy proxy (~200-token tool, on-demand discovery, reads `.mcp.json`). Different tradeoff vs our bridge: we mount brain tools first-class so the knowledge-first reflex stays strong; the adapter suits the long tail of *other* MCP servers. Consider hybrid: core brain tools first-class, everything else behind the adapter. |
| gates | `@gotgenes/pi-permission-system`, `pi-landstrip` (Landlock sandbox), `cc-safety-net` | evaluate before growing gates.ts |
| context/token economy (M2/M3) | `context-mode` (strongest: sandboxed tool-output externalization + ctx_execute code-gen + session snapshots; ELv2, mature), `pi-lean-ctx`, `@hypabolic/pi-hypa` | attacks tool-output bloat — complementary to LCM (lossless history eviction + KP blob recovery), not a replacement (its compaction snapshot is lossy, ≤2KB). SOURCE AUDITED 2026-07-04: pattern mine, NOT a dependency. In pi it's capture-only (tool_result logs, never rewrites); distillation only inside its ctx_* tools and only with an explicit intent >5KB (5–100KB w/o intent flows raw); savings depend on coercing the model via tool_call bash-blocking (conflicts with gates.ts on the same seam). `ctx_execute` "sandbox" is spawn-as-user, cwd=repo, network open, fail-open deny — ungated exec path. No phone-home (verified). STEAL: (1) volatile injection as trailing user message via `context` hook, never system prompt — preserves prompt cache (their #598; rule for M4 recall); (2) reference-based compaction snapshots (runnable search pointers, not payloads) — for M2 eviction notices; (3) `src/adapters/pi/mcp-bridge.ts` hardening checklist (fork guards, idle reap, parent-death) for knowledge.ts's MCP client |
| observability/accounting (M3) | `@braintrust/pi-extension`, `@raindrop-ai/pi-agent` | session/turn/LLM-call tracing — may replace a custom `/harness tokens` port |
| memory (M4) | `gentle-engram`, `pi-hermes-memory` | our brain IS the memory; these are reference implementations for the recall-injection pattern |
| subagents | `pi-subagents`, `@gotgenes/pi-subagents`, `pi-crew` | when parallelism is needed |
| verify loop | `pi-lens` (LSP/linters/type-check feedback) | strong candidate for the devbrain-style verify stage |

## Optional capability packages (opt-in, not loaded by default)

These are external *capabilities* — genuine adopts (reimplementing a Chrome CDP
bridge or LM Studio provider would be pointless reinvention), but only useful when
your workflow needs them. Deliberately NOT force-loaded (they'd add prefix tokens /
a browser bridge / a provider you may not be running) — enable per-need. All three
peer-depend on pi with `*` (no version pin), verified compatible with 0.80.

| package | enable | what it adds · how it composes |
|---|---|---|
| **pi-lmstudio** | `pi install npm:pi-lmstudio` (+ run LM Studio on :1234) | local models as `lmstudio/*` providers. Composes directly with our per-stage model routing: a local model runs mechanical `delegate`/chain stages or `debug` supervisor at **zero token cost**. Only works while LM Studio is running. |
| **pi-web-access** | `pi install npm:pi-web-access` | web search (multi-backend, zero-config via Exa) + URL→markdown + **GitHub repo clone-and-read** + PDF/YouTube extraction. The in-pi analogue of the deep-research capability; SSRF-guarded. Optional API keys in `~/.pi/web-search.json`. Additive — no seam conflicts. |
| **pi-chrome** | `pi install npm:pi-chrome` (+ load its Chrome extension) | drives your **real signed-in Chrome** via a loopback bridge. Sound security: locked by default, time-boxed `/chrome authorize`, `/chrome revoke`, rejects browser-origin commands. Only if your workflow touches web UIs. |

Rule of thumb: install the one a task needs, remove it after if you want the prefix
back. Each is a self-contained capability, not a harness dependency.

## Benchmark

"Outperform" = same task, same model, fewer tokens, equal-or-better outcome, measured against
stock pi (no extensions) on 5–10 real tasks from these repos. M3's accounting makes every design
decision visible in the token curve.
