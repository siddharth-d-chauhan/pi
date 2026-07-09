# Presets — chains and teams for development work

Versioned here in the fork; live everywhere via symlinks:

```
~/.pi/agent/chains -> /home/siddharth/pi/presets/chains
~/.pi/agent/teams  -> /home/siddharth/pi/presets/teams
```

## Chains (`/chain <name> [input]`, JSON for named inputs)

| Chain | Use for |
|---|---|
| `feature` | Plan → build (gated) → review. `{"task": …, "check": "npm run check"}` |
| `bugfix` | Root-cause locate → fix (gated) → adversarial root-cause judge |
| `review` | 3 parallel lenses (correctness/safety/simplicity) → ranked synthesis |
| `refactor` | Usage map → apply (gated) → missed-call-site review |
| `tests` | Find untested behavior → write passing tests (gated) |
| `audit` | Parallel deps/security/health sweeps → prioritized report |
| `investigate` | Hard question, 3 parallel angles → single synthesized answer |
| `migrate` | Mechanical sweep: JSON batch scout → SERIAL foreach fix → tree-wide gate |
| `docs` | Verified surface scan → accurate docs (no invented features) |

All chains carry a `budget_usd` ceiling and take a `check` input (default
`true` = no gate) — pass your repo's real command, e.g.
`/chain feature {"task": "add X", "check": "npm run check"}`.
Stages accept `model:` and `effort:` (thinking level) overrides.

## Teams (`/team apply <name>`)

Two kinds. **Routing teams** re-map which model each agent type uses:

| Team | Use for |
|---|---|
| `frugal` | Routine work — cheapest models, token discipline |
| `quality` | Shipping real code — strong plan/review, fast mechanical work |
| `speed` | Wide parallel fan-out with fast models |
| `deep` | Genuinely hard problems — strongest models everywhere |

**Roster teams** materialize specialists working together under a
coordinating `lead` (spawn `lead` with the agent tool, or just ask the
main agent to "have the team do X"). The lead hires members by name and
converses with them over `agent_message`; members can't sub-spawn.
Every member and the lead take `model:` and `effort:` (off/minimal/low/
medium/high) so you decide exactly what each seat costs.

| Team | Roster | Use for |
|---|---|---|
| `squad` | lead + scout, builder, qa | Feature work: map → build → sign-off |
| `bughunt` | lead + repro, diagnost, fixer, verifier | Bugs: repro + root-cause in parallel, minimal fix, verified against the repro |

Roster teams share the workspace (same working tree) and a **team
memory** file (`.pi/agent-memory/team-<name>/MEMORY.md`) injected into
the lead and every member — durable findings accumulate across runs.

## Managing presets from the UI

- `/presets` — create / edit / duplicate / delete chains, teams, and
  agent definitions with validated templates (bad YAML never saves).
- The **orchestra widget** above the prompt shows the active team's
  roster (model·effort per seat), running chains, and the live
  parent → child agent tree while anything is running.

## Context-rot rules baked into every chain

- Scouts (explore) do ALL the reading: no project context, cheap model,
  and a hard "≤N lines, name paths, don't paste code" output contract.
- Workers receive distilled results; anything >2k chars auto-passes as an
  `agent://` handle instead of inlining.
- Judges/gates feed failures back to the SAME agent (no respawn, no
  re-reading); every chain has a cost ceiling.
