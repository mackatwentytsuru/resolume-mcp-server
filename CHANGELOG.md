# Changelog

All notable changes to this project will be documented in this file.

## [0.5.2] - 2026-04-28

### Fixed — silent no-op on `setEffectParameter` cache-hit writes (broader than the original v0.5.2 hypothesis)

- **The bug**: the FIRST `setEffectParameter` call against any `(layer, effectIndex)` succeeded; every subsequent cache-hit call silently no-op'd. The MCP tool reported success, REST returned 204, but Resolume's stored value never changed past the first write. Reproduced consistently against Resolume Arena 7.23.2 with v0.5.1 + `RESOLUME_EFFECT_CACHE` default-on, including on layers that were **never** mutated by `addEffectToLayer` in the session:
  ```
  list_layer_effects(L=3)                                  → only Transform at idx 1
  setEffectParameter(L=3, eff=1, "Scale", 150)             → MISS → SUCCESS, value=150
  setEffectParameter(L=3, eff=1, "Scale", 250)             → HIT  → SILENT NO-OP (value stays 150)
  ```
  And cross-effect on the same layer:
  ```
  setEffectParameter(L=2, eff=3, "Hue Rotate", 0.3)        → MISS → SUCCESS, value=0.3
  setEffectParameter(L=2, eff=2, "Tile X", 0.1)            → HIT  → SILENT NO-OP (value stays 0.4)
  ```

- **Root cause** (revised — supersedes the original "post-add transient id" hypothesis): a nested-PUT to `/composition/layers/{n}` with a `video.effects[]` body causes Resolume Arena 7.23.2 to **re-key effect ids on that layer**. The first PUT lands because we used a fresh id (from a MISS-fetch); subsequent cache-hit PUTs use the *pre-write* id, which Resolume no longer recognises after the re-key, so they silently no-op. The original v0.5.2 hypothesis ("Resolume returns a transient id after `effects/video/add`, stabilising within ms") only described the post-add subset of this behaviour. Live evidence on pre-existing Transform effects with no add involved (the L=3 repro above) refuted the post-add framing — the re-key happens on **any** effects-array nested PUT, not just after add. WebSocket-based clients (Bitfocus Companion) sidestep this because Resolume pushes an `effects_update` message after each PUT carrying the new ids; REST-only clients have to re-fetch.

- **The fix**: `setEffectParameter` now invalidates the layer's effect-id cache after every successful PUT (`cache?.invalidateLayer(layer)` post-PUT). The next call therefore does GET-then-PUT against the post-write id. This trades the cache's GET-skip benefit for sequential calls in exchange for correctness; the cache structure is retained for **single-flight concurrent coalescing** (multiple parallel callers for the same key still share one in-flight GET) and for bulk invalidation by `wipeComposition` / `selectDeck`. The previous `requireRevalidation` flag on `EffectIdCache.invalidateLayer` is removed as the broader fix subsumes it (`addEffectToLayer` now passes plain `invalidateLayer(layer)`).

- **Files touched**: `src/resolume/effects.ts` (`setEffectParameter` invalidates the layer post-PUT; `addEffectToLayer` no longer needs the special flag), `src/resolume/effect-id-cache.ts` (removed the `stabilizing: Set<number>` field, the `requireRevalidation` option, and the stabilization-skip branch in `lookup` — all redundant under the broader fix).

- **Regression tests added/updated**: total 450 (was 450 pre-fix). `effects.test.ts` adds three explicit live-repro tests: the L=3 Transform.Scale silent-no-op case (no add involved), the L=1 Position X 100→200 case (the v0.5.1 first-known incidence), and a three-sequential-write Transform.Scale cycle. A PUT-body shape-equality test also captures both PUT bodies and asserts byte-equality on shape, ruling out body-shape mismatches as the silent-no-op cause. The single-flight concurrent-coalescing benefit is now explicitly tested. Pre-existing post-add stabilization tests were updated to the post-PUT-invalidation model. The 5 `EffectIdCache requireRevalidation flag` unit tests in `effect-id-cache.test.ts` were removed (the flag they exercised is gone).

- **Behavioural impact**: every sequential call in a tight `setEffectParameter` loop now does one GET + one PUT (was: 1 GET + N PUTs in v0.5.0/v0.5.1, of which only the first PUT actually applied). For a 4-param BPM-synced sweep at 130 BPM this raises the request rate from ~8.7 req/s back to ~17.3 req/s — but the v0.5.1 "fast" rate was illusory because all writes after the first were silently dropped. Concurrent callers for the same key still share one GET via single-flight. Operators who need the original speed at the cost of re-introducing the silent-no-op can opt out via `RESOLUME_EFFECT_CACHE=0` (this disables the cache entirely; behaviour reverts to v0.4.x — every call does GET-then-PUT, which is what we converge on anyway).

- **No breaking API change** — the public method signature of `ResolumeClient.setEffectParameter` is unchanged; only the internal request pacing changed.

## [0.5.1] - 2026-04-28

Sprint C of the v0.5 roadmap — completes the CompositionStore tool surface, multiplexes legacy OSC tooling through the cache, replaces the slow `wipeComposition` with the official `clearclips` sub-endpoint, and clears the v0.5.0 review's MEDIUM/LOW backlog. **Tool count 36 → 39. No breaking changes.** Four orthogonal worktree-isolated implementer agents ran in parallel, each focused on one component.

### Added — CompositionStore cache-fast read methods

- **`ResolumeClient` accepts an optional `CompositionStore` dependency.** Constructor signature is fully additive (`new ResolumeClient(rest, store?)`); `fromConfig(config, store?)` similarly. When the store is `null` (default — and the only state under v0.4 behavior), every cache-fast method delegates straight to its REST counterpart.
- **`getTempoFast()`** — cache hit when `store.isFresh("bpm")`; else `getTempo()` REST fallback.
- **`getClipPositionFast(layer, clip)`** — cache hit when `readClipPosition` ageMs < 500 ms; else REST.
- **`getClipPositionFastTagged(layer, clip)`** — companion variant returning `{ value, source: "cache" | "rest" }` so tools can surface where the value came from.
- **`getCrossfaderFast()`** — cache hit when fresh; else REST.
- **`getLayerOpacityFast(layer)`** — cache hit when fresh AND the source is non-`"unknown"` (a freshly-constructed unhydrated snapshot's default `opacity=1` would otherwise falsely report a cache hit).

### Added — three new MCP tools

- **`resolume_get_clip_position`** — high-frequency-friendly read of a clip's normalized 0..1 transport position. Returns `{ layer, clip, position, source: "cache" | "rest" }`. With `RESOLUME_CACHE=1` and OSC pushing at ~325 msg/s, the LLM can poll this without paying a REST round-trip.
- **`resolume_cache_status`** — diagnostic. Returns `enabled: boolean` plus the full `store.stats()` payload (revision, hydrated, oscLive, lastOscAt, lastSeedAt, msgsReceived, rehydrationsTriggered, mode). When the store is absent, `{ enabled: false, mode: "off" }`.
- **`resolume_cache_refresh`** — recovery hatch. Calls `store.refresh()` and returns `{ durationMs, revision }`. When the store is absent, returns an `isError: true` envelope with a helpful hint pointing at `RESOLUME_CACHE`. Use after `cache_status` shows zero recent OSC packets, or after a Resolume restart.

### Changed — `osc_subscribe` multiplexes through CompositionStore

- When `ctx.store` is present, the tool now calls `store.collect(pattern, durationMs, maxMessages)` instead of binding its own UDP socket. **No more `EADDRINUSE` when both the cache and `osc_subscribe` are in use** — the v0.5.0 limitation called out in `SKILL.md` is gone.
- When `ctx.store` is null (default), the legacy bind-the-port path runs unchanged. v0.4-style consumers see no behavior change.
- Description updated so the LLM understands the cooperative behavior.

### Changed — `wipeComposition` uses the official `clearclips` sub-endpoint

- The previous implementation issued one `POST /composition/layers/{n}/clips/{m}/clear` per slot — `O(layers × clips)` requests, sequential to avoid flooding Resolume. Static analysis of Resolume's official OpenAPI (vendored in `white-tie-live/resolume-js`) confirmed `POST /composition/layers/{layer-index}/clearclips` clears every clip on a layer in one shot. We now issue `O(layers)` requests with a 4-way concurrency cap (`Promise.all` + cursor-shared workers).
- `slotsCleared` accounting is preserved: computed from the composition snapshot before dispatch since `clearclips` returns 204 with no count. The effect-id cache is still cleared at the end.
- See `docs/v0.5/swagger-probe-results.md` for the static-probe findings.

### Sub-endpoint catalog (Component 4 Phase 2)

Probe results for the v0.5 design's speculative endpoint list:

- **CONFIRMED POSITIVE (1)**: `POST /composition/layers/{n}/clearclips` — used in `wipeComposition` rewrite.
- **CONFIRMED NEGATIVE (4)**: `POST /composition/clear`, `PUT /composition/tempocontroller/tempo` (deep), `POST /composition/tempocontroller/tempo_tap`, `POST /composition/tempocontroller/resync`, `PUT /composition/crossfader/phase`. The "OSC trigger paths usually map 1:1 to REST POST" assumption from the v0.5 design was wrong: Resolume's Swagger lists no deep tempo paths, and Bitfocus Companion's reference confirms tempo resync is WebSocket-or-OSC, never REST. Documented in `docs/v0.5/swagger-probe-results.md` so future probing efforts don't repeat the misread.

### Probe tooling

- **`scripts/probe-subendpoints.mjs`** — reusable probe script. Safety-gates destructive probes behind `--allow-wipe`. Future contributors with live Resolume access can run it to re-validate when Resolume ships an updated REST surface.

### Cleared from v0.5.0 review backlog

Each item from `docs/v0.5/review-v0.5.0.md` MEDIUM/LOW landed as a focused commit:

- **M1**: tightened `__testInternals()` return type (no more `any` + eslint-disable).
- **M2**: annotated `Math.random()` jitter in `scheduleReconnect` as non-cryptographic.
- **M3**: debounced `lastOscAt` updates on unknown-address packets (50 ms window — reduces snapshot-replacement allocation pressure on the hot path).
- **M4**: documented why `Array.from(this.inflight.keys())` is needed in `EffectIdCache.invalidateLayer` (Map iteration + concurrent delete safety).
- **M6**: documented `wipeComposition` pacing rationale (since superseded by Component 4 Phase 2's parallel rewrite — comment updated to match).
- **M7 + L1**: narrowed `CompositionStore.invalidate()` from `invalidate(scope?)` to no-arg until scope-aware impl lands. Removed the unused `_scope` parameter.
- **L2**: `applyTempo` now structurally shares the snapshot when the incoming value is identical to `prev.tempo.bpmNormalized.value`. Eliminates ~325 redundant allocations/s on a tempo-flooded OSC stream.
- **L4**: documented `gen-tool-index.mjs` regex parser brittleness (nested object literals, template-literal names) and the `--check` CI gate as the safety net.
- **L5**: noted in the codegen banner that `tool-manifest.json`'s `count` field is for manual inspection (kept it; tests verify `count === tools.length`).
- **L3, L6, L7, L8, L9**: confirmed/no action needed per the review.

### Verified

441 tests pass (was 398 baseline at v0.5.0; +43 across all four streams). Coverage 94+ % statements / 87+ % branches / 92+ % functions / 96+ % lines.

### Tool count: 36 → 39

Three new tools added (`get_clip_position`, `cache_status`, `cache_refresh`). `SKILL.md` and `tool-manifest.json` updated and reconciled in the merge. `npm run check:skill-sync` green; manifest `count` matches `tools.length`.

## [0.5.0] - 2026-04-27

Sprint B of the v0.5 roadmap (`docs/v0.5/99-roadmap.md`). Three orthogonal feature components landed in parallel via worktree-isolated implementer agents:

- **CompositionStore** (Component 1 Phases 1-3) — push-driven state cache fed by Resolume's OSC OUT (~325 msg/s), with REST seed/reconcile fallback. Library-only in v0.5.0; tools land in v0.5.1.
- **Effect-id cache** (Component 4 Phase 1) — TTL'd cache that halves REST round-trips for `setEffectParameter` calls in BPM-synced parameter loops.
- **Tool registry stability tiers** (Component 3 Phases 1-2) — `stable`/`beta`/`alpha` markers on every `ToolDefinition`, env-var visibility filter, deprecation lifecycle, with `tap_tempo` marked beta as the first concrete tier user.

All three are **opt-in via env flags**; defaults reproduce v0.4.x behavior bit-for-bit. **No breaking API changes.**

### Added — CompositionStore (`src/resolume/composition-store/`)

- **`types.ts`** — typed snapshot shape (`CachedComposition`, `CachedLayer`, `CachedClip`, `CachedTempo`) with `Source` provenance tag on every field. Pure immutable records.
- **`ttl.ts`** — per-field TTL constants (`transportPosition: 250ms`, `opacity/bypassed/solo: 5000ms`, `bpm/crossfaderPhase: 2000ms`, structural: 30000ms) plus `isFresh()` helper.
- **`reducers.ts`** — pure functions for OSC → snapshot dispatch (`applyOpacity`, `applyTransportPosition`, `applyTempo`, `applyCrossfader`, `applyConnect`, `applySelect`, `applyBeatSnap`, `applySelectedDeck`) and full REST seed (`applyFullSeed`).
- **`mux.ts`** — `SubscriptionMux` for pattern-based fan-out, with `subscribe(pattern, handler)` and `collect(pattern, durationMs, maxMessages)`. Reuses `osc-codec.ts` segment-bound `*` semantics.
- **`store.ts`** — `CompositionStore` class with three operating modes negotiated at startup:
  - **OWNER** (`RESOLUME_CACHE=1` or `=owner`) — store owns a persistent UDP socket bound to OSC OUT.
  - **SHARED** (`RESOLUME_CACHE=passive` or `=shared`) — store does not bind; other tools feed it via `feed(msg)`.
  - **OFF** (default — empty/`0`) — store is not constructed; v0.4 behavior preserved.
  - On `EADDRINUSE` during OWNER bind, automatically degrades to SHARED with a stderr warning so the user's existing OSC tools keep working.
- **Lifecycle**: `start()` runs REST seed in parallel with first-OSC-packet wait, never throws on hydration failure (logs to stderr). Background reconnect loop (5s ±20% jitter) when Resolume isn't running. `stop()` is idempotent and called from `SIGINT`/`SIGTERM`.
- **Drift detection** — unknown layer/clip indices in OSC messages trigger a debounced (`rehydrateThrottleMs=500`) full re-seed.
- **Diagnostics** — `stats()` returns `{ revision, hydrated, oscLive, lastOscAt, lastSeedAt, msgsReceived, rehydrationsTriggered, mode }`.
- **Reactivity** — `onChange(listener)` fires only when `revision` actually advances (filters out no-op snapshot replacements at ~325 Hz).
- **Test coverage**: 95.23% statements / 86.15% branches / 96.87% functions / 98.73% lines on the `composition-store/` subdir; +101 new tests.

### Added — Effect-id cache (`src/resolume/effect-id-cache.ts`)

- **`EffectIdCache`** — 300s default TTL, 1000-entry LRU, single-flight via `Map<key, Promise<number>>`, per-layer secondary index for O(1) layer-wide invalidation.
- **Wiring**: `setEffectParameter` now consumes the cache (skips GET-then-PUT on hit). Invalidation hooks on `addEffectToLayer` / `removeEffectFromLayer` (per-layer flush), `wipeComposition` / `selectDeck` (clear all). `clearLayer` does NOT invalidate (clip-only operation; documented inline).
- **Opt-out**: `RESOLUME_EFFECT_CACHE=0` restores v0.4.x GET-then-PUT pattern.
- **Documented caveat**: cache stores id only, not param schema. Subsequent hits skip param-name validation. Drift bounded by 300s TTL.
- **Test coverage**: 96.96% statements / 87.17% branches / 100% functions / 98.38% lines on `effect-id-cache.ts`; +28 new tests.

### Added — Tool registry stability tiers + deprecation

- **`ToolDefinition`** gains optional `stability?: "stable" | "beta" | "alpha"` (default `"stable"`) and `deprecated?: { since, replaceWith?, removeIn?, reason? }` fields.
- **`registry.ts`** — `decorateDescription(tool)` adds `[BETA] `/`[ALPHA] ` prefixes and `(deprecated since X[, use Y][, removed in Z])` suffixes at registration time. Applied inside `eraseTool()`.
- **`RESOLUME_TOOLS_STABILITY` env var** filters which tiers `tools/list` exposes:
  - `stable` — only stable tools
  - `beta` (default) — stable + beta
  - `alpha` — all three
  - Stderr line at startup logs how many tools are hidden when applicable.
- **Deprecation runtime warning** — module-scoped set ensures once-per-process stderr warning when a deprecated tool is invoked.
- **`tap_tempo` marked beta** — first concrete user of the tier system.

### Refactor — flip tool-index import to generated file (Phase 1)

- **`src/server/registerTools.ts`** now imports `allTools` from `./tools/index.generated.js`. Manual `src/tools/index.ts` is a thin re-export.
- **`scripts/check-skill-sync.mjs`** drops its bespoke `index.ts` parser and reads `tool-manifest.json` directly.
- **`prepublishOnly` chain** verified: `check:tools` → `build` → `test` → `check:skill-sync`.

### Configuration — three new opt-in env vars

| Variable | Values | Default | Effect |
|---|---|---|---|
| `RESOLUME_CACHE` | empty / `0` / `1` / `owner` / `passive` / `shared` | empty (off) | Enables CompositionStore. |
| `RESOLUME_EFFECT_CACHE` | `0` / `1` / `true` / `false` | `1` | Toggles effect-id cache. Default-on. |
| `RESOLUME_TOOLS_STABILITY` | `stable` / `beta` / `alpha` | `beta` | Visibility filter for tool tiers. |

### Verified

396 tests pass (was 243 baseline at v0.4.2; +153 net across all three components). Coverage: 94.37% statements / 86.75% branches / 93.20% functions / 96.94% lines.

### Deferred to v0.5.1 (Sprint C)

- CompositionStore Phases 4-6: `*Fast` cache-first read methods on `ResolumeClient`, new tools `resolume_cache_refresh` / `resolume_cache_status` / `resolume_get_clip_position`, `osc_subscribe` multiplexed through the store, live verification.
- Component 4 Phase 2: sub-endpoint probe (requires live Resolume Swagger) and per-family conversion (e.g. `POST /composition/tempocontroller/resync`).

## [0.4.3] - 2026-04-27

Sprint A of the v0.5 roadmap (`docs/v0.5/99-roadmap.md`). **Pure refactor + dormant additions — zero behavior change for any consumer.** Ships as a patch so we have a clean checkpoint before the v0.5.0 feature work begins.

### Refactor — per-domain client split

- **`src/resolume/client.ts` 549 → 189 lines.** Effect-style module-level helpers extracted into per-domain files: `composition.ts`, `clip.ts`, `layer.ts`, `tempo.ts`. New `shared.ts` consolidates cross-domain helpers (`assertIndex`, `extractName`, `extractValue`, `filterStringOptions`) that were previously duplicated between `client.ts` and `effects.ts`.
- **Public `ResolumeClient` API is byte-identical.** Every existing tool keeps working without edits to `src/tools/**`. The class is now a thin facade composing module-level helpers via namespace imports (`import * as clip from "./clip.js"`), matching the v0.4.2 `effects.ts` precedent.
- **Tests reorganize by domain.** New per-domain test files (`tempo.test.ts`, `composition.test.ts`, `clip.test.ts`, `layer.test.ts`); `client.effects.test.ts` renamed to `effects.test.ts`. Version-bucket files `client.v2.test.ts` / `client.v3.test.ts` / `client.v4.test.ts` deleted; their `describe` blocks relocated to the appropriate domain test file.
- **`client.test.ts` slimmed** to `fromConfig`, `summarizeComposition`, and a public-API surface-presence assertion (catches accidentally-dropped methods).

### Added — tool-index codegen (Phase 0, dormant)

- **`scripts/gen-tool-index.mjs`** — globs `src/tools/**/*.ts`, validates the `resolume_<snake_case>` naming convention, and emits two deterministic artifacts: `src/tools/index.generated.ts` (parallel `allTools` array) and `src/tools/tool-manifest.json` (sorted-by-name catalog with `name`, `file`, `symbol`, `destructive`).
- **`src/tools/registry.ts`** — extracted `AnyTool` interface and `eraseTool()` helper from the manual `index.ts`. Future stability-tier helpers (Phase 2) will live here.
- **`src/tools/registry.test.ts`** — 7 parity tests proving the generated registry matches the manual one (length, names, uniqueness, name pattern). Catches drift before publish.
- **Manual `src/tools/index.ts` is still the authoritative registry** in v0.4.3. Phase 1 (a future patch) will flip `registerTools.ts` to import from the generated file. This dormant-codegen approach makes Phase 1 a one-line revertable change with zero risk.
- **`package.json` scripts**: `gen:tools` (regenerate), `check:tools` (regenerate to memory and diff against committed file — fails on drift). Both `build` and `dev` now run `gen:tools` first; `prepublishOnly` runs `check:tools` first as a publish-time drift gate.
- **`.githooks/pre-commit`** gains `check:tools` as the first step so stale generated files block commits with a precise error message.

### Documentation — v0.5 design

- **`docs/v0.5/`** — five design documents and one master roadmap totalling 1973 lines, produced by 5 parallel agents (1 prior-art survey + 4 architects):
  - `00-prior-art.md` — survey of `Tortillaguy/resolume-mcp`, `drohi-r/resolume-mcp`, and `bitfocus/companion-module-resolume-arena`. Companion's hybrid OSC+WS state model and cached effect-param lookups inform v0.5; drohi's 3,269-line single-file flat registry is the anti-pattern this release's per-domain split moves away from.
  - `01-composition-store.md` — push-driven state cache fed by Resolume's OSC OUT (~325 msg/s), REST seed/reconcile, three operating modes (OWNER/SHARED/OFF) for socket coexistence with `osc_subscribe`. Opt-in via `RESOLUME_CACHE`.
  - `02-domain-client-split.md` — the spec this release's refactor implemented.
  - `03-tool-registry.md` — phase 0 implemented in this release; phases 1-2 (stability tiers, env filter, deprecation lifecycle) ship in v0.5.0.
  - `04-effect-cache-and-sub-endpoints.md` — TTL'd effect-id cache with single-flight, sub-endpoint catalog (3 already optimal, 3 confirmed negative per CLAUDE.md, 5 speculative needing live probe).
  - `99-roadmap.md` — synthesis. Critical path is component 2 → (1, 3, 4 in parallel). Sprint A ships here; Sprint B as v0.5.0; Sprint C as v0.5.1; Sprint D as v1.0.0 (npm publish).

### Verified

243 tests pass (was 233 — net +10 from new domain tests, surface-presence assertion, and codegen parity tests). Coverage 93.95% statements / 87.01% branches / 91.62% functions / 96.09% lines — all above the 80% gate.

## [0.4.2] - 2026-04-27

Hardening release from a 5-perspective code review (typescript / security / general / architect / performance reviewers run in parallel against v0.4.1). All findings actioned. No new tools, no behavior changes for existing callers — internal robustness, refactoring, and stricter validation.

### Fixed (security)

- **Public IP leak removed** — examples/scripts contained a hardcoded Tailscale CGNAT IP (`100.74.26.128`) referencing the maintainer's tailnet. Replaced with `127.0.0.1` across examples (3 files), scripts (5 files), `SKILL.md`, and tests. Kept the CGNAT range example in `src/config.test.ts` using `100.64.0.1` (the reserved CGNAT base) to keep the SSRF-allowlist test meaningful.
- **Privileged-port rejection** — `RESOLUME_PORT`, `RESOLUME_OSC_IN_PORT`, and `RESOLUME_OSC_OUT_PORT` now reject values below 1024 at config load. Resolume's defaults are 8080/7000/7001 and there is no legitimate reason to bind a privileged port from a userland MCP process. Tests updated.

### Fixed (correctness)

- **OSC bundle decoder boundary** — `decodeBundle` now hard-fails on `sz === 0` and bounds-checks the size word against remaining buffer length. Prevents a tight loop when a malformed bundle declares a size past the buffer end.
- **OSC `queryOsc` filter timing** — moved the address-pattern match into the message handler so non-matching messages never fill the buffer. Previously the buffer accumulated every packet for the entire timeout window before filtering at the end.
- **OSC `probeOscStatus` decode validation** — `reachable=true` now requires that the received UDP datagram actually decodes as a valid OSC packet, not just that *some* UDP traffic arrived on the configured port.
- **`addEffectToLayer` URL-encoding** — effect names with special characters in `effect:///video/{Name}` are now percent-encoded via `encodeURI` consistently.
- **`setup-hooks.mjs` consumer guard** — when installed as a dependency in another repository, the postinstall hook installer now compares `gitRoot` to the `resolume-mcp-server` package root and skips if they differ. Prevents silently overwriting the consumer's `core.hooksPath`.

### Performance

- **Zod schema hoisted** — `registerTools` now compiles `z.object(tool.inputSchema).strict()` once per tool at registration instead of on every invocation. Removes allocation from the dispatch hot path.
- **OSC pattern cache** — compiled regex from each glob pattern is cached in a module-level `Map<string, RegExp>`. Subscription matching no longer recompiles per message at ~325 msg/s playhead rates.
- **Effect type-tag Sets module-scoped** — `NUMERIC_TYPES` / `BOOLEAN_TYPES` / `STRING_TYPES` are now module-level constants in `src/resolume/effects.ts`, not re-allocated per `coerceParamValue` call.

### Refactor

- **`client.ts` 806 → 549 lines** — Effect-related methods (`addEffectToLayer`, `removeEffectFromLayer`, `listLayerEffects`, `listVideoEffects`, `setEffectParameter`, `coerceParamValue`) extracted into `src/resolume/effects.ts` (307 lines). The public API of `ResolumeClient` is unchanged; this is purely a file split.
- **Shared test fixture** — `buildCtx` factory now lives in `src/tools/test-helpers.ts` and is shared between `tools.test.ts` and `tools.v2.test.ts`, eliminating duplicated mock setup.

### Documentation / skill

- **Skill version bumped to 0.4.2** in `skills/resolume-mcp-tester/SKILL.md` (mirrors `package.json` per `skills/README.md` policy).
- **Skill safety rules expanded** — Rule 2.5 (rapid effect-swap crash: 8-beat swap rate killed Arena 7.23.2 in 24s / 6 swaps) and Rule 4 (hour-scale operation: 5s tick + 20s swap cooldown + 3-effect cap validated 64 min / 763 ticks no crash) added from the empirical run of `examples/vj-loop-v2.mjs`.
- **Recipe E** now warns explicitly that OSC `*` is segment-bound (OSC 1.0) — `/composition/layers/*/transport/position` matches nothing because Resolume broadcasts at the deeper clip-level path.
- **`examples/vj-loop.mjs` deprecated** with prominent warning header — kept for before/after contrast only; `examples/vj-loop-v2.mjs` is the crash-validated reference implementation.
- **`README.md`** tool count corrected (28 → 36) and **`CONTRIBUTING.md`** gained a Windows Git Bash PATH note for the local hooks workflow.

### Verified

233 tests pass (up from 228). Coverage: 94.05% statements / 87.52% branches / 91.54% functions / 96.25% lines.

## [0.4.1] - 2026-04-27

Documentation and tool-description fixes from comprehensive live testing of v0.4.0 (3 parallel verification agents, 10+ minute live runs against Arena 7.23.2). No code-level bugs found in 36 tools — all silent-no-op-zero, broken-zero. Fixes are purely accuracy improvements.

### Fixed (documentation)

- **OSC playhead path**: `CLAUDE.md`, `README.md`, and the `resolume_osc_subscribe` tool description all advertised `/composition/layers/*/transport/position` which never matches because Resolume actually broadcasts at `/composition/layers/{N}/clips/{M}/transport/position` (transport position is at the **clip** level, not layer). Fixed in 4 places. Verified by 4-second live OSC capture confirming the 5 actual broadcast addresses.
- **OSC `*` semantics**: `osc_subscribe` description now warns that `*` is segment-bound (OSC 1.0) — `/a/*` will not match `/a/b/c`.
- **`trigger_clip` description**: now warns that rapid triggers under wider beat-snap windows get silently coalesced by Resolume (only the last trigger per snap window connects).

### Added

- **`examples/osc-realtime-vj.mjs`** — runnable end-to-end OSC reactive VJ demo: subscribes to L1 audio playhead, drives L2 effects through 4 phases of a song based on actual playhead position. Full state restore on exit. ~466 lines, no extra deps.
- **`examples/README.md`** — prerequisites, run instructions, customization guide.
- **Documented OSC quirks discovered during live testing**:
  - OSC playhead value is **normalized 0..1**, NOT milliseconds (REST is in ms — they differ!)
  - Effect names with spaces in `effect:///video/{Name}` URI must be **percent-encoded** (`Hue%20Rotate`, not `Hue Rotate`)
  - Effects expose two name fields: `name` (compact) and `display_name` (with spaces) — match against both for removal
  - `/composition/selectedclip/transport/position` is also broadcast — useful bonus address

### Verified

228 tests pass, 36/36 tools verified live (snapshot → mutate → verify → restore), 6 real-world VJ scenarios run end-to-end (3 PASS, 2 PASS-with-observed-quirks documented above, 1 PASS).

## [0.4.0] - 2026-04-27

OSC integration. REST/WS handles state and control surfaces, but Resolume's OSC plane has three things REST cannot do at all: wildcard reads (`/composition/layers/*/clips/1/name` returns every layer's first-clip name in one round-trip), real-time playhead push (REST gives a snapshot, OSC pushes every frame), and a small set of trigger paths like `/composition/tempocontroller/resync` that aren't surfaced in the swagger.

### Added (4 new tools, 36 total)

- **`resolume_osc_send`** — fire-and-forget OSC message. Address + positional args (numbers auto-typed to int32/float32, strings, booleans). For one-shot triggers and special commands not in the REST API.
- **`resolume_osc_query`** — sends an OSC `?` query and returns whatever Resolume echoes back within `timeoutMs` (default 1000ms). Supports wildcards. Fast bulk reads.
- **`resolume_osc_subscribe`** — listens on the OSC OUT port for `durationMs` (cap 30s) and collects messages whose address matches a glob pattern. Key use: `/composition/layers/*/clips/*/transport/position` for real-time playhead tracking (the path was originally documented incorrectly as `/composition/layers/*/transport/position` — see v0.4.1 fix). Stops early at `maxMessages`.
- **`resolume_osc_status`** — probes whether Resolume is sending on the configured OSC OUT port; returns reachable bool, last-received timestamp, and host/port config.

### New env vars

- `RESOLUME_OSC_HOST` (default `127.0.0.1`) — same SSRF allowlist as `RESOLUME_HOST`
- `RESOLUME_OSC_IN_PORT` (default `7000`) — Resolume's OSC IN
- `RESOLUME_OSC_OUT_PORT` (default `7001`) — Resolume's OSC OUT

### Implementation notes

- Hand-rolled OSC 1.0 codec in `src/resolume/osc-codec.ts` (no external deps; supports `i`/`f`/`s`/`T`/`F` plus bundle decoding).
- Stateless UDP client in `src/resolume/osc-client.ts` — each call creates and closes its own socket. No persistent listener so the MCP process never holds a port across tool calls.
- Socket factory is injectable; tests use a fake socket to verify send/listen/match flows without real UDP.

### Verified live

`scripts/smoke-osc.mjs` against the user's running Arena (BPM 131.4, music playing): subscribed for 2s and received 649 playhead frames (~325/s); read-only `?` query for tempo round-tripped without mutating state; final REST read confirmed BPM unchanged at 131.4. **No disturbance to the running session.** (Note: the wildcard pattern used during this test was later found to be incorrect — `/composition/layers/*/transport/position` matches nothing because Resolume broadcasts at the deeper clip-level path. v0.4.1 corrected this in docs and tool description. The 649 frames came through because the subscriber was matching the layer-level `/composition/layers/N/position` traffic that Resolume also broadcasts.)

### Known limitations (NOT in any API — confirmed)

- No FFT or audio-level data on the OSC OUT plane (Resolume's audio analysis is internal, not exposed).
- No per-parameter "sync to BPM" toggle — Resolume's clip beat-snap (`resolume_set_beat_snap`) and per-clip BPM sync (the `transport/controls/syncmode` clip path) are the only exposed BPM-sync mechanisms.
- `resolume_osc_subscribe` binds the OSC OUT port exclusively. If another process already holds it, the bind fails with `EADDRINUSE` — close the other listener first.

## [0.3.0] - 2026-04-27

Unblocks the v0.3 effect-management surface. Adding effects to a layer over Resolume's REST API was previously thought to require WebSocket plumbing because `POST /composition/layers/{n}/effects` returned 404. Turns out the missing piece was the `/add` suffix and a plain-text body containing the drag-drop URI (not JSON, not the `idstring`).

### Added (2 new tools, 32 total)

- **`resolume_add_effect_to_layer`** — adds a video effect by name (e.g. `"Blur"`, `"Hue Rotate"`) to the end of a layer's effect chain. Endpoint: `POST /composition/layers/{n}/effects/video/add` with `Content-Type: text/plain` and body `effect:///video/{EffectName}`. Verified against Resolume Arena 7.23.
- **`resolume_remove_effect_from_layer`** — removes the effect at a given 1-based position. Internally translates to 0-based for Resolume's `DELETE /composition/layers/{n}/effects/video/{index}`. Destructive — requires `confirm: true`.

Also adds `ResolumeClient.addEffectToLayer`, `ResolumeClient.removeEffectFromLayer`, and `ResolumeRestClient.postText` for direct programmatic use.

### Verified live

Smoke-tested against the user's running Arena 7.23.2: added Blur to layer 2, confirmed via `listLayerEffects`, removed it, confirmed cleanup. Layer state fully restored — no residual effects, no disturbance to the user's session.

### Reference implementations cross-checked

- `Tortillaguy/resolume-mcp` (Python, by-id path)
- `drohi-r/resolume-mcp` (Python, positional path)
- `Ayesy/resolume-mcp` (TypeScript, positional path)

All three use the same drag-drop URI shape (`effect:///video/{Name}`). The earlier WebSocket experiments (`{action:"add", path:..., value:{idstring}}`) are not the right protocol — `idstring` is for the catalog endpoint only.

## [0.2.7] - 2026-04-27

Discovered while a user wanted to wipe a deck — `clear_layer` only disconnects, it doesn't empty the clip slots themselves. Added the missing tools.

### Added (2 new tools, 30 total)

- **`resolume_clear_clip`** — empties a single clip slot (removes the loaded media; the slot becomes blank). Different from `clear_layer` (disconnect only). Endpoint discovered: `POST /composition/layers/{n}/clips/{n}/clear`. Destructive — requires `confirm: true`.
- **`resolume_wipe_composition`** — empties every clip slot on every layer in one call. Useful for starting from a fresh state. Returns `{ layers, slotsCleared }`. Destructive — requires `confirm: true`.

Also adds `ResolumeClient.clearClip` and `ResolumeClient.wipeComposition` for direct programmatic use.

### Verified live

Cleared all 27 cells of the user's Footage Shop deck (3 layers × 9 columns) — every clip name returned `<empty>` afterwards.

## [0.2.6] - 2026-04-27

Security-reviewer pass on the cumulative v0.2.x changes. CRITICAL/HIGH: none. LOW: 1 — fixed.

### Fixed

- **`set_effect_parameter` paramName guard** — used JS `in` operator which traverses the prototype chain. `__proto__` and `constructor` would falsely pass the existence check, then silently no-op against Resolume. Now uses `Object.prototype.hasOwnProperty.call` for an own-property check. No actual prototype pollution possible (computed property syntax is safe), but the silent no-op is removed.

### Security review summary

- Path injection: no attack surface (all paths use validated integer args; string args go only into JSON bodies)
- SSRF: `RESOLUME_HOST` validated against private-net allowlist + metadata-service blocklist (covered in v0.1.x)
- DoS via tap-tempo loop: capped at 12s, enforced pre-loop
- Published package: `files` array correctly excludes `src/` and tests
- npm audit: 0 vulnerabilities

148 tests, ~97% coverage. **Verdict from review: APPROVED for stable release.**

## [0.2.5] - 2026-04-27

A/B mixing + per-layer transitions. 5 new tools. 28 total.

### Added

- **`resolume_get_crossfader` / `resolume_set_crossfader`** — master A/B crossfader phase (-1 = full Side A, 0 = center, 1 = full Side B). The standard DJ-style mix between two channels.
- **`resolume_set_layer_transition_duration`** — per-layer fade duration (0..10s, 0 = instant cut).
- **`resolume_set_layer_transition_blend_mode`** / **`resolume_list_layer_transition_blend_modes`** — visual effect during clip transitions (Alpha = simple fade, Wipe Ellipse = circular wipe, Push Up = scroll, etc., 50 options). Pre-validates against the live list.

### Tests

- 147 tests, ~97% coverage

## [0.2.4] - 2026-04-27

Quality release driven by typescript-reviewer feedback. No new tools — existing ones get more correct, better-documented, and more defensively bounded.

### Fixed (HIGH severity from review)

- **`InvalidIndex.what` discriminant** — effect-index errors used to report `what: "clip"` because the union didn't include `"effect"`. Added `"effect"` to the union and updated `setEffectParameter`'s error throws. The LLM now sees an accurate kind on bad effect indices.
- **`coerceParamValue` boolean branch** — restructured the boolean-coercion control flow so the rejection path is unambiguous on a re-read. Added tests covering numeric (0/1) coercion and non-`true`/`false` string rejection (previously an uncovered branch).

### Changed / hardened

- **`tap_tempo` total-duration cap** — sequences whose projected wall time exceeds 12 seconds are now refused with a clear error (e.g. `taps=8, intervalMs=3000` would have blocked the MCP channel for ~21s).
- **`setClipPlayMode` allowlist** — pre-validates against the live options list so unknown modes get a structured error instead of Resolume's silent no-op (same pattern as `setLayerBlendMode` / `setBeatSnap`).
- **Version string sourced from package.json** — `src/version.ts` reads the manifest at startup so the MCP server identity stays in lock-step on every bump (no more two-place edits).
- **Public-method JSDoc** — every method on `ResolumeClient` now has at least a one-line summary, including a note that `getClipThumbnail`'s `cacheBuster` parameter is internal.

### Tests

- 136 tests, 97.02% statements / 86.25% branches / 98.05% functions / 98.14% lines

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
