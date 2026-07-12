# Wave-0 benchmark results

> **hashline was REMOVED** after this measurement. Its only win is edit
> reliability on weak models; on a capable model it was pure overhead (+18%
> tokens, per-turn tool-schema cost). The result below is kept as the rationale.
> The harness is now a single-arm completion/cost baseline for testing other
> features.

## Deterministic edit lane (no model) — historical

hashline cut mean edit-payload ~45% vs builtin str-replace by not re-quoting old
text (matching omp's 50–61%). Real, but *payload only* — see below for why it
didn't translate to a session-level win.

## Agent lane (MiniMax-M3, 4 tasks × 2 formats, 1 run each) — historical

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

## Defect-catch benchmark (MiniMax-M3, 5 planted bugs × 2 review modes × 2 runs)

`node bench/defects.mjs` — does the shipped 3-lens review catch bugs a generic
review misses? Catch = VERDICT buggy AND the reviewer names the specific defect.

| Defect | generic | lenses |
|---|---|---|
| off-by-one-paginate | 2/2 | 1/2 |
| inverted-retry | 2/2 | 2/2 |
| empty-average-nan | 2/2 | 2/2 |
| unanchored-id-regex | 2/2 | 1/2 |
| foreach-async-race | 2/2 | 2/2 |
| **total** | **10/10 (100%)** | **8/10 (80%)** |

**Finding: the 3-lens single-reviewer default did NOT help and slightly hurt.**
Generic direct review caught every defect on both runs (100%, perfectly
consistent). The 3-lens ritual caught fewer and beat generic on nothing — the
misses were run-2 variance (run 1 caught them), i.e. the elaborate checklist
made a capable model LESS consistent, not more thorough. Same lesson as hashline:
don't over-structure a strong model.

**Action:** the loop's DEFAULT review is now a single DIRECT adversarial
correctness review (what measured best). The multi-lens structure is kept only
for the OPT-IN independent panel (`PI_LOOP_REVIEW_LENSES>1`) — a different
mechanism (independent perspectives + majority vote) that's plausibly better on
hard multi-file defects but is NOT yet validated here.

**Caveats:** n=2 repeats; single-file, individually-catchable defects. This does
NOT test the hard case (subtle multi-file interactions) where lens separation +
an independent panel might still earn its keep — that remains the open question.
