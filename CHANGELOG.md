# Changelog

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-04-27

Beat-snap and clip transport — the missing pieces for BPM-synced VJing. 23 tools total.

### Added

- **`resolume_get_beat_snap`** / **`resolume_set_beat_snap`** — composition-level clip beat-snap (None / 8 Bars / 4 Bars / 2 Bars / 1 Bar / 1/2 Bar / 1/4 Bar). When set, triggered clips wait for the next beat boundary before connecting. This is *the* mechanism Resolume uses to keep clip changes locked to music — essential for BPM-synced AI VJing.
- **`resolume_set_clip_play_direction`** — `>` forward, `<` reverse, `||` pause. Closest equivalent to play/pause for a connected clip.
- **`resolume_set_clip_play_mode`** — Loop / Bounce / Random / Play Once & Clear / Play Once & Hold.
- **`resolume_set_clip_position`** — seek the connected clip to a specific position (re-trigger from the start, jump to cue points).

All 5 new tools verified end-to-end against Resolume Arena 7.23.2.

### Tests

- 122 tests, ~96% coverage

## [0.2.2] - 2026-04-27

Iterative bug-fix and quality release. Caught a hidden silent-rejection issue and substantially upgraded `list_layer_effects` for richer LLM context.

### Fixed

- **`resolume_set_effect_parameter` — type coercion** — Resolume silently drops parameter PUTs when the value type doesn't match the parameter's declared `valuetype` (e.g. `{"value": "175"}` for a `ParamRange` returns 204 but no change). The MCP wire protocol can encode numbers as strings for some clients. Added automatic coercion based on `valuetype`: ParamRange/Number → numbers, ParamBoolean → boolean (with `"true"`/`"false"` string handling), ParamChoice/String → strings. Unknown valuetypes pass through unchanged. Verified by passing string `"300"` and seeing Scale actually change.

### Added

- **`resolume_resync_tempo`** — was already implemented in `ResolumeClient` but not exposed as a tool. Now registered (18 tools total).
- **`resolume_list_layer_effects` — rich parameter metadata** — instead of just returning parameter *names*, each parameter now includes `valuetype`, current `value`, and `min`/`max`/`options` when applicable. Lets the LLM choose valid values without guessing or making extra read calls.

### Verified (live)

Full end-to-end testing of every tool against Resolume Arena 7.23.2 (Tailscale endpoint):
- Read tools (composition/tempo/effects/blend modes/thumbnail) all return correct shapes
- Mutation tools (clip trigger, column trigger, deck select, blend mode, opacity, bypass, effect param) all reflect in Resolume
- Destructive `clear_layer` correctly gated behind `confirm: true`
- Schema validation rejects out-of-range values at the Zod boundary
- Coercion verified: string `"300"` for Scale (ParamRange) → coerced to 300 → applied

### Known limitations

- `resolume_tap_tempo` — API call accepts the event but Resolume doesn't always recalculate BPM from REST taps. Use `resolume_set_bpm` for exact tempo.
- Effect **add/remove** is not exposed (v0.3 — appears to require WebSocket; REST PUT silently ignores new-effect entries on Resolume 7.23).

## [0.2.1] - 2026-04-27

Bug-fix release based on full live testing of all 17 tools against Resolume Arena 7.23.2. Three real-world bugs caught.

### Fixed

- **`resolume_get_clip_thumbnail`** — the cache-buster timestamp was appended as a path segment (`.../thumbnail/1234567`) which 404s. It must be a query string. Fixed to `.../thumbnail?t=1234567`. Verified end-to-end (returns 19KB PNG).

- **`resolume_set_effect_parameter`** — Resolume's nested-PUT silently no-ops when you send a positional padding `[{}, {params:...}]` without the target effect's `id`. The fix now fetches the layer first, locates the effect by 1-based index, validates the parameter name, and includes the effect's actual `id` in the PUT body. Now actually changes effect values (verified Scale, Rotation Z, Position X all live).

- **`resolume_set_layer_blend_mode`** — Resolume silently no-ops on unknown blend mode strings. The tool now fetches the layer's available `Blend Mode` options first and rejects unknown names with a helpful hint listing valid choices.

### Added

- More robust `set_effect_parameter` error reporting — distinguishes between out-of-range `effectIndex`, unknown `paramName` (lists available params), and missing-effect-id edge cases.
- Two extra tests bringing total to 108.

### Notes

- `resolume_tap_tempo` API call returns success but doesn't always trigger BPM recalculation in Resolume — known limitation of the `tempo_tap` event parameter via REST. Use `resolume_set_bpm` directly when possible.

## [0.2.0] - 2026-04-27

### Added

- **Tempo control (3 tools)** — `resolume_get_tempo`, `resolume_set_bpm`, `resolume_tap_tempo` (with multi-tap support via `taps` + `intervalMs`)
- **Column/deck (2 tools)** — `resolume_trigger_column` (fires entire scene), `resolume_select_deck` (switches scene bank)
- **Layer extras (3 tools)** — `resolume_set_layer_bypass`, `resolume_set_layer_blend_mode`, `resolume_list_layer_blend_modes`
- **Effects (3 tools)** — `resolume_list_video_effects` (catalog), `resolume_list_layer_effects` (effects on a layer with their parameter names), `resolume_set_effect_parameter` (mutate any param on an attached effect)
- `CompositionSummary` now exposes `bpm` and per-layer `bypassed` state
- `ResolumeClient` exposes typed methods for every new operation: `triggerColumn`, `selectDeck`, `setLayerBypass`, `setLayerBlendMode`, `getLayerBlendModes`, `getTempo`, `setTempo`, `tapTempo`, `resyncTempo`, `listVideoEffects`, `listLayerEffects`, `setEffectParameter`

### Fixed

- **`resolume_set_layer_opacity`** — the previous endpoint (`PUT /composition/layers/{n}/video/opacity`) returned 404 against live Resolume 7.23. Fixed to use the documented nested-PUT pattern: `PUT /composition/layers/{n}` with body `{"video":{"opacity":{"value":n}}}`. Verified end-to-end against Arena 7.23.2.

### Documentation

- `CLAUDE.md` updated with the nested-PUT convention so the pattern is explicit for contributors

## [0.1.0] - 2026-04-27

### Added
- Initial release with 6 MVP tools
- `resolume_get_composition` — composition state summary
- `resolume_trigger_clip` — connect/play a clip
- `resolume_select_clip` — select without playing
- `resolume_get_clip_thumbnail` — inline clip preview image
- `resolume_set_layer_opacity` — opacity 0..1
- `resolume_clear_layer` — destructive layer clear with `confirm` gate
- Typed REST client with abort-based timeout
- `ResolumeError` tagged-union with recovery hints for the LLM
- Zod-based input validation on every tool
- Test suite (51 tests, 92%+ coverage)
- Configuration via `RESOLUME_HOST`, `RESOLUME_PORT`, `RESOLUME_TIMEOUT_MS`
