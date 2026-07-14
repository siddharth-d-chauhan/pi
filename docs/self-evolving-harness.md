# Pi as a Self-Evolving Harness

Audit date: 2026-07-13

## Conclusion

Pi is a production-configured, self-adapting harness with retrieval memory and two narrow, human-gated durable mutation paths. It is not yet a self-evolving harness under the stricter empirical definition used in current research.

Today Pi can:

- change a running loop after repeated failures by adding a fixed corrective prompt step;
- aggregate loop failures across runs and let a human promote a versioned baseline step;
- cluster correction-like user messages across sessions and let a human promote a standing instruction;
- turn verified chain results, session episodes, and explicit memories into governed knowledge;
- retrieve that knowledge at boot and at selected task, action, debug, and delegation boundaries;
- dispatch periodic maintenance prompts through a separately started scheduler daemon.

The checkout now contains a narrow evaluator-first mutation path for loop prompt steps: frozen task manifests, content-addressed parent and candidate snapshots, concurrent paired execution, validation/held-out/replay/OOD splits, hard-gate-first decisions, human-gated promotion, and mutation-specific rollback. A host-side Pi RPC smoke benchmark completed 16 real-model attempts and exercised promotion and exact rollback, but its treatment was an observable marker-conformance instruction rather than a production-representative harness improvement. It therefore cannot show that a real harness mutation improved future production performance. It also has no reflective general proposer, post-promotion live regression controller, or automatically governed scheduler job for evolution rounds. The configured schedule still has no recorded fires.

The accurate label is therefore:

> A governed adaptive harness with retrieval memory and an evaluator-gated prompt-evolution mechanism, but no outcome-validated production mutation yet.

## What “self-evolving harness” means

An agent harness includes more than a system prompt. It includes prompts, tools, middleware, memory, runtime state, control flow, evaluation, and the model-tool interaction loop. A system becomes self-evolving only when it closes this loop:

```text
run tasks
  -> preserve evidence
  -> diagnose failures
  -> propose a versioned harness change
  -> evaluate old and new harnesses on controlled tasks
  -> promote, reject, or revert
  -> repeat with the decision and evidence preserved
```

Three weaker capabilities are often confused with this:

1. **Runtime adaptation** changes the current run but may disappear afterward.
2. **Learning memory** persists facts or instructions but may never test their effect.
3. **Harness evolution** changes a durable harness component and demonstrates an improvement under controlled evaluation.

Pi has the first two and a small part of the third. Persistence alone is not evolution, and passing the task that produced a lesson is not evidence that the lesson improves future tasks.

## Research baseline

Recent systems divide the problem into several distinct approaches.

### Empirical harness engineering

[Agentic Harness Engineering](https://arxiv.org/abs/2604.25850) treats the harness as editable, file-level components and emphasizes three observability requirements:

- **component observability**: every mutable component is inspectable, editable, and revertible;
- **experience observability**: long trajectories are distilled into evidence and root causes;
- **decision observability**: each change records a prediction that the next evaluation can confirm or refute.

Its important lesson for Pi is that gains need not come primarily from the system prompt. Tools, middleware, control flow, and long-term memory are also evolution surfaces.

[SEAGym](https://arxiv.org/abs/2606.17546) evaluates harness snapshots across training tasks, frozen validation, held-out in-distribution and out-of-distribution tasks, replay, and cost. It reports that frequent updates do not necessarily improve held-out performance and that later snapshots can regress after an intermediate peak. This makes snapshot retention and rollback part of the core loop, not optional cleanup.

### Prompt and context evolution

[GEPA](https://arxiv.org/abs/2507.19457) is a reflective prompt optimizer. It samples execution trajectories, uses natural-language reflection to propose prompt changes, evaluates candidates, and maintains a Pareto frontier that can combine successful candidates. A fixed mapping from failure class to canned instruction is not GEPA.

[Agentic Context Engineering](https://arxiv.org/abs/2510.04618) separates generation, reflection, and curation. It applies incremental context deltas so useful knowledge can grow and be refined without repeatedly rewriting the entire context. Pi's proposal and memory governance resembles part of this architecture, but Pi lacks an explicit outcome-driven reflector-curator loop.

### Code and architecture evolution

[Meta-Harness](https://arxiv.org/abs/2603.28052) places an outer agent around the harness. The proposer receives harness source, scores, and execution traces from prior candidates, then searches over harness-code changes.

[Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) retains an archive or tree of agent-code variants instead of relying on a single lineage. Benchmark results select which variants are expanded.

[A Self-Improving Coding Agent](https://arxiv.org/abs/2504.15228) and [Automated Design of Agentic Systems](https://arxiv.org/abs/2408.08435) similarly search over agent code or generated agent systems and use empirical evaluation to guide the search.

Pi does not currently mutate its own TypeScript, tool topology, permissions, or control-flow implementation. That is a sensible safety boundary. It also means claims about self-evolution should be scoped to the prompt and knowledge surfaces Pi can actually change.

## Actual production topology

The production settings at `~/.pi/agent/settings.json` point at this repository's `extensions/` directory. The extension loader discovers direct TypeScript children of that directory; 40 production extension files were present during this audit. A host-side TUI smoke run started without a visible extension-load error and showed the knowledge footer and boot context.

The relevant learning paths are:

```text
loop failures
  -> fixed in-run corrective step
  -> .pi/loops/_optimizer/journal.jsonl
  -> cross-goal failure grouping
  -> /loop optimize propose
  -> frozen paired baseline/candidate evaluation
  -> human /loop evolve promote <mutation-id>
  -> versioned baseline prompt steps with mutation-specific rollback

correction-like user messages
  -> ~/.pi/agent/self/corrections.jsonl
  -> semantic or keyword clustering
  -> human /self optimize apply
  -> Knowledge Platform preference or local standing instruction

verified chain result / session episode / explicit memory
  -> governed Knowledge Platform fact or proposal
  -> boot and boundary-specific retrieval
  -> later model context

scheduled maintenance prompt
  -> separately started pi-scheduler daemon
  -> non-interactive pi process
  -> any effects produced by that prompt
```

Only the first two paths durably alter future instructions. Neither currently performs a controlled old-versus-new outcome evaluation.

## Evidence from the actual system

The table distinguishes implementation from current runtime evidence.

| Capability | Implementation | Audit evidence | Classification and limit |
|---|---|---|---|
| Production extension wiring | Settings load `extensions/`; loader discovers direct `*.ts` files | 40 extension files present; host TUI booted without a visible load error | Configured and live-observed at startup, not individually exercised |
| Knowledge boot | [`knowledge.ts`](../extensions/knowledge.ts) and [`context-broker.ts`](../extensions/context-broker.ts) | TUI reported 9,296 facts, semantic readiness, `ctx 5`, and `kp 4+31` | Live-observed retrieval; not evidence of outcome improvement |
| In-run loop adaptation | [`loop.ts`](../extensions/loop.ts) | Source and focused tests | Runtime adaptation using fixed failure-class instructions |
| Cross-run loop optimization | [`loop-optimizer.ts`](../extensions/lib/loop-optimizer.ts) | No optimizer journal and no baseline file in this repository | Source-present; no live promotion or recurrence result to assess |
| Correction optimization | [`self-optimize.ts`](../extensions/self-optimize.ts) and [`correction-optimizer.ts`](../extensions/lib/correction-optimizer.ts) | Two heuristic correction records from two sessions; no standing-instruction file | Capture is live; no promoted instruction or measured effect |
| Governed memory capture | [`auto-learn.ts`](../extensions/auto-learn.ts), [`episodes.ts`](../extensions/episodes.ts), and [`chain-learn.ts`](../extensions/chain-learn.ts) | Knowledge Platform hot database exists and was updated; TUI reported semantic coverage | Learning memory; proposals and evidence tiers constrain injection |
| Reflective maintenance | [`dream.ts`](../extensions/dream.ts) | Dream state exists; last dispatch was about 41 hours before the audit | A dispatch timestamp does not prove the worker completed or improved memory |
| Durable scheduling | [`pi-scheduler.mjs`](../bin/pi-scheduler.mjs) and [`scheduler.ts`](../extensions/lib/scheduler.ts) | One schedule, zero aggregate fires, and no scheduler-state file | Daemon implementation exists; no durable execution observed for this repository |
| Codebase evidence | Codemap integration and context broker | No `.codemap` index under this repository | Potential evidence source, not active for this checkout |
| Focused verification | Evolution, learning, scheduler, extension-runner, and RPC tests | At audit time 45 of 46 tests passed; the fixture was subsequently fixed and the combined implementation result is 107 of 107 | Historical audit failure resolved; current focused verification is green |
| Harness outcome benchmark | [`evolution/evaluator.ts`](../extensions/lib/evolution/evaluator.ts), [`evolution/workflow.ts`](../extensions/lib/evolution/workflow.ts), and [`evolution/store.ts`](../extensions/lib/evolution/store.ts) | Process-level paired tests and a 16-attempt host-side Pi RPC marker smoke passed; no retained production-representative benchmark | Implemented, test-executed, and operationally smoke-tested; not outcome-validated |

The sandboxed `kp doctor` and direct local-service probes could not cross the sandbox's network and process boundaries. They are therefore inconclusive. The host-side Pi startup is the stronger observation for current Knowledge Platform reachability.

## What each learning mechanism really does

### Loop adaptation

After a repeated failure threshold, [`loop.ts`](../extensions/loop.ts) injects a predefined instruction for one of a small number of classes such as criteria, review, or gate failure. This is useful feedback control inside a run.

At run completion it can journal the goal, prompt version, rounds, rejections, completion state, and learned steps. `/loop optimize` groups recurring failures across distinct goal strings. A human can apply a candidate as a versioned baseline step.

The journal score remains a hand-written combination of completion, rounds, and rejections, and recurrence remains observational. Neither controls for task difficulty, model variance, temporal drift, or selection bias, so neither can authorize promotion. Promotion now uses the separate frozen paired evaluator. The previous “GEPA-lite” code label was removed: there is still no reflective proposer, candidate population, Pareto frontier, or candidate composition.

### Correction optimization

[`self-optimize.ts`](../extensions/self-optimize.ts) detects correction-like user messages and journals them. [`correction-optimizer.ts`](../extensions/lib/correction-optimizer.ts) clusters them with Knowledge Platform embeddings when available and keywords otherwise. The longest correction becomes the representative candidate. A human must apply it.

This is governed preference distillation, not outcome optimization. The system does not synthesize and compare multiple policies, attach the resulting preference to future success or failure, or calculate whether the correction stopped recurring.

Rollback is also split across stores. `/self forget` removes a local standing instruction, while Knowledge Platform-owned preferences require the Knowledge Platform's separate governed forget path. A single mutation identifier should link promotion and rollback across both stores.

### Knowledge learning

The Knowledge Platform provides the strongest governance in the system:

- user evidence can become confirmed;
- machine evidence can become supported;
- model-derived content remains proposed unless separately verified;
- proposed facts do not inject by default;
- semantic embeddings are model-keyed rather than silently overwritten;
- hot SQLite state serves packets while a cold graph remains the durable truth layer.

This prevents model guesses from becoming authoritative memory. It does not establish that injected facts make the harness better. To become part of an evolution loop, each promoted harness mutation must link to its source evidence, affected context packets, subsequent task outcomes, and rollback decision.

The context broker also has mixed invocation semantics. Boot retrieval is automatic, while some task and shift packets are model-invoked. Action, debug, spawn, and area-drift boundaries are harness-driven. Therefore “semantic memory is available” does not imply that every task received a task-specific packet.

### Dream and scheduling

`/dream` dispatches a worker prompt that asks for Knowledge Platform inspection and consolidation. Its state records dispatch, not verified completion. It is reflective maintenance, but it lacks a manifest of proposed changes, a before/after evaluation, and a completion receipt tied to those changes.

The scheduler is more capable than an in-session timer: a separately started per-project daemon uses leases, catch-up rules, and fire caps. It can run non-interactive Pi prompts while the TUI is closed. It is execution infrastructure, not an evolution controller. For this repository the audit found no recorded fire, so durable execution is source-present rather than live-verified.

## Observability assessment

### Component observability: moderate

Extension-based architecture makes most behavior file-level and inspectable. Versioned loop baselines are revertible in principle. However, mutable state is spread across repository-local optimizer files, global self-learning files, scheduler files, Knowledge Platform records, and extension source. There is no inventory that identifies every mutation surface, owner, schema, current version, and rollback command.

### Experience observability: moderate

Pi preserves loop summaries, corrections, episodes, chain outcomes, scheduler state, and Knowledge Platform evidence. These are useful signals, but they are not a unified trajectory record. Loop entries retain aggregate failure information rather than full trace references and root-cause evidence. A future optimizer cannot reliably reconstruct which tool call, context packet, instruction, or environmental condition caused an outcome.

### Decision observability: weak

Promotions do not share a mutation manifest containing a hypothesis, predicted metric movement, evaluation tasks, result, and rollback target. Version numbers alone say what was current, not why it changed or whether the prediction held.

### Governance: strong

Authority tiers, proposal-first model learning, human-gated promotion, and explicit forgetting are the right defaults. Code, permissions, and write authority are not automatically self-mutated. This boundary should remain even after evaluation automation is added.

### Outcome validation: absent

Criteria checks, review agents, and quality gates validate task output. They do not validate that a harness change caused improvement. The audit found no old/new paired benchmark. Subsequent implementation validation used a marker-conformance treatment to verify the mechanism, and the repository still has no production-representative live loop mutation to compare.

## Focused test result

The audit ran these tests from `packages/coding-agent` using the package-local Vitest binary:

```bash
node node_modules/vitest/dist/cli.js --run \
  test/loop-optimizer.test.ts \
  test/loop-criteria-checks.test.ts \
  test/loop-verdict-parse.test.ts \
  test/self-optimize.test.ts \
  test/correction-optimizer.test.ts \
  test/memory-integration.test.ts \
  test/memory-system.test.ts \
  test/context-broker-readonly.test.ts \
  test/auto-learn-extension.test.ts \
  test/dream.test.ts \
  test/every.test.ts \
  test/scheduler.test.ts \
  test/suite/agents/chain-learn.test.ts
```

Result: 12 of 13 files passed and 45 of 46 tests passed. The failing integration test was:

```text
optimizer command: journal -> distill -> apply -> next loop pre-loaded
TypeError: pi.registerShortcut is not a function
```

The fake Pi API in the test did not provide the shortcut registration now used by [`loop.ts`](../extensions/loop.ts). The pure optimizer logic in the same test file passed, but the command-level journal-to-apply flow did not run because extension initialization failed first. The implementation update below fixed the fixture and replaced direct apply with the evaluator-gated stage/evaluate/promote path.

This audit did not run the full repository check, full test suite, Knowledge Platform pytest suite, or a real model-based baseline/candidate benchmark. No outcome-validation claim follows from the focused test run.

## The minimum viable evolution loop for Pi

The first implementation should stay within the existing safe surface: loop baseline prompt steps. It should not begin with autonomous TypeScript edits.

### 1. Add a unified mutation ledger

Each candidate needs a durable record such as:

```text
mutation_id
parent_snapshot
surface and owner
source trace and fact ids
failure class and root-cause evidence
hypothesis
expected metric movement
candidate patch
train tasks
frozen validation tasks
held-out and replay tasks
baseline and candidate results
cost and latency deltas
decision
rollback target
```

Loop baselines, standing instructions, and Knowledge Platform preferences should reference the same mutation ID. This provides component and decision observability without merging all storage systems.

### 2. Preserve evaluation-ready traces

Extend loop journal entries with stable task, session, trace, context-packet, model, environment, and tool-result references. Keep summaries for fast inspection, but retain enough immutable evidence to reproduce a failure. Distinguish root-cause labels produced by deterministic checks, review agents, users, and models.

### 3. Build a paired replay evaluator

For a proposed loop step:

1. freeze a task set before proposing the change;
2. run the parent and candidate snapshots on the same tasks and model configuration;
3. use multiple samples where model variance matters;
4. enforce hard correctness and safety gates before soft scoring;
5. compare completion, criteria pass rate, reviewer result, rounds, rejections, latency, tokens, and cost;
6. include replay, held-out, and out-of-distribution tasks;
7. retain every evaluated snapshot.

Promotion should require an explicit improvement threshold with no hard-gate regression. A human remains the final approver initially.

### 4. Use an honest proposer

There are two valid starting choices:

- keep the deterministic failure-class distiller and name it accordingly; or
- implement a reflective proposer that receives selected traces, explains a root cause, produces a minimal candidate delta, and records a falsifiable hypothesis.

Only call the latter GEPA-like if candidates are actually evaluated and selected. Pareto search and candidate composition can be added after the paired evaluator is trustworthy.

### 5. Make rollback first-class

Promotion must atomically record the previous snapshot and provide one command that reverts all stores touched by the mutation. Runtime monitoring should compare post-promotion outcomes with the frozen expectation and recommend or perform a governed rollback when a hard regression appears.

### 6. Add durable orchestration last

Once evaluation and rollback are reliable, the existing scheduler daemon can trigger bounded evolution rounds. It should use a separate job type with an explicit budget, lease, snapshot, completion receipt, and approval state. A scheduler fire must record subprocess success separately from the fact that an attempt occurred.

## Recommended sequence

1. Fix the stale loop integration fixture and keep the focused suite green.
2. Add a read-only audit command that reports configured, live, promoted, and evaluated learning state.
3. Introduce the mutation ledger and cross-store mutation IDs.
4. Add evaluation-ready trace references to the loop journal.
5. Implement paired baseline/candidate replay for loop prompt steps.
6. Add explicit promotion and unified rollback.
7. Add a reflective proposer only after the evaluator can reject bad candidates.
8. Use the scheduler for bounded unattended evaluation only after completion receipts and budgets are enforced.
9. Expand mutation surfaces from prompt steps to tool or middleware configuration only after the narrow loop demonstrates held-out gains.

## Claim discipline

Future documentation and UI should use these labels:

- **source-present**: implementation exists in the checkout;
- **configured**: production settings select it;
- **loaded**: runtime confirmed registration;
- **test-covered**: an executable test exists;
- **test-executed**: that test was run, with its result reported;
- **live-observed**: a real host session produced the behavior or artifact;
- **outcome-validated**: a controlled baseline/candidate evaluation showed improvement;
- **operationally validated**: repeated live use maintained the improvement without unacceptable regressions.

For the 2026-07-13 audit, Pi's learning components are source-present and production-configured; Knowledge Platform boot is live-observed; most focused tests passed; loop prompt promotion and durable scheduler execution are not live-observed in this repository; and no harness mutation is outcome-validated.

## Refinements (2026-07-13 review)

The load-bearing external claims were checked against the primary papers. [SEAGym](https://arxiv.org/abs/2606.17546) reports that frequent updates may not improve held-out performance and that useful intermediate snapshots can regress later. [Agentic Harness Engineering](https://arxiv.org/abs/2604.25850) defines the three observability pillars and reports an ablation in which its gains came from tools, middleware, and long-term memory rather than its system prompt. These findings support evaluator-first promotion, but they do not establish that every prompt-oriented approach has a low ceiling or that development of all downstream components must stop until the evaluator is complete.

### R1. Use prompt steps to validate the evaluator, then expand the mutation surface

The minimum viable loop should begin with loop prompt and baseline steps because they are a low-risk, versionable mutation surface. This is an appropriate place to prove trace capture, paired execution, scoring, promotion, and rollback.

The AHE result is evidence that structural surfaces deserve attention after the evaluator is reliable; it is not a universal result about prompt optimization. Once prompt-step evaluation demonstrates held-out gains and reliable rejection of bad candidates, Pi can expand carefully into tool configuration, middleware, and retrieval or memory policy. Each surface still needs its own safety constraints and rollback mechanism.

### R2. Share evaluation infrastructure, but keep separate experimental protocols

The self-evolution replay evaluator and the leakage-free codebase-grounding A/B in `@vault/tools/knowledge-platform/docs/plans/codebase-grounding-spec.md` §4 need the same infrastructure in several places:

- immutable task and treatment manifests;
- isolated paired execution under fixed model, sampling, tool, time, and attempt budgets;
- frozen and held-out task sets;
- hard gates before soft scores;
- artifact, packet, trace, and snapshot retention;
- measured correctness, latency, token, and cost results;
- pre-declared decision rules.

They are not the same experimental protocol. Codebase grounding additionally requires temporal reconstruction at the pre-work revision, Knowledge Platform state as-of `T`, exclusion of the eventual implementation, four retrieval ablations, hidden tests, blinded judging, ACL enforcement, and grounding-specific retrieval and alignment metrics. Self-evolution additionally requires mutation and parent lineage, sequential update snapshots, separation of update evidence from evaluation evidence, replay and forgetting analysis, held-out transfer, promotion, and rollback.

Build one evaluation framework with separate adapters and schemas for these protocols. Reuse the existing Knowledge Platform `evaluation/` gold-case and gate machinery and the vendored Codemap ablation runner instead of creating a third unrelated evaluator. The shared framework should own execution, budgets, artifact storage, paired statistics, and decision records; protocol adapters should own temporal leakage controls, treatment construction, domain metrics, and promotion semantics.

### Resulting direction

The program remains evaluator-first for promotion and outcome claims. Proposers, claim extraction, and other components may be developed in parallel, but their output must not be promoted or described as effective until the relevant controlled evaluation passes. The governance boundary remains unchanged: do not autonomously mutate code, permissions, or write authority, and require a reversible snapshot plus explicit approval before broadening beyond prompt steps.

## Implementation update (2026-07-13)

The narrow prompt-step MVP is implemented in this checkout.

- `/loop optimize apply` is disabled. `/loop optimize propose` stages a mutation without changing the active baseline.
- `/loop evolve freeze <tasks.json>` freezes a content-addressed task manifest before proposal.
- `/loop evolve evaluate <mutation-id>` runs parent and candidate snapshots concurrently for each task/sample pair in isolated fixture copies. It requires validation, held-out, replay, and OOD tasks and uses two samples per task by default.
- Promotion requires no hard-gate failures or regressions, declared aggregate improvement, no held-out/replay/OOD quality regression, and bounded latency, token, and cost ratios.
- `/loop evolve promote <mutation-id>` is the explicit human approval step. It refuses unevaluated mutations and stale parent snapshots.
- `/loop evolve rollback <mutation-id>` restores the exact content-addressed parent snapshot and refuses to overwrite a newer baseline.
- `/loop audit` reports configured, proposed, evaluated, promotable, rejected, promoted, rolled-back, and trace state.
- Loop terminal records now link stable task, trace, snapshot, session, model, environment, context-packet, and hashed tool-result references.

Evolution state lives under `.pi/evolution/`. Manifests, snapshots, attempts, decisions, and artifacts are immutable; the active task-manifest pointer and active loop baseline are atomic mutable pointers. Captured stdout and stderr are bounded and redact common token, prefixed API-key, password, credential, bearer-token, and `sk-...` forms.

The task file is an array (or `{ "tasks": [...] }`) with this contract:

```json
[
  {
    "taskId": "criteria-held-out-1",
    "goal": "complete the fixture task",
    "split": "held_out",
    "fixtureDir": "bench/evolution/criteria-held-out-1",
    "command": ["node", "evaluate.mjs"],
    "hardGates": ["tests", "safety"],
    "env": { "FIXTURE_MODE": "strict" }
  }
]
```

Each command runs without a shell inside its own fixture copy. It receives `PI_EVOLUTION_ARM`, `PI_EVOLUTION_SAMPLE`, task and snapshot identifiers, and `PI_EVOLUTION_PROMPT_STEPS_JSON`. Its final JSON output must contain `completed`, `qualityScore`, `criteriaPassRate`, `rounds`, `rejections`, `latencyMs`, optional `tokens` and `costUsd`, and a `hardGates` object containing every declared boolean gate.

The process-level side-by-side test uses a cross-process barrier, so it fails if baseline and candidate are executed sequentially. Coverage includes acceptance, hard-gate rejection, held-out-regression rejection, timeout, stale-parent, rollback, audit, trace, immutability, and redaction cases.

Runtime task JSON is now validated before freezing, fixture directories may not contain the `.pi/evolution` state tree, stored snapshot and task-manifest hashes are rechecked on load, runner metrics must be finite and non-negative where applicable, and metrics JSON must be the final non-empty output line. Declared token and cost budgets fail closed when the runner omits the corresponding metric. Promotion rejects non-completed candidate attempt outcomes, uses measured wall time when it exceeds runner-reported latency, and requires the persisted decision to match an evaluated ledger event.

The combined focused verification result is 20 test files and 107 tests passing. It covers the evaluator, loop optimizer, learning and memory integrations, scheduler, extension runner, and RPC framing and command semantics. The full repository check also passes, including formatting, dependency pins, TypeScript import rules, shrinkwrap and install-lock verification, type checking, and the browser smoke check. A post-hardening host-side Pi RPC run completed all 16 attempts across validation, held-out, replay, and OOD splits; all eight arm pairs overlapped, no hard gate failed, the RPC decision matched the stored decision, promotion activated the candidate snapshot, and rollback restored the exact parent snapshot.

This is still not an outcome-validation claim. The automated passing candidate is a controlled synthetic fixture, and the live RPC candidate is a marker-conformance smoke treatment; both verify the evaluator rather than general harness quality. A frozen production-representative task set and retained model decision must pass before the harness is described as outcome-validated. Reflective proposal generation, unattended scheduling, automatic post-promotion rollback, broader mutation surfaces, and the shared Knowledge Platform/code-grounding protocol adapter remain gated on that result.

## KP Jira expert-case compiler (2026-07-13)

`/expert-cases build` now compiles the existing KP Jira corpus into immutable historical cases. It obtains repository roots from live `knowledge.list_repos`, reads the flattened Jira snapshots, accepts exact ticket keys in git commit summaries, and retrieves governed facts with `knowledge.facts_by_source(jira://KEY)`. It also joins authoritative Jira keys from Bitbucket PR titles/source branches to SSH-fetched merge commits through the exact repository and PR ID. Description-only keys remain ineligible. Repository aliases sharing one git root are deduplicated.

Multiple commits are retained. Pull-request merge summaries form individual `ChangeSet` boundaries; direct ticket commits within 14 days form a commit-series change set; reverts remain separate; branch-sync merges are excluded when an authoritative direct or PR commit exists. Each repository outcome records the earliest first parent, latest outcome revision, ordered commits, changed paths, test paths, and high/medium/low linkage confidence. Body-only ticket mentions are rejected because release and squash messages can transitively mention unrelated work.

Public task records contain the ticket snapshot, repository, and pre-change revision. Commit outcomes, changed paths, tests, and KP implementation facts live only in sealed records. The model-facing `expert_cases_search` tool automatically excludes an exact ticket key present in the query and excludes low-confidence links.

The current live Pi RPC build produced 782 linked cases from 1,804 Jira snapshots across 13 unique repositories: 767 high-confidence, 9 medium-confidence, and 6 low-confidence cases; 776 are learning-ready, 127 span multiple repositories, and 75.4% have supported or confirmed KP facts. All 782 public/sealed pairs passed immutable content-hash audit. The compiler includes the dataset split in immutable case identity, so corpus growth cannot mutate an existing case record. The earlier body-wide prototype produced 1,198 links but was rejected after quality analysis showed transitive merge-message overlinking.

### Bitbucket Jira-first multi-repository refresh

`/expert-cases refresh` now compiles KP cases and then resolves the canonical Bitbucket remote for every deduplicated KP repository. It indexes every PR merged into `release/*`, selects the latest 300 globally by Bitbucket `updated_on`, and expands every Jira key in that window across the complete release-PR history. A story is the top-level record; repositories, PRs, and commits remain outcomes below it. Exact Jira keys in the PR title or source branch are authoritative. Description-only keys are counted for audit but excluded from linkage because release-sync descriptions transitively contain unrelated tickets. Configured Jira project prefixes prevent version-like text such as `AES-256` or `SYNC-3` from becoming false tickets.

The live Pi RPC refresh indexed 8,078 release PRs across 13 repositories. In the global latest 300, 251 PRs had an authoritative Jira key, 49 did not, 23 carried multiple keys, and 121 unique stories were present. Thirty-eight stories spanned multiple repositories. `CIS-17218` alone linked 32 PRs across 11 repositories. The base REST evidence is immutable audit `bitbucket-audit-00a752ab91df14d01cda9570`.

Two additional authoritative Jira records were recovered from KP provenance and normalized into the flattened corpus. A later REST refresh still reached 12 repositories but received `401 Unauthorized` for `miniorange-iam-2020`, so it was rejected as incomplete. Git SSH access remained valid, and the compiler joined stored authoritative PR IDs to those merge commits. `/expert-cases reconcile` records its parent audit and updates only snapshot/expert-case coverage without claiming a new PR scan.

### Live Rovo and SSH refresh (2026-07-14)

The connected Rovo account supplied 107 previously missing Jira snapshots, which were normalized into the KP flattened corpus. Rovo could not retrieve `CIS-15933` or `IDPSEC-1`; individual reads report that each issue either does not exist or is not visible to the connected account. No Jira or Confluence records were changed.

Git SSH fetched every branch for all 13 repositories into repository-namespaced refs. The compiler then linked stored authoritative Bitbucket PR metadata to exact SSH merge commits by repository and PR ID. The active reconciled audit is `bitbucket-audit-fc03c79b7c415af92eb04687`: 119 of the 121 recent Jira stories have snapshots and compiled expert cases, and all 119 cover every repository proven by the Bitbucket audit. There are zero partial cases. The two unavailable Jira records remain explicit gaps; no Jira prose or PR metadata was fabricated.

The 776 eligible cases are learning-ready, not leakage-free evaluation-ready; the six low-confidence cases remain stored for audit but are excluded from retrieval. The available Jira export is a current snapshot without field-level changelog history, so its prose may contain notes added after implementation began. Promotion remains blocked until historical Jira as-of snapshots (or changelogs), KP as-of retrieval, exact pre-work codemap revisions, hidden tests, and blinded paired ablations are available.

## MiniMax M3 shadow-learning pipeline (2026-07-13)

`/expert-cases learn <query> allow-external [limit=2..8]` now runs a bounded claim-extraction pipeline through Pi RPC with `minimax/MiniMax-M3`. The explicit `allow-external` token is required because selected Jira/git evidence leaves the machine; without it, the command stops before the model call. It is intentionally a shadow pipeline: it writes immutable proposed-claim runs under `.pi/expert-cases/learning-runs/`, but it has no Knowledge Platform publication path. `/expert-cases learn-audit` rehashes every stored packet, claim, and run.

The pipeline:

1. selects only high/medium-confidence cases whose split is `train` and whose learning eligibility is true;
2. excludes an exact Jira key present in the query;
3. caps selection at eight cases and bounds facts, change sets, changed paths, test paths, evidence values, model output, and RPC duration;
4. starts an isolated Pi RPC child with extensions, tools, skills, sessions, prompt templates, and project context disabled;
5. verifies the selected provider/model before sending the evidence packet;
6. requires exact JSON with opaque evidence IDs;
7. requires implementation-pattern, contract, and test-strategy claims to cite at least two distinct cases, and rationale claims to cite ticket or governed KP-fact evidence;
8. rejects unknown evidence, unsupported repository scope, Jira-key-bearing generalizations, instruction-like text, invalid confidence, unexpected fields, oversized output, and non-JSON prose;
9. marks accepted model output `proposed`, `strong_model`, and `semantic`; and
10. keeps `published: false` for both passed and failed runs.

The focused synthetic tests pass the valid path and the fail-closed paths for held-out exclusion, weak single-case citation, fenced/non-JSON output, immutable reload, audit, and the no-publication invariant. A real Pi RPC call using MiniMax M3 on a synthetic two-case packet returned three valid claims; the run reloaded with the same content hash and the immutable audit reported 1/1 valid and passed. A separate live extractor call returned two valid claims with no rejections.

Initial verification did not send real Jira/git evidence to MiniMax: the host execution boundary rejected that external export and preserved those attempts as blocked, unpublished runs. On 2026-07-14 the user first approved a bounded UUID export and later explicitly approved sending evidence for every remaining active claim and paying for paired MiniMax M3 evaluations. That later approval was used for the full active-claim transfer run described below. The implementation still requires `allow-external` or an approved private/self-hosted model endpoint for each operational path.

### Governed full-corpus learning run

`/expert-cases learn-all local [batch=2..8] [concurrency=1..3]` performs resumable private structural learning over every eligible train case. It groups cases by shared repository and evidence terms, never includes calibration or held-out cases, and skips a batch when the same packet and extractor already have either a passing immutable run or a recorded local structural no-op. A no-op means the evidence was valid but contained no repeated structural pattern strong enough to claim; it remains blocked in the immutable validation record and is not retried indefinitely. The local extractor derives only directly observable repeated path and test-placement patterns. Its claims remain `proposed`, with `deterministic` authority and `structural` evidence strength.

The active-manifest local run covered all 620 eligible train cases in 78 batches. Seventy-seven batches passed with 318 cited structural claims, one batch completed as a valid no-op, and none failed operationally. A subsequent real Pi RPC invocation resumed all 78 batches without repeating extraction. The underlying active expert-case audit is 782/782 valid.

`expert_cases_search` now returns matching proposed claims alongside historical cases, including authority, evidence strength, source tickets, repositories, claim ID, and run ID. Multi-term queries require at least two matching claim terms to avoid injecting generic structural observations into unrelated work.

The original MiniMax M3 canary was denied by the tenant's private-data egress boundary, and no alternate exfiltration route was used. A later, explicitly approved bounded UUID packet was allowed. A full unattended MiniMax claim-extraction pass over the private corpus was not run; instead, the existing active claims were subjected to the separately approved paired transfer evaluation below. The completed local structural pass improves retrieval but, by itself, must not be described as semantic codebase expertise or outcome-validated improvement.

### Governed semantic review

The same validated claim path also accepts an in-workspace governed review executor (`codex/gpt-5`) for cases where external model egress is unavailable. Reviewed output is subjected to the identical exact-JSON, citation, cross-case, repository-scope, immutable-hash, shadow-state, and no-publication checks. These runs are recorded as `governed-review`, with `strong_model` authority and `semantic` evidence strength. This is a human-governed evidence synthesis path, not an unattended learner or a bypass around the MiniMax egress boundary.

The governed review completed nine thematic runs covering MFA, authentication sources, password lifecycle, rules and workflows, auditing, API and browser security, service and database boundaries, notifications, and privileged administration. After the Rovo/SSH compiler refresh changed the active manifest, each latest thematic run was remapped only when every cited evidence item matched the active case exactly; all nine remapped runs and all 19 semantic claims passed validation. Active retrieval returned the expected notification-lifecycle contract from the new manifest. Claim retrieval requires the run's source manifest hash to equal the active manifest, preventing old train/calibration/held-out assignments from leaking into a newer corpus. Historical runs remain immutable for audit.

The immutable learning audit verifies 313 of 313 stored runs; 305 are passing. The eight blocked historical runs consist of earlier unavailable-provider attempts and the two immutable attempts for the now-recognized structural no-op. The active structural layer covers every eligible train case. The semantic layer is a reviewed set of reusable cross-case patterns, not an assertion that every one of the 620 train cases has been individually semantically summarized. All claims remain proposed and unpublished; calibration and held-out cases remain untouched.

### Pi consumption verification (2026-07-14)

Normal repository prompts now retrieve expert evidence automatically; the user does not need to mention Jira, KP, learning, or `expert_cases_search`. Activation is restricted to the 13 indexed repository roots or a worktree with the same repository name, and results must include the active repository; multi-repository stories remain eligible when they include it. Before the first model call for a task, the extension searches the active store with the user's problem statement and prepares one bounded transient context block. That same block is present throughout the task's model/tool loop, is retained for brief `retry`/`continue` follow-ups, and is recomputed for the next problem prompt. It prioritizes directly relevant transfer-validated policies, then relevant historical Jira implementations with repositories, paths, tests, and governed facts, followed by at most two explicitly non-authoritative remembered hypotheses. Greetings, status-only prompts, and unrelated repositories inject nothing. Evidence is marked untrusted data, angle-bracket content is neutralized, target Jira keys remain excluded, and current-checkout inspection plus focused tests remain mandatory.

`expert_cases_search` remains available when the model needs broader, cross-repository, or differently worded retrieval, but it is no longer the primary activation mechanism. Its model prompt explicitly requires this manual fallback when automatic context is absent or insufficient. The tool searches both KP's supported hot-memory partition and the compiled Jira-to-git store, and returns a bounded payload rather than repeating full claim-run and ticket lists. Both automatic and explicit retrieval resolve the active expert store from the working repository when present, then fall back to the extension repository's central store; `PI_EXPERT_CASES_CWD` can override that location. A private mode-0600 derived search index caches the 776 retrieval-eligible cases, excluding the six low-confidence cases, plus 58 grouped governed claims. It is keyed by the active manifest, immutable learning-run names, immutable transfer-validation names, and index-builder version, and is rebuilt from audited source records when stale or corrupt. On the current corpus, an uncached direct scan took about 5.9 seconds; loading the persisted index took about 120 ms inside a fresh process, and subsequent in-process searches took about 18 ms.

Transfer-validated policies are also synchronized into KP through `pi.memory_writeback`. The transfer validation IDs are supplied as machine gate evidence, so these records enter KP as `supported` and are immediately eligible for default search; remembered or rejected claims are never synchronized. Records use the dedicated `expert-cases` project and `SEARCH_ONLY` injection class, preserving repository-specific automatic selection in the expert extension while making the policies available to manual KP-backed LLM search. Synchronization is idempotent, runs at Pi session start and after successful transfer evaluation, and can be forced with `/expert-cases kp-sync`. A mode-0600 state-key ledger avoids repeated writes when the active manifest and passing validations have not changed.

A live Pi RPC verification loaded the production Knowledge and expert-case extensions, forced synchronization, and reported all 12 active transfer-validated policy groups already present with zero failures. A manual search for the user-create/update execution boundary returned the corresponding KP fact as `supported` from group `iam_v2`, project `expert-cases`, through hot search in about 127 ms on the first run and 12 ms warm. A broad unrelated query correctly returned no KP expert-policy hit while still returning relevant compiled cases.

Target-ticket leakage protection applies to learned claims, remembered claims, and historical cases: if a query contains a Jira key, neither that case nor a grouped claim citing that key is returned. The Pi-facing synthetic suite verifies automatic injection without a tool call, task-to-task reset, generic-prompt silence, prompt visibility, case and active-claim retrieval, target exclusion, external-egress gating, evidence-gated KP synchronization, idempotent resumption, and KP-backed manual search. It passes 15 of 15 focused learning tests. A live extension-lifecycle probe against the active corpus automatically injected the validated user-create/update rule boundary plus three relevant Jira implementations for a plain problem prompt, without invoking `expert_cases_search`.

A subsequent read-only real-model A/B used the same IAM notification task in two fresh Pi RPC processes. The treatment arm had production extensions and called `expert_cases_search` exactly once; it returned the proposed notification-audience contract, five Jira source keys from the tool result, five relevant repositories, and a checkout-focused verification plan. The control arm ran without extensions, context files, skills, or tools; it returned no Jira sources or repositories and only a generic verification plan. Neither arm edited files or called another tool. This proves end-to-end model consumption and grounding on one task, not a statistically controlled improvement in implementation correctness.

### Transfer-learning gate (2026-07-14)

Claim extraction and retrieval are now named accurately: they create `rememberedClaims`, not learned policy. A claim becomes a `learnedPolicy` only after `/expert-cases transfer-evaluate <task.json> allow-external` or the resumable `/expert-cases transfer-all allow-external [concurrency=1..3]` records a passing paired transfer evaluation. `/expert-cases transfer-plan` audits full active-claim coverage without sending data.

Each transfer task freezes an unseen fixture hash, hidden judge hash, goal, retrieval query, expected claim IDs, hard gates, and timeout. The evaluator copies the fixture into isolated control and learned directories and starts both arms concurrently with the same explicit provider/model. Protocol 2 gives both arms the same task and retrieval-query text, while only the learned arm can call `expert_cases_search`; this prevents the query itself from becoming an unpaired hint. Automatic context injection is disabled inside this evaluator so the learned treatment remains exactly one observable retrieval call. After each model finishes editing, the hidden command scores that arm. Promotion requires all of the following:

- both attempts used the same provider and model;
- the learned arm completed and passed every hidden hard gate;
- it called `expert_cases_search` exactly once and consumed every expected claim ID;
- the control arm did not access expert knowledge; and
- learned hidden quality was strictly greater than control quality.

Every pass, mismatch, timeout, and failure is immutable under `.pi/expert-cases/transfer-validations/`. `/expert-cases transfer-audit` rehashes those records and reports current-protocol decisions separately from historical records. Active-manifest search labels exact claim IDs with their current-protocol transfer validation IDs; rejected, protocol-1, or stale-manifest evaluations cannot promote a claim. Equivalent claims with the same statement, type, and repository scope are grouped globally so one task covers every duplicate ID without losing source-run or ticket provenance.

The focused suite passes 15 of 15 tests, including a process-level paired Pi RPC and hidden-judge run, successful transfer promotion, remembered-only search before promotion, same-model enforcement, target-Jira leakage rejection, external-egress gating, immutable audit, evidence-gated KP synchronization, KP-backed manual search, and the Pi tool split between `learnedPolicies` and `rememberedClaims`.

The active manifest contains 337 claim IDs. Global equivalence grouping reduces those to 58 distinct statement/type/repository policy groups, each with one audited unseen task. The full protocol-2 run attempted all 58 groups with `minimax/MiniMax-M3`. Four initial comparisons were operationally invalid; they were retried once, and one judge-process failure received one additional retry after the judge was hardened to score module-load failures instead of aborting. Genuine quality ties and hidden-gate failures were never retried. Every superseded attempt remains immutable.

The final active classification is 12 transfer-validated policy groups covering 22 claim IDs and 46 rejected groups covering 315 claim IDs. Eleven successful groups are structural repository-routing policies, including recurring Maven, deploy, frontend utility, cloud-query, and service-area changes. One is the semantic user-create/update rule-execution boundary. In each successful comparison the learned arm moved from a failing or partial hidden score to 1.0; the semantic policy moved from 0.3 to 1.0. The remaining policies stay `rememberedClaims` because retrieval did not demonstrate a strict same-model advantage on their frozen unseen task.

The immutable transfer audit verifies 71 of 71 records: 63 are protocol 2, with 12 passing decisions. The 63 records include the 58 first attempts and five operational retries, so decision count is not policy-group count. Protocol-2 usage was 227,583 control tokens and 2,267,463 learned-arm tokens, with recorded provider cost of about $0.1923 total. The historical UUID validation used protocol 1, where only the learned arm saw the retrieval query; it remains auditable but is intentionally excluded from current `learnedPolicies`.
