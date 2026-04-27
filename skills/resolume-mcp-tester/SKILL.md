---
name: resolume-mcp-tester
description: Test and operate the Resolume MCP server (resolume-mcp-server) end-to-end against a live Resolume Arena. Use when verifying tool behavior, running smoke tests, doing safe live VJ demos, or validating new tools added to the project. Includes white-out prevention rules, state restoration patterns, and agent invocation templates.
version: 1.0.0
source: extracted from resolume-mcp-server git history (12 commits, v0.1.0 → v0.4.0)
---

# Resolume MCP Tester

This skill is for testing and operating `resolume-mcp-server` (the project at `~/Projects/resolume-mcp-server/`). It encodes everything learned across 12 releases of live testing against Resolume Arena 7.23.

## When to use

- Smoke-testing the MCP server after a change (build → live verify)
- Running comprehensive tool-by-tool live demos for the user
- Adding new tools — use the test recipes here to verify each one
- Investigating "tool returned 204 but nothing changed" issues (Resolume's silent-rejection trap)
- Recovering from white-out incidents during VJ sessions

## How it works

The MCP server has 3 communication channels with Resolume:

| Channel | Purpose | Default | Tools that use it |
|---|---|---|---|
| **REST** `http://127.0.0.1:8080/api/v1` | All read + most write ops | port 8080 | clip/layer/effect/composition tools |
| **OSC IN** `udp://127.0.0.1:7000` | Trigger/parameter writes | 7000 | `resolume_osc_send` |
| **OSC OUT** `udp://127.0.0.1:7001` | Real-time push from Resolume | 7001 | `resolume_osc_query`, `resolume_osc_subscribe` |

**Tool catalog (v0.4.0 — 36 tools)** — see project `README.md` for the canonical list. Categories:

- **Composition**: `get_composition`, `get_beat_snap`, `set_beat_snap`, `get_crossfader`, `set_crossfader`
- **Clips**: `trigger_clip`, `select_clip`, `get_clip_thumbnail`, `set_clip_play_direction`, `set_clip_play_mode`, `set_clip_position`, `clear_clip`, `wipe_composition`
- **Layers**: `set_layer_opacity|bypass|blend_mode`, `list_layer_blend_modes`, `set_layer_transition_duration|blend_mode`, `list_layer_transition_blend_modes`, `clear_layer`
- **Columns/Decks**: `trigger_column`, `select_deck`
- **Tempo**: `get_tempo`, `set_bpm`, `tap_tempo`, `resync_tempo`
- **Effects**: `list_video_effects`, `list_layer_effects`, `set_effect_parameter`, `add_effect_to_layer`, `remove_effect_from_layer`
- **OSC** (v0.4): `osc_send`, `osc_query`, `osc_subscribe`, `osc_status`

## CRITICAL safety rules (lessons from live use)

### Rule 1: Resolume silently no-ops invalid operations

This is the #1 reason "the tool said success but nothing changed". Whenever a write happens, **verify with a follow-up read** before declaring success in tests.

Common silent-rejection cases discovered in production:
- **Wrong type for parameter value** — passing string `"175"` to a `ParamRange` returns 204 but doesn't apply (fixed in v0.2.2 with `coerceParamValue`)
- **Missing effect ID in nested PUT** — passing only `{params: {Scale: {value: 50}}}` without the effect's `id` returns 204 but no change (fixed in v0.2.1)
- **Unknown blend mode name** — Resolume accepts the PUT and ignores it (fixed in v0.2.1 with pre-validation)
- **Cache-buster as path segment instead of query** — `.../thumbnail/12345` returns 404 (fixed in v0.2.1; correct: `.../thumbnail?t=12345`)
- **Effect-add via JSON instead of `text/plain`** — same body silently ignored unless content-type is `text/plain` and body is `effect:///video/{Name}` (fixed in v0.3.0)

### Rule 2: White-out prevention

These combinations on a single layer cause runaway brightness (positive feedback loop):

| Effect 1 | Effect 2 | Layer Blend | Result |
|---|---|---|---|
| Trails (Feedback ≥ 0.9) | any bright | any | 数フレームで白飛び |
| Bloom (Threshold ≤ 0.5) | any | Add or Screen | 累積発光で白飛び |
| Bloom (Size ≥ 0.6) | Trails | any additive | 確実に死ぬ |

**Safe defaults** when stacking effects:
- Trails Feedback ≤ 0.7
- Bloom Threshold ≥ 0.7
- If using Add/Screen blend, avoid Trails + Bloom together
- Add ONE effect at a time during demos and verify before adding the next

### Rule 3: Always restore state after tests

Track everything you change and restore at the end. Pattern:

```javascript
// 1. Snapshot
const before = await fetch(`${REST}/composition`).then(r => r.json());

// 2. Run mutations...

// 3. Restore (same setBpm/setLayerOpacity calls but with snapshotted values)
await fetch(`${REST}/composition`, { method: "PUT", body: JSON.stringify({ tempocontroller: { tempo: { value: before.tempocontroller.tempo.value }}})});
```

For effect chains: track each effect added and DELETE it before exiting (effects are 0-indexed for DELETE, 1-indexed for everything else).

## Test recipes

### Recipe A: Quick smoke test (all read tools)

```javascript
// Run via Bash with curl, or via MCP tools (faster). Should complete in <2s.
const checks = [
  ["resolume_get_composition", {}],
  ["resolume_get_tempo", {}],
  ["resolume_get_beat_snap", {}],
  ["resolume_get_crossfader", {}],
  ["resolume_list_video_effects", {}],
  ["resolume_list_layer_effects", { layer: 1 }],
  ["resolume_list_layer_blend_modes", { layer: 1 }],
];
// Expected: all return non-error JSON, total time < 2s
```

### Recipe B: Mutation + verify pattern

```javascript
// 1. Read original
const t0 = (await client.getTempo()).bpm;

// 2. Mutate
await client.setBpm(140);

// 3. Verify with a fresh read (Resolume's silent-no-op trap)
const t1 = (await client.getTempo()).bpm;
assert(t1 === 140, "set_bpm silent-no-op'd!");

// 4. Restore
await client.setBpm(t0);
```

### Recipe C: Effect add + parameter modulate + remove

```javascript
// 1. Add effect (REST: POST /composition/layers/N/effects/video/add with text/plain body "effect:///video/Bloom")
await client.addEffectToLayer(2, "Bloom");

// 2. Find the new effect's index (always last, so layer.video.effects.length)
const effects = await client.listLayerEffects(2);
const bloomIdx = effects.length; // 1-based

// 3. Modulate (with safe Bloom defaults to avoid white-out)
await client.setEffectParameter(2, bloomIdx, "Threshold", 0.85); // not too low!
await client.setEffectParameter(2, bloomIdx, "Size", 0.3);
await client.setEffectParameter(2, bloomIdx, "Amount", 0.6);

// 4. Verify the values stuck (NEVER trust just the 204)
const after = await client.listLayerEffects(2);
assert(after[bloomIdx - 1].params.find(p => p.name === "Threshold").value === 0.85);

// 5. Remove (DELETE uses 0-based index!)
await client.removeEffectFromLayer(2, bloomIdx);  // Tool converts internally to 0-based
```

### Recipe D: BPM-synced parameter pulse

For "audio reactive" demos (since true FFT is not available — see Known Limits below):

```javascript
const bpm = (await client.getTempo()).bpm;       // e.g. 131.4
const beatMs = 60000 / bpm;                       // 456ms
const halfBeatMs = beatMs / 2;                    // 228ms

// Pulse Bloom Amount on each beat for 8 beats
for (let i = 0; i < 8; i++) {
  await client.setEffectParameter(2, 1, "Amount", 1.0);  // peak
  await sleep(halfBeatMs);
  await client.setEffectParameter(2, 1, "Amount", 0.5);  // valley
  await sleep(halfBeatMs);
}
```

### Recipe E: OSC subscribe to playhead

For real-time time-based VJ effects:

```javascript
// Subscribe to all clip transport positions for 5s
const messages = await client.oscSubscribe(
  "/composition/layers/*/clips/*/transport/position",
  5000
);
// messages: [{address, args, timestamp}, ...] — ~30+ updates/sec
// Use to detect: clip end approaching, audio playhead position, etc.
```

## Known limitations (don't try these — they don't work)

These have been definitively verified across REST/WS/OSC by 3 separate investigation rounds:

| Want to do | Reality | Workaround |
|---|---|---|
| Set per-parameter "BPM Sync" via API | NOT exposed in any API. UI right-click only. | Have user configure in Resolume UI; your API writes become the animation amplitude |
| Read live FFT bands / audio level | NOT exposed. Resolume only sends UI-change events over OSC. | Run external WASAPI loopback FFT and stream as OSC into Resolume |
| Set parameter `in`/`out` to define animation range | Field exists but PUT is silently ignored | Use the parent path's nested PUT idiom (works) |

## Agent invocation templates

### Template 1: Comprehensive tool verification

```
"Run a comprehensive smoke test of every tool in resolume-mcp-server against the live Resolume at 100.74.26.128:8080.

Use the resolume-mcp-tester skill for safety rules and recipes. For each of the 36 tools:
1. Snapshot the parameter/state before mutation
2. Call the tool with safe values (Recipe B pattern)
3. Verify with a fresh REST read (NEVER trust just 204)
4. Restore the prior state

Stop and report immediately if you detect:
- White-out conditions forming (multiple effects added with aggressive params)
- Silent-no-op (response says success, follow-up read shows no change)
- Composition state diverged from snapshot at end

Report under 400 words: which tools verified, which failed, any silent-no-op issues."
```

### Template 2: New tool live verification

```
"Verify [TOOL_NAME] against the live Resolume.
1. Read the tool's source at src/tools/{domain}/{tool}.ts
2. Identify the underlying client method
3. Run a 3-call test: snapshot → mutate → verify (per Recipe B)
4. Restore prior state
5. Report whether the tool actually mutates Resolume state"
```

### Template 3: Effect chain VJ demo

```
"Run a 2-minute safe VJ demo on Layer 2 using diverse effects. Constraints from resolume-mcp-tester skill:
- Max 1 new effect at a time, then verify visually before next
- Trails Feedback ≤ 0.7 if used
- Bloom Threshold ≥ 0.7 if used
- Avoid (Trails + Bloom + Add/Screen blend) combination
- Restore Layer 2 to single Transform effect at end

Cycle through 8-10 effects: HueRotate, Posterize, PixelBlur, Mirror, Kaleidoscope, EdgeDetection, LoRez, Tile, Distortion, Tunnel. For each: 2-3 parameter values demoed, then remove."
```

## Verification commands

```bash
# Build + tests
cd ~/Projects/resolume-mcp-server && npm run build && npm test

# Live REST probe (Resolume must be running)
curl -s http://100.74.26.128:8080/api/v1/composition | jq '.tempocontroller.tempo.value'

# Live OSC probe (port 7000 should be bound by Arena.exe)
netstat -ano | findstr ":7000 :7001"
```

## Project conventions

Extracted from git history:
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:` prefixes
- **Tool file naming**: `src/tools/{domain}/{verb-noun}.ts`
- **Tests colocated**: `client.test.ts` next to `client.ts`; incremental files (`client.v2.test.ts`, `v3`, etc.) added per release
- **Coverage threshold**: 80%+ enforced via vitest config
- **Live smoke tests**: `scripts/smoke-*.mjs` pattern for end-to-end against running Resolume
