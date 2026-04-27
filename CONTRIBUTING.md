# Contributing to resolume-mcp-server

Thanks for considering a contribution. This guide covers the workflow for
adding tools, the conventions the codebase follows, and the verification
steps required before opening a pull request.

## Getting started

```bash
git clone https://github.com/mackatwentytsuru/resolume-mcp-server.git
cd resolume-mcp-server
npm install
npm run build
npm test
```

`npm install` automatically activates the local git hooks via the `prepare`
script (no extra step needed). If for some reason they didn't activate —
e.g. you cloned with a tool that skipped lifecycle scripts — run
`npm run setup-hooks` to wire `core.hooksPath` to `.githooks/` manually.

Coverage is enforced at 80% across branches/functions/lines/statements via
the vitest config. Run `npm run test:coverage` before pushing if you've
touched anything beyond docs.

## Local git hooks

This repo uses native `.githooks/` scripts (no `husky`/`simple-git-hooks`
dependency) to give immediate feedback without waiting on CI:

| Hook | Runs | Cost | Bypass (last resort) |
|------|------|------|----------------------|
| `pre-commit` | typecheck (`npm run build`) + skill-sync drift check | ~3-5s | `git commit --no-verify` |
| `pre-push` | typecheck + full vitest suite + skill-sync | ~10-30s | `git push --no-verify` |
| `post-commit` | reminder if `SKILL.md` was touched | <100ms | n/a |

The hooks are POSIX shell scripts, so they work on macOS/Linux directly and
on Windows via Git Bash (which ships with Git for Windows).

## Project layout

```
src/
  resolume/         REST client, OSC client, Zod schemas, high-level facade
  tools/            one tool per file, grouped by domain (clip, layer, ...)
  server/           MCP server registration
  errors/           tagged-union ResolumeError + HTTP/network mappers
scripts/            ad-hoc smoke probes against a live Resolume + the
                    skill-sync checker
skills/             bundled Claude Code skill (resolume-mcp-tester)
```

Tests are colocated with sources as `*.test.ts`.

## When you add a new tool

Follow this checklist **in this order** — the sync script enforces step 4 at
publish time, so skipping it breaks `npm publish`.

1. **Add the tool source file** under
   `src/tools/{domain}/{verb-noun}.ts`. Export a `ToolDefinition` whose
   `name` starts with `resolume_` and whose handler delegates to a method on
   `ResolumeClient` (no raw `fetch` calls in tool files).
2. **Register it** in `src/tools/index.ts` by importing the tool symbol and
   adding `eraseTool(yourTool)` to the `allTools` array, in the section that
   matches its domain.
3. **Write at least one unit test** colocated as
   `src/tools/{domain}/{verb-noun}.test.ts`. Follow the existing pattern:
   mock the `ResolumeClient` facade and assert the handler shape, error
   path, and any input validation. Aim for happy-path + at least one error
   case.
4. **Update the skill** at `skills/resolume-mcp-tester/SKILL.md`:
   - Add the new tool to the relevant row in the "Tool catalog" section.
   - Bump the count in the `(N tools)` callouts.
   - If the tool needs special handling (silent-no-op trap, white-out
     risk, state-restoration pattern), add a recipe or safety note for
     it. Live testing will catch these — capture what you learn here.
5. **Update `CHANGELOG.md`** with a one-line entry under the next version
   (use `feat:` for new tools, `fix:` for bug fixes).
6. **Run the verification suite** before committing:
   ```bash
   npm run build
   npm test
   node scripts/check-skill-sync.mjs
   ```
   The sync check confirms `src/tools/index.ts` and the skill catalog agree.
   It runs in <1s and exits non-zero on any drift.

## Removing or renaming a tool

Same checklist, in reverse: drop the entry from `src/tools/index.ts`, delete
the tool file and its test, remove every mention from the skill (catalog +
any recipes that referenced it), and add a `BREAKING:` line to
`CHANGELOG.md`. The sync script will flag any leftover skill mention.

## Conventions

- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`, `perf:`, `ci:`. Short subject (<70 chars), longer body when the
  *why* matters.
- **Tool naming** — singular `verb_object`, all lowercase, `resolume_`
  prefix. Examples: `resolume_trigger_clip`, `resolume_set_layer_opacity`.
- **Indices are 1-based** — match Resolume's UI. Layer 1 is the first
  layer, not layer 0. Validation lives in `ResolumeClient`.
- **Destructive tools require `confirm: true`** — anything that wipes state
  (`clear_layer`, `wipe_composition`, `remove_effect_from_layer`) must
  refuse to act without explicit confirmation in the tool args.
- **Errors carry hints** — every `ResolumeError` variant includes a `hint`
  string the LLM can act on (e.g. "Resolume not running — ask the user to
  launch it"). Don't add a new error kind without one.
- **No `console.log`** in production code. Use the structured error path.
- **Immutability** — return new objects from helpers; do not mutate
  arguments.

## Live verification (optional but encouraged)

If you have Resolume Arena/Avenue running locally, the bundled skill at
`skills/resolume-mcp-tester/SKILL.md` ships smoke recipes for verifying new
tools against a live composition. Use Recipe B (snapshot → mutate → verify
→ restore) for every new write tool — Resolume silently drops invalid
operations, and unit tests can't catch that.

## Pull request expectations

- All CI checks green (build, tests, coverage, sync check).
- Branch up to date with `main`.
- PR description explains *why*, not just *what* — reviewers can read the
  diff for the *what*.
- If the change touches a tool's surface (new parameter, renamed field,
  changed validation), call it out in the PR body so reviewers know to
  exercise it manually.
