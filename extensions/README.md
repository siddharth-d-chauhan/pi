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
| `plan.ts` | `update_plan` tool + live checklist widget above the editor; restores from the session branch (survives resume) |
| `agent-status.ts` | Below-editor strip of running subagents (status, age, log tail) fed by the background registry |
| `agent-hub.ts` | `/agents` overlay: live subagent roster with kill (`x`) and steer (`s`) |
| `agent-notify.ts` | Desktop + in-TUI notification when a background subagent completes or fails |
| `agent-footer.ts` | `/agentfooter` toggles a footer focused on subagent activity |

## Rules

- Import core singletons/read-APIs from `@earendil-works/pi-coding-agent` (shares
  the core module graph — no `globalThis` bridges).
- Erasable TypeScript only (no parameter properties); tabs; biome-clean.
- If an extension needs something the API can't reach, the fix is a minimal seam
  or read-API export in core — never feature logic in core.
