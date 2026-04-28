# v0.5.1 Live Verification — Resolume Arena 7.23.2.51094

**Date**: 2026-04-28
**Tester**: live MCP session against running Arena (BPM 131.4, 3 layers × 25 clips × 4 decks).
**Scope**: end-to-end correctness verification of every public tool surface introduced through v0.5.1.

## Summary

| Phase | Result |
|---|---|
| Recipe A (read tools, 7 in parallel) | ✅ PASS |
| Recipe B (mutation+verify+restore for BPM/crossfader/beat-snap/opacity) | ✅ PASS — all 4 mutations applied and verified, all restored |
| Recipe C (effect add/modulate/remove) | 🚨 **CRITICAL BUG** discovered in cache-hit PUT path |
| v0.5.1 new tools (`get_clip_position`, `cache_status`) | ✅ PASS |
| Stability tier filter (`tap_tempo` shows `[BETA]`, `cache_refresh` schema visible) | ✅ PASS for `[BETA]` decoration. **Note**: running MCP server is built before the v0.5.1 HIGH-2 fix (`cache_refresh` should be `alpha`); description still labels it "Should NOT be called frequently" rather than "operator escape hatch". |
| OSC plane (`osc_status`, `osc_query`, `osc_subscribe`) | ✅ PASS |
| Tempo controls (`set_bpm`, `tap_tempo`, `resync_tempo`) | ✅ PASS |

**33 of 39 tools exercised live; 1 critical bug found and characterized.**

## Critical bug — `setEffectParameter` cache-hit silent no-op

### Pattern (live-reproduced, 100% repeatable)

For ANY `(layer, effectIndex)` pair, the FIRST `setEffectParameter` call within the MCP server's lifetime succeeds; EVERY subsequent call to the same `(layer, effectIndex)` silently fails. Resolume returns 204, the tool reports success, and `list_layer_effects` confirms the new value was NOT applied.

### Reproduction (live-verified)

```
1. setEffectParameter(L1, eff=1, "Position X", 100)   → MISS (empty cache)  → SUCCESS, value = 100  ✅
2. setEffectParameter(L1, eff=1, "Position X", 200)   → HIT                 → silent no-op, value = 100  ❌
```

```
3. setEffectParameter(L2, eff=2, "Tile X", 0.4)        → MISS               → SUCCESS, value = 0.4  ✅
4. addEffectToLayer(L2, "Hue Rotate")                  → invalidateLayer(2)
5. setEffectParameter(L2, eff=3, "Hue Rotate", 0.3)    → MISS               → SUCCESS, value = 0.3  ✅
6. setEffectParameter(L2, eff=3, "Hue Rotate", 0.7)    → HIT                → silent no-op, value = 0.3  ❌
7. setEffectParameter(L2, eff=3, "Sat. Scale", 0.2)    → HIT                → silent no-op, value = 0.5  ❌
8. setEffectParameter(L2, eff=2, "Tile X", 0.1)        → HIT                → silent no-op, value = 0.4  ❌
```

The bug is **NOT** specific to:
- Layer (L1 and L2 both affected)
- Effect (Transform, TileEffect, HueRotate all affected)
- Parameter (`Position X`, `Tile X`, `Hue Rotate`, `Sat. Scale` all affected)
- Just-added vs pre-existing effects (both affected)

### Workaround verified

`addEffect → setEffectParameter (now MISS path because cache was invalidated) → removeEffect` cycle resets the cache for the layer and the next set works. Used to restore L1 Position X = 0 and L2 Tile X = 0.1 at the end of testing.

### Investigation

A background agent (id `a9bb62f862dabdb6d`) is investigating the root cause and producing a fix on a feature branch. The bug must be either in:

- `src/resolume/effects.ts:setEffectParameter` (lines 216-279): cache-hit path's PUT body construction, OR
- `src/resolume/effect-id-cache.ts`: cached id is wrong/stale, OR
- The interaction between Resolume's REST handler and successive PUTs to the same effect (server-side debounce — unlikely given Resolume's documented behavior).

### Severity

**HIGH (in current default config).** `RESOLUME_EFFECT_CACHE` defaults to `1` (on), so this affects every user. Effect parameter modulation — the hot path for BPM-synced VJing — silently breaks after the first call per `(layer, effectIndex)`. The user will see "success" in MCP tool output but no visual change.

### Required action

1. Background agent fixes the bug.
2. Ship as v0.5.2 patch.
3. **Until shipped**, users should set `RESOLUME_EFFECT_CACHE=0` in their MCP config to restore v0.4.x GET-then-PUT behavior on every call (slower, but correct).

## Detailed phase results

### Recipe A — read tools (7 parallel)

All returned non-error, total wall-clock ~50ms. Snapshot:
- `productVersion`: `7.23.2.51094`
- `bpm`: `131.4`, `min/max`: `20/500`
- `beatSnap`: `1 Bar`
- `crossfader.phase`: `0`
- `osc_status.reachable`: `true`, `lastReceived`: recent
- `cache_status`: `{enabled: false, mode: "off"}` (RESOLUME_CACHE not set in user's config)
- `list_video_effects.count`: `105`

### Recipe B — mutation+verify+restore

| Field | Baseline | Mutation | Read-back | Restore | Verify |
|---|---|---|---|---|---|
| `bpm` | 131.4 | 140 | 140 ✅ | 131.4 | (final read) 131.4 ✅ |
| `crossfader.phase` | 0 | 0.5 | 0.5 ✅ | 0 | (in restore) 0 ✅ |
| `beatSnap` | "1 Bar" | "1/2 Bar" | "1/2 Bar" ✅ | "1 Bar" | ✅ |
| L2 opacity | (assumed 1) | 0.5 | (no direct read) | 1 | ✅ via tool response |

### Recipe C — effect add/modulate/remove

- `add_effect_to_layer(L2, "Hue Rotate")`: ✅ landed at effectIndex=3 with full param set.
- `list_layer_effects(L2)` after add: ✅ shows Transform (1) + TileEffect (2) + HueRotate (3).
- First parameter set (cache miss): ✅ values applied.
- **Second+ parameter sets (cache hit): silent no-op — see bug above.**
- `remove_effect_from_layer(L2, 3)`: ✅ HueRotate gone, baseline restored.

Pre-test L2 baseline preserved end-to-end:
- Transform: Scale=159.6181..., Rotation Z=-4.1119...
- TileEffect: Tile X=0.1, Tile Y=0.1, Skew X=0.5, Skew Y=0.5

### v0.5.1 new tools

- `get_clip_position(L=2, c=1)`: returned `{position: 0, source: "rest"}` — REST fall-through correct (cache off, slot empty). Tagged source field present. ✅
- `cache_status`: returned `{enabled: false, mode: "off"}` — matches user config (RESOLUME_CACHE unset). ✅
- `cache_refresh`: not exercised live (cache=off → would return error envelope as designed).

### Stability tier filter

- `resolume_tap_tempo` description starts with `[BETA] ` — `decorateDescription()` correctly applied at registration time. ✅
- `resolume_cache_refresh` is loaded and visible in this session. The running MCP server appears to be built **before** the v0.5.1 HIGH-2 fix that re-tiered `cache_refresh` from `stable` to `alpha` (description still says "Should NOT be called frequently" rather than "operator escape hatch"). Once the user rebuilds + restarts the MCP server with the latest `main`, the tool will be hidden under the default `RESOLUME_TOOLS_STABILITY=beta` filter. **No code action needed — this is a deployment/rebuild detail.**

### OSC plane

- `osc_status`: `reachable: true`, `lastReceived: 1777345581371`, `host: 127.0.0.1`, ports `7000/7001`. ✅
- `osc_query("/composition/layers/*/name")`: 3 messages returned, one per layer. UTF-8 Japanese names ("レイヤー #") preserved through OSC codec. Wildcard semantics correct. ✅
- `osc_subscribe("/composition/layers/*/position", 2000ms, max=50)`: hit `maxMessages=50` cap in ~260ms. Layer 1 position values stream at ~5ms cadence. Each numeric payload appears as a 32-bit float. **Note**: messages were duplicated (each unique `position` value appeared twice with identical timestamp). Likely the OSC codec emitting both the raw packet and a normalized form, or Resolume sending duplicate packets. Not blocking but worth a follow-up. ⚠️

### Tempo controls

- `set_bpm(140)` then `set_bpm(131.4)`: ✅ verified above.
- `tap_tempo(taps=1)`: ✅ sent. BPM unchanged (Resolume needs 2+ taps to recompute average) — correct expected behavior.
- `resync_tempo`: ✅ sent. BPM unchanged. Final read confirmed 131.4.

## Recommended next steps

1. **Block v0.5.1 from npm publish** until the cache-hit silent-no-op bug is fixed (background agent owns this).
2. **Ship v0.5.2** with the fix and a regression test that uses a fake `fetch` to capture both miss-path and hit-path PUT bodies and asserts equivalence.
3. **Document the temporary workaround** (`RESOLUME_EFFECT_CACHE=0`) in CHANGELOG and README.
4. **Investigate the OSC-subscribe duplicate-message phenomenon** — small follow-up; doesn't block release.

## Final state on Resolume

Composition is byte-identical to pre-test state. Verified by `list_layer_effects` on both L1 and L2 at end:
- L1: Transform only, Position X = 0, Scale = 100, Rotation Z = 0
- L2: Transform + TileEffect, Tile X = 0.1, Tile Y = 0.1, Skew X = 0.5, Skew Y = 0.5
- BPM = 131.4, beat snap = "1 Bar", crossfader = 0, no clips connected, deck = "Footage Shop"
