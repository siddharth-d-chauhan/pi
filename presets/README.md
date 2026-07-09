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

## Teams (`/team apply <name>`)

| Team | Use for |
|---|---|
| `frugal` | Routine work — cheapest models, token discipline |
| `quality` | Shipping real code — strong plan/review, fast mechanical work |
| `speed` | Wide parallel fan-out with fast models |
| `deep` | Genuinely hard problems — strongest models everywhere |

## Context-rot rules baked into every chain

- Scouts (explore) do ALL the reading: no project context, cheap model,
  and a hard "≤N lines, name paths, don't paste code" output contract.
- Workers receive distilled results; anything >2k chars auto-passes as an
  `agent://` handle instead of inlining.
- Judges/gates feed failures back to the SAME agent (no respawn, no
  re-reading); every chain has a cost ceiling.
