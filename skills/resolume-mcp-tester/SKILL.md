---
name: resolume-mcp-tester
description: Test and operate the Resolume MCP server (resolume-mcp-server) end-to-end against a live Resolume Arena. Use when verifying tool behavior, running smoke tests, doing safe live VJ demos, or validating new tools added to the project. Includes white-out prevention rules, state restoration patterns, and agent invocation templates.
version: 0.5.4
source: extracted from resolume-mcp-server git history (mirrors package.json version per skills/README.md policy)
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

**Tool catalog (v0.5.1 — 39 tools)** — see project `README.md` for the canonical list. Categories:

- **Composition**: `get_composition`, `get_beat_snap`, `set_beat_snap`, `get_crossfader`, `set_crossfader`
- **Clips**: `trigger_clip`, `select_clip`, `get_clip_thumbnail`, `get_clip_position`, `set_clip_play_direction`, `set_clip_play_mode`, `set_clip_position`, `clear_clip`, `wipe_composition`
- **Layers**: `set_layer_opacity|bypass|blend_mode`, `list_layer_blend_modes`, `set_layer_transition_duration|blend_mode`, `list_layer_transition_blend_modes`, `clear_layer`
- **Columns/Decks**: `trigger_column`, `select_deck`
- **Tempo**: `get_tempo`, `set_bpm`, `tap_tempo` *(marked `[BETA]` in v0.5.0 — see "Stability tiers" below)*, `resync_tempo`
- **Effects**: `list_video_effects`, `list_layer_effects`, `set_effect_parameter`, `add_effect_to_layer`, `remove_effect_from_layer`
- **OSC** (v0.4): `osc_send`, `osc_query`, `osc_subscribe`, `osc_status`
- **Cache** (v0.5.1, gated on `RESOLUME_CACHE`): `cache_status`, `cache_refresh` *(marked `[ALPHA]` in v0.5.1 — operator escape hatch, hidden by default; set `RESOLUME_TOOLS_STABILITY=alpha` to expose)*

## v0.5.0 environment flags (NEW)

Three opt-in env vars introduced in v0.5.0. **Defaults reproduce v0.4.x behavior bit-for-bit.**

| Variable | Default | What it enables |
|---|---|---|
| `RESOLUME_CACHE` | empty (off) | CompositionStore — push-driven OSC cache. `1`/`owner` binds OSC OUT exclusively. `passive`/`shared` lets other tools feed the cache. Keep **off** during normal testing unless you're explicitly verifying cache behavior. |
| `RESOLUME_EFFECT_CACHE` | `1` (on) | Effect-id cache. Halves request rate for `setEffectParameter` calls. **Default-on**. Set to `0` to bisect drift bugs. |
| `RESOLUME_TOOLS_STABILITY` | `beta` | Visibility filter. `stable` hides beta+alpha tools. `alpha` shows everything. The skill's tool catalog assumes default (`beta`). |

### Stability tiers (NEW)

Each tool now carries a `stability` marker. `tools/list` decorates descriptions:
- `stable` — no prefix (the default)
- `beta` — `[BETA] {description}`
- `alpha` — `[ALPHA] {description}`

Currently only `tap_tempo` is `beta`. Field validation may move it back to `stable` in a future release. If a test op requires `tap_tempo` and it's missing, check `RESOLUME_TOOLS_STABILITY` isn't set to `stable`.

### Cache + osc_subscribe coexistence (v0.5.1)

When the CompositionStore is in OWNER mode it exclusively binds the OSC OUT port. As of v0.5.1, `resolume_osc_subscribe` automatically detects this and **multiplexes through the store via `store.collect()`** — no `EADDRINUSE`, no port contention, and the cache and the subscribe tool can be used concurrently. When `RESOLUME_CACHE` is unset (default) the tool falls back to its legacy bind-the-port behavior, identical to v0.4.x.

For Recipe E (OSC subscribe to playhead): works the same regardless of whether `RESOLUME_CACHE` is enabled. If `cache_status` reports `mode: "owner"` you're getting the multiplexed read; if it reports `mode: "off"` or the tool fails because the store is absent, you're on the legacy bind path.

## CRITICAL safety rules (lessons from live use)

### Rule 1: Resolume silently no-ops invalid operations

This is the #1 reason "the tool said success but nothing changed". Whenever a write happens, **verify with a follow-up read** before declaring success in tests.

Common silent-rejection cases discovered in production:
- **Wrong type for parameter value** — passing string `"175"` to a `ParamRange` returns 204 but doesn't apply (fixed in v0.2.2 with `coerceParamValue`)
- **Missing effect ID in nested PUT** — passing only `{params: {Scale: {value: 50}}}` without the effect's `id` returns 204 but no change (fixed in v0.2.1)
- **Unknown blend mode name** — Resolume accepts the PUT and ignores it (fixed in v0.2.1 with pre-validation)
- **Cache-buster as path segment instead of query** — `.../thumbnail/12345` returns 404 (fixed in v0.2.1; correct: `.../thumbnail?t=12345`)
- **Effect-add via JSON instead of `text/plain`** — same body silently ignored unless content-type is `text/plain` and body is `effect:///video/{Name}` (fixed in v0.3.0)
- **Cached effect id from the GET *immediately* after `addEffectToLayer` is transient** — the first PUT against it lands; subsequent PUTs against the same id silently no-op because Resolume re-keys the new effect to its persistent id within milliseconds (fixed in v0.5.2 — `EffectIdCache.invalidateLayer` now flags the layer for one round of "verify before cache" so the post-add cache hit is forced through a fresh GET against the now-stable id; pre-existing effects unaffected).

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

### Rule 2.5: Effect add/remove churn → Resolume crash (real incident)

**Discovered the hard way during a continuous VJ loop session**: rapid add/remove of effects (every 8 beats = ~3.6s at 131.4 BPM) crashed Resolume Arena 7.23.2 after ~24 seconds (6 swaps). Crash dialog appeared, REST returned 404 for the layer path, OSC connection died. Likely cause: GPU resource churn or internal effect-chain state corruption.

**Rules**:
- **MAX 1 effect swap per 32 beats** (~1 bar at common BPMs is fine; sub-bar swap rates are dangerous)
- **Prefer parameter modulation** over effect swap for fast changes — params can update every beat safely (no GPU resource churn)
- **For long sessions**: pick 1-3 effects, add them once, modulate parameters only. Swap effects rarely (every 16-32 bars)
- **Watch for crash signals**: 404 on layer path = Resolume died. Stop the loop immediately; don't try to "recover" with more API calls.

**Validated empirically (2026-04-27)**:
- v1 loop: 8-beat (~3.6s) effect swap rate → Resolume crashed in **24 seconds / 6 swaps**.
- v2 loop: 5-second tick + 20-second swap cooldown + max 3-effect stack → **64 minutes / 763 ticks, no crash**. Stopped only because user manually closed Resolume.
- Conclusion: a swap interval of **at least ~20 seconds** with stack capped at 3 effects is safe for hour-scale continuous operation. See `examples/vj-loop-v2.mjs` for the reference implementation.

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
// messages: [{address, args, timestamp}, ...] — ~325 msg/sec verified live
// Use to detect: clip end approaching, audio playhead position, etc.
//
// Note: '*' is segment-bound (OSC 1.0). Each wildcard matches one path
// segment, NOT '/'. The '/clips/*' between is required —
// '/composition/layers/*/transport/position' silently matches nothing.
```

**⚠️ OSC quirks (verified live in v0.4.1)**:
- `*` is **segment-bound**: `/composition/layers/*/transport/position` matches NOTHING because Resolume's actual broadcast is `/composition/layers/{N}/clips/{M}/transport/position`. `/a/*` won't match `/a/b/c`.
- **Playhead value is normalized 0..1**, not milliseconds. Multiply by clip duration (from REST `transport.position.max`) to get ms.
- Resolume's full set of broadcast addresses (4-second live capture, 2911 messages):
  - `/composition/layers/{N}/position` (layer position)
  - `/composition/layers/{N}/clips/{M}/transport/position` (clip playhead — primary)
  - `/composition/selectedclip/transport/position` (bonus — currently selected clip)

### Rule 4: Long-session (hour-scale) operation

Validated reference: `examples/vj-loop-v2.mjs` ran 64 minutes / 763 ticks against Arena 7.23.2 with zero crashes. The earlier `vj-loop.mjs` (8-beat swap rate) crashed Resolume in 24 seconds.

**Rules for sustained loops**:
- **Tick rate**: ≥ 5s (never beat-rate for add/remove operations)
- **Effect stack**: cap at MAX_STACK = 3 (Transform + 2 added)
- **Swap cooldown**: ≥ 20s between any add or remove
- **Crash signal**: `getLayer()` throws or returns 404 → stop the loop immediately, do NOT retry. Run cleanup if possible, then exit.
- **Prefer parameter modulation** over add/remove — params can update every tick safely; reserve add/remove for infrequent creative transitions
- **Track every mutation** (effects added, blend mode, opacity, transforms) for cleanup on SIGINT/SIGTERM

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
"Run a comprehensive smoke test of every tool in resolume-mcp-server against the live Resolume at 127.0.0.1:8080.

Use the resolume-mcp-tester skill for safety rules and recipes. For each of the 39 tools:
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
curl -s http://127.0.0.1:8080/api/v1/composition | jq '.tempocontroller.tempo.value'

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
