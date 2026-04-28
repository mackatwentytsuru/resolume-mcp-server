# v0.5 Design: Effect-id Cache and Sub-endpoint Survey

## Effect-id Cache

### Overview

`setEffectParameter` currently does GET-then-PUT (2 roundtrips) on every call because Resolume's nested-PUT body needs the effect's numeric `id` to disambiguate which array entry to mutate. In a BPM-synced parameter loop pulsing 4 params at 130 BPM, that's 17.3 req/s instead of 8.7 req/s — an avoidable bottleneck on the loopback HTTP path (and the single-threaded Resolume web server).

The id of a given `(layer, effectIndex)` is **stable** as long as the effect array on that layer is not mutated (no add/remove/clear). That makes it a perfect candidate for a small TTL-bounded in-process cache with explicit invalidation hooks.

**Module location**: new file `src/resolume/effect-id-cache.ts` (180 LOC budget). Keep `effects.ts` focused on REST shape work; the cache is orthogonal infrastructure.

The cache is owned by `ResolumeClient` (one instance per client), not module-global. `ResolumeClient.fromConfig` constructs it.

### TTL Choice

**Chosen: 300 seconds (5 minutes), with a soft maximum of 1000 entries (LRU-evict oldest on overflow).**

Reasoning:
- Effect ids change only on add/remove/clear — all three pass through `ResolumeClient`, so we can invalidate **synchronously**. The TTL is only insurance against external mutation (Resolume UI, OSC, another REST client, deck switch).
- A live VJ session reuses the same effect chain for a whole song (~3-5 min) or longer. 60s TTL = unnecessary refreshes mid-song. 600s+ TTL = mask drift too long.
- 300s = roughly one re-fetch per song boundary. Doubles as a sanity check.
- Memory: ~80 bytes/entry × 1000 = ~80KB. Negligible.
- Hit cost when effect deleted externally: same as today (Resolume returns 204 silently).

TTL and max-size are constants, exported and overridable for tests.

### Invalidation

```text
type CacheKey = `${number}:${number}` // `${layer}:${effectIndex}`
interface CacheEntry { id: number; expiresAt: number }
```

Plus a per-layer index (`Map<number, Set<CacheKey>>`) for O(1) layer-wide invalidation lookup.

Precise invalidation rules:

| Trigger method | Action | Rationale |
|---|---|---|
| `addEffectToLayer(layer, name)` | `cache.invalidateLayer(layer)` | Effects can insert at non-end. All indices stale. |
| `removeEffectFromLayer(layer, idx)` | `cache.invalidateLayer(layer)` | Indices > idx shift down. |
| `clearLayer(layer)` | **No invalidation needed** | Disconnects clips; effects unaffected. (CLAUDE.md confirms `/clear` is clip-only.) Document explicitly. |
| `wipeComposition()` | `cache.clearAll()` | Conservative wipe. |
| `selectDeck(n)` | `cache.clearAll()` | Switching decks reloads layers. |
| TTL expiry | Lazy: checked on read | No background timer. |

### Concurrency / Single-flight

Two concurrent `setEffectParameter(2, 3, "Scale", x)` calls must NOT both issue the GET.

```text
class EffectIdCache {
  private inflight = new Map<CacheKey, Promise<number>>();
  private entries = new Map<CacheKey, CacheEntry>();

  async lookup(layer, effectIndex, fetcher: () => Promise<number>): Promise<number> {
    const key = `${layer}:${effectIndex}`;
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.id;

    const pending = this.inflight.get(key);
    if (pending) return pending;          // join the in-flight GET

    const promise = fetcher()
      .then((id) => { this.set(key, id); return id; })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
```

Properties:
- Hit + miss + concurrent-miss are the only states.
- Single-flight prevents N concurrent callers from N GETs.
- Fetcher rejection propagates to all joined callers; `inflight` cleared via `finally`.
- Invalidation during in-flight: `invalidateLayer` also clears `inflight` keys on that layer.

After single-flight resolves, `setEffectParameter` still needs to validate `paramName`. **Decision**: cache only the id (Option 1). Bigger cache (id + param schema) balloons memory and re-introduces TTL drift. First miss validates everything; subsequent hits assume param still exists. Documented caveat.

### Opt-out Flag

New env: `RESOLUME_EFFECT_CACHE` (default `"1"`).
- `"1"` / `"true"` / unset: enabled.
- `"0"` / `"false"`: bypassed, identical to v0.4.2.

```text
RESOLUME_EFFECT_CACHE: z
  .enum(["0", "1", "true", "false"])
  .default("1")
  .transform((v) => v === "1" || v === "true"),
```

Surfaced as `effectCacheEnabled: boolean`. When disabled, cache short-circuits `lookup` to always call `fetcher()`.

Rationale for opt-out (not opt-in): correctness-preserving by construction (sync invalidation), so default-on is safe.

### Test Plan

New file: `src/resolume/effect-id-cache.test.ts`. All tests use fake timers + `vi.fn()` fetcher.

| Test | Setup | Assertion |
|---|---|---|
| miss → fetch + cache | empty cache | fetcher called once; second `lookup` skips fetcher |
| TTL expiry | advance time past 300s | fetcher called again |
| `invalidateLayer(2)` clears entries on layer 2 | populate (2,1), (2,2), (3,1) | (2,1)/(2,2) refetch; (3,1) cached |
| `clearAll()` flushes everything | populate 5 entries | all 5 refetch |
| single-flight: concurrent misses | two `lookup` before fetcher resolves | fetcher called once; both resolve to same id |
| fetcher rejection clears inflight | fetcher throws once, then succeeds | both joined callers reject; next call retries |
| LRU overflow | populate 1001 entries | oldest evicted |
| disabled mode | `enabled=false` | every `lookup` calls fetcher |
| invalidation during in-flight | invalidate while pending | resolved value not written; next call refetches |

Plus integration tests in `client.effects.test.ts`:
| Test | Assertion |
|---|---|
| second `setEffectParameter` skips GET | `rest.get` called once, `rest.put` twice |
| `addEffectToLayer` invalidates cache | after add, `rest.get` called twice across two sets |
| different effectIndex on same layer cached independently | both miss first, both hit second |
| `RESOLUME_EFFECT_CACHE=0` disables | every set does GET-then-PUT |

Coverage target ≥ 80% on `effect-id-cache.ts`.

---

## Sub-endpoint Catalog

Confidence: **CONFIRMED** = proven by current code or CLAUDE.md; **SPECULATIVE** = plausible per Resolume conventions, requires live Swagger probe.

| # | Current operation | Current path + body | Candidate narrower path | Confidence | Notes |
|---|---|---|---|---|---|
| 1 | `clearLayer(n)` | `POST /composition/layers/{n}/clear` (no body) | **Already optimal** | CONFIRMED (code line 106) | No work. |
| 2 | `clearClip(n,m)` | `POST /composition/layers/{n}/clips/{m}/clear` (no body) | **Already optimal** | CONFIRMED (code line 117) | No work. |
| 3 | `wipeComposition()` | GET composition → loop POST `/clips/{m}/clear` for every slot | **`POST /composition/layers/{n}/clearclips` per layer + parallelize** | CONFIRMED POSITIVE (static, Sprint C / Component 4 Phase 2) | `POST /composition/clear` is NOT in the Swagger spec — drohi-r references it but Resolume's spec lists no such path; treat as confirmed-negative. The Swagger-confirmed alternative is per-layer `/clearclips` (line 562 of spec): cuts O(layers × clips) requests to O(layers) and the per-layer calls are parallelizable. **Conversion landed.** See `swagger-probe-results.md`. |
| 4 | `setLayerOpacity(n,v)` | PUT `/composition/layers/{n}` with `{video:{opacity:{value:v}}}` | Deep PUT: `/composition/layers/{n}/video/opacity` | **CONFIRMED NEGATIVE** | CLAUDE.md explicitly states deep parameter PUTs don't exist in Resolume's REST. Memorialize. |
| 5 | `setLayerBypass(n,b)` | PUT layer with `{bypassed:{value:b}}` | Deep PUT — same constraint | **CONFIRMED NEGATIVE** | Same architectural rule. |
| 6 | `setLayerBlendMode(n,m)` | GET layer → validate → PUT layer | Cache `options` array per layer | DERIVED | Not sub-endpoint, but parallel cache opportunity for v0.6. Static unless Resolume version changes. |
| 7 | `setLayerTransitionBlendMode(n,m)` | GET options → PUT layer | Same cacheable-options pattern | DERIVED | Same. |
| 8 | `setBpm(b)` | PUT `/composition` with `{tempocontroller:{tempo:{value:b}}}` | `PUT /composition/tempocontroller/tempo` with `{value:b}` | **CONFIRMED NEGATIVE (static)** | The Resolume Swagger spec exposes `tempocontroller` only as a *schema field* on the `Composition` envelope, not as a standalone path. All four reference repos (Companion, Tortillaguy, drohi-r, Ayesy) route BPM mutations via WebSocket `/parameter/by-id/{id}`. CLAUDE.md's "no deep parameter PUTs" rule extends here. Wide `PUT /composition` body remains correct. |
| 9 | `tapTempo()` | PUT with `{tempocontroller:{tempo_tap:{value:true}}}` | `POST /composition/tempocontroller/tempo_tap`? | **CONFIRMED NEGATIVE (static)** | Same reason as #8. Companion routes tap via WebSocket `triggerParam(id)` with OSC fallback at `/composition/tempocontroller/tempotap` (note alt spelling — still OSC, not REST). |
| 10 | `resyncTempo()` | PUT with `{tempocontroller:{resync:{value:true}}}` | `POST /composition/tempocontroller/resync` | **CONFIRMED NEGATIVE (static)** | Original confidence was misleading: the OSC trigger path being well-known does NOT imply a REST POST exists — REST and OSC are distinct surfaces with different vocabularies. Companion's `tempo-resync.ts` confirms it: WebSocket trigger first, then OSC fallback at `/composition/tempocontroller/resync`. Never REST. Wide `PUT /composition` body remains correct. |
| 11 | `triggerClip(n,m)` | `POST /composition/layers/{n}/clips/{m}/connect` | **Already optimal** | CONFIRMED | Same path Bitfocus Companion uses. |
| 12 | `setCrossfader(p)` | PUT `/composition` with `{crossfader:{phase:{value:p}}}` | `PUT /composition/crossfader/phase` with `{value:p}` | **CONFIRMED NEGATIVE (static)** | Same family as #8 — `crossfader` is a schema field, not a path root. Tortillaguy explicitly falls back to `/composition/crossfader/phase` only over WebSocket. Wide `PUT /composition` body remains correct. |
| 13 | `setBeatSnap(v)` | GET composition (validate) → PUT with `{clipbeatsnap:{value:v}}` | Cacheable options + smaller PUT | DERIVED | Validation GET wasteful. v0.6 options cache. |
| 14 | `setLayerTransitionDuration(n,d)` | PUT layer with `{transition:{duration:{value:d}}}` | Deep PUT — same constraint | **CONFIRMED NEGATIVE** | Same rule. |

**Summary by confidence** (post Sprint C / Component 4 Phase 2 probe):
- **Already optimal**: #1, #2, #11.
- **Confirmed negative — don't pursue**: #4, #5, #14, **and now #8, #9, #10, #12** (all per static Swagger probe; deep parameter PUTs and POSTs against `/composition/tempocontroller/...` and `/composition/crossfader/...` are not in Resolume's REST surface — those addresses live in WebSocket `/parameter/by-id/{id}` and OSC, not REST).
- **Confirmed positive — landed**: **#3** (`POST /composition/layers/{n}/clearclips` per layer with parallelization).
- **Derived options-caching opportunities** (v0.6): #6, #7, #13.

**Net v0.5 work delivered**: catalog updated with empirical/static evidence for #3/#8/#9/#10/#12; one conversion landed (#3 via per-layer `clearclips` + parallelism). See `swagger-probe-results.md` for the evidence trail.

---

## Implementation Order

### Phase 1 — Effect-id cache (no behavior change visible)
- 1a. Add `effect-id-cache.ts` + tests in isolation. Single PR.
- 1b. Wire `setEffectParameter` to use cache; add invalidation hooks. Single PR.
- 1c. Add `RESOLUME_EFFECT_CACHE` env to `config.ts`. Single PR.

### Phase 2 — Sub-endpoint probe (live Resolume required)
- 2a. Probe script GETs `/api/v1` Swagger; capture in `docs/v0.5/swagger-probe-results.md`.
- 2b. For each confirmed path, replace wide PUT. One PR per endpoint family for easy bisect.

### Phase 3 (deferred to v0.6) — Options cache
- Generic `OptionsCache` for blend modes, transition modes, beat-snap. 1-hour TTL. Same single-flight pattern.

Phase 1 ships value without live Resolume access. Phase 2 needs Resolume installed.

---

## Risks

1. **Cache drift via OSC/UI mutation** — TTL bounds drift; opt-out flag; documented. Same risk surface as today's `getCompositionSummary`.
2. **Single-flight error fan-out** — Explicit `.finally(() => inflight.delete(key))` ensures retry; tests cover.
3. **Param-schema staleness on cache hit** — Documented caveat; first miss validates; v0.6 strict mode.
4. **Deck-switch detection** — `selectDeck` triggers `clearAll()`. UI/OSC switch missed. **Worst case**: 5min of misdirected PUTs that Resolume silently rejects.
5. **Speculative endpoint regressions** — Each conversion gets own PR + test; keep wide PUT as documented fallback.
6. **Memory growth** — Hard LRU cap at 1000 entries.
7. **Test brittleness on fake timers** — Use `vi.useFakeTimers({ shouldAdvanceTime: true })`; follow `osc-client.test.ts` patterns.

---

## Executive Summary

- **Effect-id cache**: new `src/resolume/effect-id-cache.ts` with 300s TTL, 1000-entry LRU, single-flight via `Map<key, Promise>`, layer-scoped invalidation index, and synchronous flush on `addEffectToLayer` / `removeEffectFromLayer` / `selectDeck` / `wipeComposition`. Halves request count for BPM-synced parameter loops.
- **Opt-out**: `RESOLUME_EFFECT_CACHE=0` short-circuits to v0.4.2 behavior; default-on safe because invalidation is correctness-preserving by construction.
- **Sub-endpoint catalog (14 rows)**: 3 already optimal, 3 confirmed negative (CLAUDE.md rules out deep parameter PUTs), 5 speculative (probe Swagger first — `/composition/tempocontroller/resync` highest-confidence), 3 derived options-caching opportunities deferred to v0.6.
- **Ship order**: phase 1 (cache) fully testable without live Resolume — 3 PRs; phase 2 (sub-endpoints) gated on Swagger probe, split per endpoint family for easy bisect.
- **Top risks**: external cache drift (bounded by TTL + opt-out), single-flight error fan-out (covered by tests), silent param-name no-ops on cache hits (documented caveat — acceptable for tight-loop use).
