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

| Variable | Default | Description |
|----------|---------|-------------|
| `RESOLUME_HOST` | `127.0.0.1` | Host running Resolume's Web Server |
| `RESOLUME_PORT` | `8080` | Web Server port (8080 Arena/Avenue, 8081 Wire) |
| `RESOLUME_TIMEOUT_MS` | `10000` | Per-request timeout in milliseconds |

## Tools (v0.2.2)

All tools are prefixed with `resolume_` to avoid collision with other MCP servers. Indices are **1-based** to match Resolume's UI.

### Composition
| Tool | What it does |
|------|--------------|
| `resolume_get_composition` | Returns version, BPM, layers (with connected clip + bypass state), columns, decks. **Call first.** |

### Clips
| Tool | What it does |
|------|--------------|
| `resolume_trigger_clip` | Plays the clip at `{layer, clip}` — the most common VJ action. |
| `resolume_select_clip` | Selects without playing. Useful before adjusting parameters. |
| `resolume_get_clip_thumbnail` | Returns the clip's preview image inline so the LLM can see it. |

### Layers
| Tool | What it does |
|------|--------------|
| `resolume_set_layer_opacity` | Fades a layer (`opacity` in 0..1). Smooth fades = multiple small steps. |
| `resolume_set_layer_bypass` | Mutes/unmutes a layer without losing the connected clip. |
| `resolume_set_layer_blend_mode` | Changes layer blend mode (Add, Multiply, Screen, etc.). |
| `resolume_list_layer_blend_modes` | Lists the 60+ blend modes available. |
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
| `resolume_tap_tempo` | Sends taps to the tap-tempo controller (single tap or multi-tap with interval). |
| `resolume_resync_tempo` | Sends a resync trigger to align Resolume's beat clock to the next downbeat. |

### Effects
| Tool | What it does |
|------|--------------|
| `resolume_list_video_effects` | ~105 video effects available globally, with `idstring` + `name`. |
| `resolume_list_layer_effects` | Effects on a layer with full parameter metadata: type, current value, min/max, and choice options. |
| `resolume_set_effect_parameter` | Mutates any parameter on an attached effect. Auto-coerces string-encoded numbers/booleans to match the parameter's declared type. |

## Example prompts

> "What's the current state of the composition?"

> "Trigger clip 3 on layer 2."

> "Fade layer 1 down to 0 over a few steps."

> "Show me the thumbnail for layer 1 clip 4 — is that the right one for the chorus?"

> "Clear layer 2." (Claude will ask for confirmation before sending `confirm: true`.)

## Roadmap

- ~~**v0.2** — Tempo, deck, blend mode, effects (set parameters)~~ ✅ shipped
- **v0.3** — WebSocket subscriptions + state cache, add/remove effects (POST `/effects`)
- **v0.4** — `resolume_rest` whitelisted escape hatch for power users
- **v0.5** — Advanced Output (screens, slices)

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
| Tool count | 18 (curated) → 30-40 planned | 206 | 44 | 2 (`search`/`execute`) |
| Language | TypeScript | Python | TypeScript | Python |
| Schema validation | Zod (strict) | Manual | Zod | None |
| Thumbnail as image | ✅ | ❌ | ❌ | ❌ |
| Destructive confirmation | ✅ | ✅ | ❌ | ❌ |
| Structured errors with hints | ✅ | Partial | Partial | ❌ |
| Test coverage | 92%+ | — | — | — |

Other implementations:
- [drohi-r/resolume-mcp](https://github.com/drohi-r/resolume-mcp) — broadest API surface
- [Ayesy/resolume-mcp](https://github.com/Ayesy/resolume-mcp) — animation simulation, parameter caching
- [Tortillaguy/resolume-mcp](https://github.com/Tortillaguy/resolume-mcp) — code-execution agent style

## License

[MIT](LICENSE)
