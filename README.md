# Resolume MCP Server

[![npm version](https://img.shields.io/npm/v/resolume-mcp-server.svg)](https://www.npmjs.com/package/resolume-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Control [Resolume Arena/Avenue](https://resolume.com/) from AI assistants like Claude using the [Model Context Protocol](https://modelcontextprotocol.io). Trigger clips, fade layers, and pull thumbnails — all through natural language.

```text
Claude  ⇆  resolume-mcp-server  ⇆  http://localhost:8080  ⇆  Resolume Arena
                  (this)                 (Web Server)
```

## Why this server?

Three other Resolume MCP servers exist; this one focuses on a **deliberate middle ground**:

- **Curated tool count** — every tool earns its place. Wide-net registries (200+ tools) confuse the model.
- **Type-safe end to end** — Zod schemas on every input, structured errors with recovery hints the LLM can act on.
- **Visual identification** — `resolume_get_clip_thumbnail` returns the actual image, so Claude can pick the right visual when names are ambiguous.
- **Destructive-action gating** — `clear_layer` requires explicit `confirm: true` to prevent accidental wipes during live performance.
- **Helpful errors** — every error variant carries a `hint` field telling the LLM what to do next ("Resolume not running — ask the user to launch it and enable the Webserver").
- **Push-driven cache** *(v0.5+)* — opt-in `CompositionStore` consumes Resolume's OSC OUT broadcast (~325 msg/s) so high-frequency reads (clip playhead, BPM, layer opacity) don't pay a REST round-trip.
- **Stability tiers** *(v0.5+)* — every tool carries `stability: stable | beta | alpha`; the `RESOLUME_TOOLS_STABILITY` env filter lets risk-averse operators hide unstable tools.
- **Live-tested** — every release verified end-to-end against a real Resolume Arena 7.23. Silent no-ops, wire encoding regressions, and Resolume internals (effect-id re-keying after PUTs, double-broadcast of UI-bound parameters) are documented in `docs/v0.5/`.

## Requirements

- **Node.js 20+**
- **Resolume Arena 7.8+** or **Avenue 7.8+** with the Web Server enabled:
  1. Open Resolume → `Preferences` → `Web Server`
  2. Toggle **Enable Webserver & REST API** on
  3. Default port is `8080` (Arena/Avenue) or `8081` (Wire)

## Install

```bash
npm install -g resolume-mcp-server
```

Or run without global install via `npx`:

```bash
npx resolume-mcp-server
```

## Configure for Claude

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "resolume": {
      "command": "npx",
      "args": ["-y", "resolume-mcp-server"],
      "env": {
        "RESOLUME_HOST": "127.0.0.1",
        "RESOLUME_PORT": "8080"
      }
    }
  }
}
```

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "resolume": {
      "command": "npx",
      "args": ["-y", "resolume-mcp-server"]
    }
  }
}
```

### Environment variables

#### Core (always relevant)

| Variable | Default | Description |
|----------|---------|-------------|
| `RESOLUME_HOST` | `127.0.0.1` | Host running Resolume's Web Server |
| `RESOLUME_PORT` | `8080` | Web Server port (8080 Arena/Avenue, 8081 Wire) |
| `RESOLUME_TIMEOUT_MS` | `10000` | Per-request timeout in milliseconds |
| `RESOLUME_OSC_HOST` | `127.0.0.1` | Host running Resolume's OSC ports (same as REST host in most setups) |
| `RESOLUME_OSC_IN_PORT` | `7000` | Resolume's OSC IN port — we send to this |
| `RESOLUME_OSC_OUT_PORT` | `7001` | Resolume's OSC OUT port — we listen on this for queries/subscriptions |

#### v0.5+ feature flags (all opt-in; defaults reproduce v0.4 behavior bit-for-bit)

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `RESOLUME_CACHE` | empty / `0` / `1` / `owner` / `passive` / `shared` | empty (off) | Enables the in-memory `CompositionStore` cache fed by Resolume's OSC OUT broadcast. `1` / `owner` binds the OSC OUT port exclusively; `passive` / `shared` lets other tools feed the cache via `feed()`. EADDRINUSE on `owner` bind auto-degrades to `shared` mode with a stderr warning. |
| `RESOLUME_EFFECT_CACHE` | `0` / `1` / `true` / `false` | `1` (on) | Effect-id cache for `setEffectParameter`. Single-flight on concurrent calls; layer-wide invalidation on add/remove/wipe/deck-switch. Set to `0` to bisect drift bugs. |
| `RESOLUME_TOOLS_STABILITY` | `stable` / `beta` / `alpha` | `beta` | Tool tier visibility filter. `stable` hides beta+alpha tools; `alpha` exposes everything (operator escape hatches like `resolume_cache_refresh`). |
| `RESOLUME_WIPE_CONCURRENCY` | `1`..`16` | `4` | Per-layer parallel POST cap for `wipeComposition`'s `/clearclips` dispatch. Conservative default keeps Resolume's single-threaded HTTP server happy. |

## Tools (v0.5.4 — 39 tools)

All tools are prefixed with `resolume_` to avoid collision with other MCP servers. Indices are **1-based** to match Resolume's UI. Every tool carries an explicit `stability` tier; `tools/list` decorates the description with `[BETA]` / `[ALPHA]` prefixes when applicable, and the `RESOLUME_TOOLS_STABILITY` env var filters what's exposed (default `beta` shows stable+beta, `alpha` shows everything, `stable` hides everything not yet promoted).

### Composition
| Tool | What it does |
|------|--------------|
| `resolume_get_composition` | Returns version, BPM, layers (with connected clip + bypass state), columns, decks. **Call first.** |
| `resolume_get_beat_snap` | Current clip beat-snap value + available options (None, 1 Bar, 1/2 Bar, etc.). |
| `resolume_set_beat_snap` | Sets clip beat-snap. Triggered clips wait for the next beat boundary — the core BPM-sync mechanism. |
| `resolume_get_crossfader` / `resolume_set_crossfader` | Master A/B crossfader. -1 = full Side A, 0 = center, 1 = full Side B. |

### Clips
| Tool | What it does |
|------|--------------|
| `resolume_trigger_clip` | Plays the clip at `{layer, clip}` — the most common VJ action. |
| `resolume_select_clip` | Selects without playing. Useful before adjusting parameters. |
| `resolume_get_clip_thumbnail` | Returns the clip's preview image inline so the LLM can see it. |
| `resolume_get_clip_position` *(v0.5.1+)* | Reads the normalized 0..1 transport position. Cache-first when `RESOLUME_CACHE=1` (sub-ms cache hits, no REST round-trip); REST fallback otherwise. Tagged with `source: "cache" \| "rest"`; cache hits include `ageMs`. |
| `resolume_set_clip_play_direction` | Forward (`>`) / pause (`||`) / reverse (`<`). |
| `resolume_set_clip_play_mode` | Loop / Bounce / Random / Play Once & Clear / Play Once & Hold. |
| `resolume_set_clip_position` | Seek to a specific playback position (re-trigger from start, jump to cue points). |
| `resolume_clear_clip` | **Destructive.** Empties a single clip slot (removes loaded media). Requires `confirm: true`. |
| `resolume_wipe_composition` | **Destructive.** Empties every clip slot on every layer in the active composition via per-layer `/clearclips` POSTs. Concurrency cap configurable via `RESOLUME_WIPE_CONCURRENCY`. Requires `confirm: true`. |

### Layers
| Tool | What it does |
|------|--------------|
| `resolume_set_layer_opacity` | Fades a layer (`opacity` in 0..1). Smooth fades = multiple small steps. |
| `resolume_set_layer_bypass` | Mutes/unmutes a layer without losing the connected clip. |
| `resolume_set_layer_blend_mode` | Changes layer blend mode (Add, Multiply, Screen, etc.). |
| `resolume_list_layer_blend_modes` | Lists the 60+ blend modes available. |
| `resolume_set_layer_transition_duration` | Per-layer transition fade duration (0..10s, 0 = instant cut). |
| `resolume_set_layer_transition_blend_mode` / `resolume_list_layer_transition_blend_modes` | Visual transition effect (Alpha, Wipe Ellipse, Push Up, ...). 50+ options. |
| `resolume_clear_layer` | **Destructive.** Disconnects all clips. Requires `confirm: true`. |

### Columns / Decks
| Tool | What it does |
|------|--------------|
| `resolume_trigger_column` | Fires every clip in a column simultaneously — standard scene change. |
| `resolume_select_deck` | Switches deck (scene bank). |

### Tempo
| Tool | What it does |
|------|--------------|
| `resolume_get_tempo` | Returns current BPM and the accepted range (typically 20..500). |
| `resolume_set_bpm` | Sets exact BPM (e.g., for synced sets). |
| `resolume_tap_tempo` *(beta)* | Sends taps to the tap-tempo controller (single tap or multi-tap with interval). |
| `resolume_resync_tempo` | Sends a resync trigger to align Resolume's beat clock to the next downbeat. |

### Effects
| Tool | What it does |
|------|--------------|
| `resolume_list_video_effects` | ~105 video effects available globally, with `idstring` + `name`. |
| `resolume_list_layer_effects` | Effects on a layer with full parameter metadata: type, current value, min/max, and choice options. |
| `resolume_set_effect_parameter` | Mutates any parameter on an attached effect. Auto-coerces string-encoded numbers/booleans to match the parameter's declared type. |
| `resolume_add_effect_to_layer` | Adds a video effect by name to the end of a layer's effect chain. |
| `resolume_remove_effect_from_layer` | Removes the effect at a 1-based position. **Destructive** — requires `confirm: true`. |

### OSC (v0.4)
OSC complements REST/WS with a few things they can't do: wildcard reads, real-time playhead push, and a handful of trigger paths not in the REST swagger. Requires Resolume's `Preferences > OSC > OSC Input/Output` to be enabled.

| Tool | What it does |
|------|--------------|
| `resolume_osc_send` | One-shot OSC message. Power-user escape hatch for paths like `/composition/tempocontroller/resync`. |
| `resolume_osc_query` | Sends `?` query (with optional wildcards) and returns Resolume's echoed values. Fastest way to read many values at once. |
| `resolume_osc_subscribe` | Listens on the OSC OUT port for a duration and collects messages matching a glob pattern. Use `/composition/layers/*/clips/*/transport/position` for real-time clip-playhead tracking (~325 msg/s). When `RESOLUME_CACHE` is enabled, transparently multiplexes through the store (no `EADDRINUSE`). ⚠️ `*` is segment-bound (OSC 1.0): `/a/*/b` works, `/a/*` won't match `/a/b/c`. Playhead values are normalized 0..1. **Pass `dedupe: true`** *(v0.5.4+)* to collapse Resolume's wire-level double-broadcast on UI-bound parameters (notably `/composition/layers/*/position`). |
| `resolume_osc_status` | Probes whether Resolume is broadcasting on the configured OSC OUT port. |

### Cache *(v0.5.1+; gated on `RESOLUME_CACHE`)*

The `CompositionStore` is an in-memory snapshot fed by Resolume's OSC OUT broadcast (~325 msg/s). When enabled, `*Fast` read methods on `ResolumeClient` (and the `resolume_get_clip_position` tool above) consult it instead of paying a REST round-trip. With the cache off (default), every read goes to REST exactly as in v0.4.

| Tool | What it does |
|------|--------------|
| `resolume_cache_status` | Diagnostics: returns `{ enabled, mode, revision, hydrated, oscLive, msgsReceived, lastOscAt, lastSeedAt, ... }`. Read-only. Use to verify the cache is receiving OSC pushes after enabling `RESOLUME_CACHE`. |
| `resolume_cache_refresh` *(alpha — hidden by default)* | Operator escape hatch: forces a full REST re-seed. Rate-limited to one call per 500 ms. Set `RESOLUME_TOOLS_STABILITY=alpha` to expose; intended for recovery (after Resolume restart, or when `cache_status` shows `oscLive=false` despite Resolume running). |

## Example prompts

> "What's the current state of the composition?"

> "Trigger clip 3 on layer 2."

> "Fade layer 1 down to 0 over a few steps."

> "Show me the thumbnail for layer 1 clip 4 — is that the right one for the chorus?"

> "Clear layer 2." (Claude will ask for confirmation before sending `confirm: true`.)

## Bundled Skill

A Claude Code [skill](https://docs.claude.com/en/docs/claude-code/skills) ships in this repo at [`skills/resolume-mcp-tester/`](./skills/resolume-mcp-tester/SKILL.md). It encodes the operational knowledge accumulated across releases — smoke-test recipes, white-out prevention rules, state-restoration patterns, and agent invocation templates for verifying every tool against a live Resolume Arena.

Install once into your Claude Code skill directory:

```bash
# macOS / Linux
mkdir -p ~/.claude/skills
cp -r skills/resolume-mcp-tester ~/.claude/skills/
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force skills\resolume-mcp-tester "$HOME\.claude\skills\"
```

Restart Claude Code, then ask it to "run a comprehensive smoke test of resolume-mcp-server" — it'll load the skill automatically and follow the safety rules. See [`skills/README.md`](./skills/README.md) for details and the versioning policy.

## Roadmap

- ~~**v0.2** — Tempo, deck, blend mode, effects (set parameters)~~ ✅ shipped
- ~~**v0.3** — Add/remove effects~~ ✅ shipped
- ~~**v0.4** — OSC integration (send/query/subscribe/status)~~ ✅ shipped
- ~~**v0.5** — CompositionStore cache, effect-id cache, stability tiers, cache-fast read methods, `clearclips` sub-endpoint, OSC dedupe~~ ✅ shipped (v0.5.0 → v0.5.4)
- **v1.0** — npm publish, contract sealed, deprecation policy in effect. Possible additions: `resolume_rest` whitelisted escape hatch for power users, Advanced Output (screens, slices).

Live-discovered fixes since v0.5.0 are documented in `docs/v0.5/`:
- [`live-test-v0.5.1.md`](./docs/v0.5/live-test-v0.5.1.md) — comprehensive smoke test report against Arena 7.23.2
- [`osc-duplicate-investigation.md`](./docs/v0.5/osc-duplicate-investigation.md) — root cause analysis of Resolume's wire-level double-broadcast (HIGH confidence)
- [`review-v0.5.0.md`](./docs/v0.5/review-v0.5.0.md) / [`review-v0.5.1.md`](./docs/v0.5/review-v0.5.1.md) — multi-perspective pre-release reviews

See [issues](https://github.com/mackatwentytsuru/resolume-mcp-server/issues) to vote or contribute.

## Development

```bash
git clone https://github.com/mackatwentytsuru/resolume-mcp-server.git
cd resolume-mcp-server
npm install
npm run build
npm test
npm run test:coverage  # 80%+ thresholds enforced
```

`npm install` activates local git hooks (`pre-commit` runs typecheck +
skill-sync drift check in ~3-5s; `pre-push` adds the full vitest suite).
See [`CONTRIBUTING.md`](./CONTRIBUTING.md#local-git-hooks) for details and
bypass instructions.

Project layout:

```
src/
  resolume/         # REST client, Zod schemas, high-level facade
  tools/            # one tool per file, grouped by domain
  server/           # MCP server registration
  errors/           # tagged-union ResolumeError + HTTP/network mappers
  config.ts         # env-driven config
  index.ts          # stdio entry point
```

## Known Resolume API quirks

- **Non-ASCII clip names** can break some REST endpoints — keep names ASCII when possible.
- **Some WebSocket actions don't ack** — handled with optimistic timeouts in upcoming v0.2.
- **`/product` endpoint** is recent; older Resolume versions return 404 (handled gracefully).

## Comparison with other Resolume MCP servers

| Feature | This server | drohi-r | Ayesy | Tortillaguy |
|---------|-------------|---------|-------|-------------|
| Tool count | **39** (curated) | 206 | 44 | 2 (`search`/`execute`) |
| Language | TypeScript | Python | TypeScript | Python |
| Schema validation | Zod (strict) | Manual | Zod | None |
| Thumbnail as image | ✅ | ❌ | ❌ | ❌ |
| Destructive confirmation | ✅ | ✅ | ❌ | ❌ |
| Structured errors with hints | ✅ | Partial | Partial | ❌ |
| OSC + cache fan-in | ✅ (push-driven, `RESOLUME_CACHE=1`) | ❌ | ✅ (param cache) | ❌ |
| Stability tiers + filter | ✅ (`stable`/`beta`/`alpha`) | ❌ | ❌ | ❌ |
| Test coverage | **94%+** statements (483 tests) | — | — | — |
| Live-tested against Arena 7.23 | ✅ every release | — | — | — |

Other implementations:
- [drohi-r/resolume-mcp](https://github.com/drohi-r/resolume-mcp) — broadest API surface
- [Ayesy/resolume-mcp](https://github.com/Ayesy/resolume-mcp) — animation simulation, parameter caching
- [Tortillaguy/resolume-mcp](https://github.com/Tortillaguy/resolume-mcp) — code-execution agent style

## License

[MIT](LICENSE)
