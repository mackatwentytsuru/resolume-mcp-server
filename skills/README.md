# Bundled Skills

This directory ships **Claude skills** alongside the MCP server. A skill is a
self-contained instruction bundle Claude Code loads on demand to operate a
specific tool or workflow.

## What's here

| Skill | Purpose |
|-------|---------|
| [`resolume-mcp-tester/`](./resolume-mcp-tester/SKILL.md) | Test harness for live Resolume verification — smoke tests, white-out prevention rules, state-restoration patterns, and agent invocation templates for the 36 tools this server exposes. |

## Install

The skills here are designed to be dropped into your Claude Code skill
directory. Pick the command for your platform:

### macOS / Linux

```bash
mkdir -p ~/.claude/skills
cp -r skills/resolume-mcp-tester ~/.claude/skills/
```

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force skills\resolume-mcp-tester "$HOME\.claude\skills\"
```

After copying, restart Claude Code so the harness picks up the new skill.
Verify it loaded with `/skills` in the Claude Code prompt — you should see
`resolume-mcp-tester` in the list.

## Why a skill instead of just docs?

`SKILL.md` files are loaded into the agent context **only when relevant**, so
they can carry deep operational knowledge (test recipes, safety rules, known
hardware quirks) without bloating every conversation. The
`resolume-mcp-tester` skill is the institutional memory accumulated across 12
releases of live testing against Resolume Arena 7.x — checked-in safety rules
that prevent white-outs, recipes for verifying silent-no-op traps, and
templates for parallel agent invocation.

## Versioning policy

The skill version (in the YAML frontmatter of each `SKILL.md`) **mirrors the
`package.json` version** after each release. When you cut a new server
release:

1. Bump `package.json` (`"version"`).
2. Bump every `SKILL.md` `version:` field in this directory to match.
3. Update `CHANGELOG.md` with anything that changed in the skill itself
   (new recipes, new safety rules, retired tools).

The CI sync check (`scripts/check-skill-sync.mjs`) enforces that the tool
catalog inside `SKILL.md` stays consistent with `src/tools/index.ts`, so
adding or removing a tool without updating the skill will fail the build /
fail `npm publish`.

## Contributing

When you add a new tool to the server, the skill must be updated in the same
commit. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) ("When you add a new
tool") for the full checklist.
