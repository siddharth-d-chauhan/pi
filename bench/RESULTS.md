# Wave-0 benchmark results

## Deterministic edit lane (no model)

`node bench/run.mjs` — measures apply-correctness + emitted edit-payload tokens.

Both formats apply correctly (5/5). **hashline cuts mean edit-payload ~45%** vs
builtin str-replace by not re-quoting the old text (matching omp's reported
50–61%). This is the *payload* win and it is real.

## Agent lane (MiniMax-M3, 4 tasks × 2 formats, 1 run each)

`node bench/run.mjs --lane agent` — a real mid-tier model through pi headless,
forced to use each edit FORMAT. Measures completion + total tokens-to-done.

| Task | builtin | hashline | Δ |
|---|---|---|---|
| replace-function-body | ✓ 44,744 | ✓ 48,292 | +7.9% |
| change-config-value | ✓ 28,706 | ✓ 45,354 | +58% |
| delete-dead-branch | ✓ 38,921 | ✓ 37,762 | −3.0% |
| rewrite-large-block | ✓ 29,552 | ✓ 36,524 | +23.6% |
| **completion** | **4/4 (100%)** | **4/4 (100%)** | |
| **mean tokens-to-done** | **35,481** | **41,983** | **+18%** |

## What this means (honest read)

1. **Completion parity at this tier.** MiniMax-M3 completed 100% with *either*
   format. The dramatic reliability win hashline shows in omp's benchmark is on
   a *weaker* model (Grok Code Fast 1: 6.7%→68.3%) — a capable model doesn't
   need the format to land these edits. Reliability is where hashline pays, and
   this model tier is above the threshold where it matters for these tasks.

2. **hashline cost MORE total tokens (+18%) despite the 45% payload win.** The
   payload saving is on the *edit* only; the agent lane counts the whole session,
   and forced-hashline always pays an extra `hread` (the file re-read with
   anchors). On small files that overhead dwarfs the payload saving. It only broke
   even on `delete-dead-branch`. The one-line `change-config-value` was worst
   (+58%): re-reading the file to hash it is pure overhead for a trivial change.

3. **Actionable:** do NOT default the model to hashline. It earns its keep on
   (a) weaker models that thrash on string-match edits, and (b) large edits where
   re-quoting `old_string` is expensive. Two fixes would flip the economics:
   make `hread` REPLACE the initial `read` (here the model often did both), and
   make the hashline nudge conditional on model tier / edit size rather than
   always-on.

## Caveats

Small n (4 tasks, small files), one model, single run each (no variance). Token
counts include heavy navigation (find/bash/read) the model chose. This measures
*token cost*, not the *reliability* axis where hashline's real claim lives —
that needs a genuinely weak model and/or harder edits to exercise.
