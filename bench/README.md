# Wave-0 benchmark harness

Measure the harness, not the model. The same model swings 30–50 points across
harnesses on Terminal-Bench 2.0 — so we measure completion + cost of a real
model through pi on a fixed task suite, and use it to test whether a harness
change actually helps.

## Agent lane (costs tokens)

```
node bench/run.mjs            # human table
node bench/run.mjs --json     # machine-readable
node bench/run.mjs --only <task>
```

Runs the configured model through `pi -p` per task, capturing **completion** (a
behavioral `check` on the edited file) and **tokens-to-done**. Set `BENCH_PI` to
point at a specific `pi` binary.

Use it as an A/B by flipping an env between runs — e.g. measure whether a feature
earns its cost:

```
node bench/run.mjs --json > before.json
KP_ADVISOR=1 node bench/run.mjs --json > after.json     # continuous critic on
PI_LOOP_REVIEW_LENSES=3 node bench/run.mjs --json        # independent review panel
```

## Adding tasks

Append to `tasks.json`: `file`+`content` (the seed file), `intent` (the English
task), and `check` (a behavioral assertion body `fn(m, text) => boolean` over the
imported edited module and file text). Keep tasks self-contained.

## Note

An earlier builtin-vs-hashline edit-format A/B lived here. hashline was removed —
it only helps weak models and cost capable ones ~18% more tokens (see
`RESULTS.md`). The harness is now a single-arm completion/cost baseline.
