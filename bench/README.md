# Wave-0 benchmark harness

The metric that certifies "best." The harness — not the model — drives
reliability (the same model swings 30–50 points across harnesses on
Terminal-Bench 2.0), so we measure the harness.

## Lanes

### `edit` (default — deterministic, no model, no tokens)

```
node bench/run.mjs          # human table
node bench/run.mjs --json   # machine-readable
```

For each seed edit in `tasks.json`, compares the **builtin str-replace** edit
format against the **hashline** hash-anchored format on the two axes that decide
weak-model edit reliability:

- **apply-correctness** — does the edit produce the expected file?
- **edit-payload cost** — how much must the model *emit* to express the edit?
  builtin must re-quote the whole `old_string`; hashline emits two 3-char
  anchors + only the new text. The delta is exact and needs no model call.

This lane answers "did graduating hashline (Wave 1) move the needle?" today.
Current seed result: both formats apply correctly; hashline cuts mean
edit-payload ~45% (matching omp's reported ~50–61%).

### `agent` (model-driven — costs tokens)

```
node bench/run.mjs --lane agent
```

Runs a real mid-tier model through the loop per task via `pi --print`,
capturing **completion-rate** (criterion pass) and **tokens-to-done** (real
provider usage). Scaffolded; run deliberately with a budget. This is the lane
that certifies the leads and gates further waves.

## Adding tasks

Append to `tasks.json`: give `content` (starting file), `oldString`/`newString`
(the builtin edit), and `startLine`/`endLine` (the hashline range). Keep tasks
self-contained so the deterministic lane needs no external repo.
