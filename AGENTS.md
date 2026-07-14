# Development Rules

Detail for rare workflows (releasing, PR review mechanics, tmux TUI testing, changelog format) lives in `docs/agents.md` — read the relevant section there before doing those tasks.

## Conversational Style

- Short, direct, technical prose; no emojis in commits/issues/PRs/code; no fluff.
- Answer the user's question first, before edits or commands.
- When responding to feedback, say whether you agree or disagree before saying what you changed.

## Fork Maintenance

Fork of `earendil-works/pi` (remote: `upstream`); every change must stay upstream-mergeable.

- Prefer additive changes: new files, providers, components, extensions over editing upstream files. Upstream edits stay minimal and hook-sized; never reformat/reorder/rename beyond the change; never delete upstream files.
- On `*.generated.ts` conflicts, take upstream and regenerate; never hand-merge.
- Small single-topic commits; sync via `git fetch upstream && git merge upstream/main`. Non-fork-specific fixes are upstream-PR candidates.

## Extensibility

Escalation ladder — lowest rung that works:
1. Extension via ExtensionAPI (production extensions in `/extensions`; examples in `packages/coding-agent/examples/extensions/`). Import core read-APIs from `@earendil-works/pi-coding-agent` (shared module graph).
2. New module/component in its own file, wired with a one-line registration.
3. A generic seam in an upstream file (hook, optional field, action id) — one upstream would plausibly accept as a PR.
4. Editing upstream logic in place — last resort, hook-sized.

Seam rules: optional and undefined-safe (unset = exact upstream behavior); feature logic never inside core loops (`TUI.render`, `Container`, interactive-mode dispatch); new keys = new action ids in `KEYBINDINGS`/`TUI_KEYBINDINGS`, never rebind upstream actions; theme/schema additions are optional keys with fallback to an existing key; new settings are optional fields defaulting to upstream behavior; TUI components implement `Component` and compose via `Container`; new tui exports append to `packages/tui/src/index.ts` without reordering.

## Code Quality

- Understand code before changing it: don't act from search snippets alone. Read the full files a change spans when they're small or the change is wide-ranging; otherwise read the relevant symbols/sections (grep/codemap first, then targeted ranges) instead of paging whole large files.
- No `any` unless necessary. No inline/dynamic imports — top-level only. Inline single-use one-line helpers. Check node_modules for external API types.
- Only erasable TypeScript (Node strip-only) in root-config code: no parameter properties, `enum`, `namespace`, `import =`/`export =`.
- Never remove/downgrade code to fix type errors from outdated deps; upgrade the dep. Ask before removing intentional-looking functionality. No backward compatibility unless asked.
- Never hardcode key checks; add defaults to `KEYBINDINGS`/`TUI_KEYBINDINGS`.
- Never edit `packages/ai/src/models.generated.ts` by hand; change `generate-models.ts` and regenerate (including the regenerated diff is always OK).

## Commands

- After code changes (not docs): `npm run check` (full output); fix all errors/warnings/infos before committing. Never `npm run build` or `npm test` unless asked.
- Never run the full vitest suite (it has env-gated e2e tests). Use `./test.sh` from repo root, or specific tests: `node ../../node_modules/vitest/dist/cli.js --run test/x.test.ts` from the package root.
- New/modified test files: run and iterate until green. `test/suite/` uses `harness.ts` + the faux provider (no real APIs/keys). Issue regressions go in `test/suite/regressions/<issue>-<slug>.test.ts`.
- Ad-hoc scripts: write to a temp file, run, remove. Never commit unless the user asks.

## Dependencies

- Deps/lockfiles are reviewed code; direct deps stay exact-pinned. Install with `--ignore-scripts` (`npm install` / `npm ci`); lockfile-only refresh via `npm install --package-lock-only --ignore-scripts`.
- Shrinkwrap regen: `node scripts/generate-coding-agent-shrinkwrap.mjs`; new deps with lifecycle scripts need review + explicit allowlist there.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`; don't bypass unless the user wants the lockfile committed.

## Git

Multiple pi sessions may share this cwd; touching files outside your own changes stomps their work.

- Commit only files YOU changed this session; stage explicit paths — never `git add -A` / `git add .`; verify with `git status` first. `models.generated.ts` may ride along.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <message>`, informative and concise.
- Never: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`, force push.
- Rebase conflicts: resolve only in files you modified; otherwise abort and ask.

## User Override

If the user's instructions conflict with any rule here, ask for explicit confirmation before overriding. Only then execute their instructions.
