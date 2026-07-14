# Production Extensions

Extensions we actually run, maintained here in the fork instead of patching core.
The fork's own code is modified only when a capability cannot live at this layer
(see AGENTS.md → Extensibility Principles).

## Loading

Add this directory to the `extensions` array in `~/.pi/agent/settings.json` so it
loads in every project:

```json
{
  "extensions": ["/home/siddharth/pi/extensions"]
}
```

Or per-invocation: `pi --extension /home/siddharth/pi/extensions/plan.ts`.

## Extensions

| Extension | Description |
|-----------|-------------|
| `acp-details.ts` | RPC-only interactive parity: full tool-call labels, visible thinking summaries, and per-run usage/cache/cost |
| `plan.ts` | `update_plan` tool + live checklist widget above the editor; restores across resume and gives bounded reconciliation nudges after sustained mutations |
| `agent-status.ts` | Claude-style footer segment: `● N agents`, green circle when some of several are done, clears when all finish |
| `prompt-history.ts` | Persistent shell-style prompt history: Up arrow recalls your last 100 prompts across all sessions |
| `agent-hub.ts` | `/agents` Claude-style activity overlay: subagents + loops + background processes, status sections, filters, detail/log navigation, kill/message/revive |
| `agent-notify.ts` | Desktop + in-TUI notification when a background subagent completes or fails |
| `agent-footer.ts` | `/agentfooter` toggles a footer focused on subagent activity |
| `chain-command.ts` | `/chain <name> [input]` runs a chain; `/chain new <desc>` scaffolds one; `/chain` lists |
| `team.ts` | `/team apply <name>` activates a team preset (.pi/teams/*.yaml): per-type model overrides + disabled agents |
| `agent-watch.ts` | Watches agent/chain/team definition dirs and re-announces changes to you and the model |
| `agent-reuse.ts` | Exposes this session's idle/parked subagents to the model so matching follow-up work reuses their retained context instead of spawning duplicates |
| `tool-cards.ts` | omp-style colorful rounded-border cards for all built-in tool calls (per-tool colors) |
| `expert-cases.ts` | Automatically injects bounded, leakage-safe KP Jira→git evidence for matching prompts inside indexed repositories, with a persistent derived search index and an explicit search tool for broader retrieval; claims remain remembered until paired transfer proves improvement |
| `context-broker.ts` | Injects governed KP context, tracks WorkFrame epochs, and transiently removes superseded task packets while retaining the persisted audit trail |
| `token-budget.ts` | Caps every oversized text tool result, suppresses identical read/search results, and adds discovery/tool-loop budgets |
| `doom-loop.ts` | Stops repeated or alternating tool-call thrash using operation-normalized signatures |
| `compact-patch.ts` | Replaces the verbose exact-replacement `edit` schema with strict single-file unified hunks; set `PI_COMPACT_PATCH=0` to retain `edit` |
| `cache-recovery.ts` | Compacts and resumes after cache collapse, task shifts, or a long tool loop crossing the context ceiling |
| `aidlc.ts` | `/aidlc <intent>` runs the real awslabs/aidlc-workflows v2 engine (central install `~/.pi/aidlc-workflows`, override `PI_AIDLC_HOME`; needs bun): deterministic stage routing/state/gates stay in the engine, the model conducts one directive at a time, a bounded `agent_settled` guard re-arms an abandoned loop; zero context cost while inactive |
| `quality-gate.ts` | Deterministic edit-quality lane (ported as behavior from ECC's hook suite): batch `tsc --noEmit` over this run's edited files at settle, console.log/debugger debris warnings, first-edit block on lint/format/ts configs ("fix the code, not the gate"; deliberate retry passes), and a `git commit --no-verify` block. Zero LLM cost; `PI_QUALITY=0` or `.pi/quality.json` per-check switches |
| `ecc.ts` | `/ecc <command> [args]` mounts the ECC content library (affaan-m/ECC: ~94 command playbooks, ~278 skills, 22-language rules packs) on demand from `~/.pi/ecc` (`PI_ECC_HOME`); `/ecc rules <lang>` loads common+language conventions once, `skill <name>`/`search <term>` for the rest; one file loads per invocation, Claude-Code tool names adapted via preamble, ECC's hook runtime deliberately not wired (duplicates pi's doom-loop/token-budget/auto-learn/KP); zero context cost while unused |

Token controls can be tuned with `PI_TOOL_RESULT_MAX_CHARS`,
`PI_DISCOVERY_CHECKPOINT_CALLS`, `PI_TOOL_CHECKPOINT_CALLS`,
`PI_PRIMARY_MAX_TOOL_CALLS`, and `PI_SUBAGENT_MAX_TOOL_CALLS`. Defaults are
12,000 result characters, 12 discovery calls, 24 calls before a finish checkpoint,
hard limits of 32 primary or 14 subagent calls. Oversized child results retain a
head/tail preview and spill the complete text for narrow recovery. Repetition
control belongs to `doom-loop.ts` and is tuned
separately with `KP_DOOMLOOP`.

Mid-run compaction defaults to 160,000 context tokens so a single long tool
loop cannot bypass the normal post-run compaction ceiling. Tune it with
`PI_MIDRUN_COMPACTION_TOKENS`; set it to `0` to disable only this trigger.
Core subagent runs enforce the same configured compaction ceiling even though
children intentionally skip production extensions. They also receive a bounded
goal contract, an eight-call scope checkpoint, a 14-call hard tool ceiling, and
a 12,000-character cap on each tool result.

## Rules

- Import core singletons/read-APIs from `@earendil-works/pi-coding-agent` (shares
  the core module graph — no `globalThis` bridges).
- Erasable TypeScript only (no parameter properties); tabs; biome-clean.
- If an extension needs something the API can't reach, the fix is a minimal seam
  or read-API export in core — never feature logic in core.
