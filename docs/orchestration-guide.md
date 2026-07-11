# Orchestration in this fork: loop, chain, and prompt-based collaboration

Two orchestration constructs — plus a rule that specialist collaboration is
done with PROMPTS and plain subagents, not a team construct.

| | **Chain** | **Loop (orchestrate)** |
|---|---|---|
| Use when | the path is KNOWN | the path is UNKNOWN, done-ness is verifiable |
| Shape | declarative DAG of stages (YAML) | rounds until criteria/review/gate pass |
| Control flow | code-owned | code-owned rounds, LLM-owned within a round |
| Verification | per-stage `verify` (shell) + `judge` (fresh eyes) | criteria.json → independent review → devbrain gate |
| Learns | no | guardrails, learned steps, offline optimizer |
| Cost shape | cheapest (no coordinator turns) | one orchestrator turn per round |
| Human gates | budget_usd, on_fail | park/steer, blocked verdict, round budget |

## When to use which

- **You know the stages** (plan → build → review; migrate each file):
  **chain** — deterministic, reproducible, resumable, no orchestrator tokens
  spent deciding what a YAML file already knows.
- **You know the goal but not the path** (fix all failures; ship until smoke
  passes): **loop with a gate** — the path can't be scripted but done-ness can
  be machine-verified.
- A loop round may run a chain (chain tool) when a sub-task has a known shape.

## Collaboration without a team construct

Specialist collaboration = good briefs + plain subagents. The loop's round
prompt encodes the pattern:

- **Role personas live in the brief**: one line per worker
  (`scout: find+map only`, `builder: implement+test`,
  `qa: adversarial verify`). No standing roster needed — the persona is
  exactly as durable as the task that needs it.
- **Model routing is per-spawn**: the agent tool's `model` param
  (cheap scout, strong builder, different-vendor judge). No settings-level
  override layer required.
- **One coordinator, always**: the loop orchestrator (or you, interactively).
  Never delegate coordination to another coordinating agent — a second
  coordinator adds a hop, wastes rounds, and hides workers from the loop's
  worker mirroring.
- **Shared state is files, not chatter**: PROGRESS.md / criteria.json /
  GUARDRAILS.md are the collaboration medium; workers read excerpts in their
  briefs and results are verified by execution, not conversation.

This matches the strongest published practice (Anthropic's orchestrator +
fresh-context workers; Cognition's single-thread rule): rosters and standing
teams add configuration surface without adding capability.

**Teams (`/team`, presets/teams/*.yaml) still exist** in the fork as a config
layer (model routing presets, saved personas) but are NOT part of the
orchestration architecture — don't combine them with loops, and prefer
prompt-based collaboration for new work.

## Known non-overlaps that look like overlaps

- Chain `verify`/`judge`/`max_iters` is a *stage-local* retry — not a loop.
  It cannot re-plan; it re-delivers failure output to the same agent.
- The loop's verify mode (devbrain goal retry) is not a chain — it's typed
  triage (env/flake/product_bug) with budget-aware retries.
