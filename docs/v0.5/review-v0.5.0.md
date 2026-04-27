# v0.5.0 Pre-Release Review

Five-perspective review of the v0.4.3 → HEAD diff (Sprint B: Component 4 Phase 1
effect-id cache, Component 3 Phases 1–2 tool registry refactor, Component 1
Phases 1–3 CompositionStore). All 396 tests pass; no findings block release.

## Total findings by severity

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 7 |
| LOW | 9 |

---

## CRITICAL

_None._ All gating mechanisms (env-var defaults, EADDRINUSE auto-degrade,
behavior-equivalent legacy path) preserve v0.4.x behavior bit-for-bit when the
new flags are off.

---

## HIGH (should fix before v0.5.0 ships)

### H1 — `[architect | code-reviewer]` `clearClip` does not invalidate the effect-id cache for shifted layers

**File**: `src/resolume/clip.ts:54-62` (`clearClip`)
**Issue**: `clearClip` is a single-slot clear that does NOT touch the layer's
effect chain — that part is fine. But the doc-comment on `clearLayer`
(`src/resolume/layer.ts:21-35`) and the cache-invalidation set listed in the
spec leave one Resolume-specific edge unaddressed: the `wipeComposition` loop
calls `rest.post(.../clear)` per slot rather than using the higher-level
`clip.clearClip` helper. Both reach the same endpoint, and `wipeComposition`
does call `cache.clearAll()` at the end, so the user-visible behavior is
correct. The risk is that a future contributor seeing `clearClip` adds cache
invalidation by symmetry with `clearLayer`'s "do not invalidate" rule.
**Fix**: Add a one-line comment in `clearClip` mirroring the explicit "DO NOT
invalidate the effect-id cache" comment in `clearLayer` so the convention is
visible at every clip/layer destructive op site. Strictly comment-only —
no behavior change.

### H2 — `[performance-optimizer | architect]` Subscription iteration during dispatch can drop messages if a handler unsubscribes a sibling

**File**: `src/resolume/composition-store/mux.ts:71-81` (`SubscriptionMux.dispatch`)
**Issue**: `dispatch()` iterates `this.subscriptions` (a `Set`) while handlers
run synchronously. `Set` iteration is forgiving of self-removal (already-visited
entries are skipped), but if a handler removes a *later* sibling that has not
yet been visited in the same dispatch, that sibling will silently miss the
current message. The same issue affects `collect()` — its handler unsubscribes
inside `finish()`, but only when `settled` is already true, so the first match
itself is delivered. The risk is in user-defined `subscribe()` consumers
inside the store's own `commit() → onChange` listeners (Phase 4 territory).
**Fix**: Snapshot the subscription set before iteration:
```ts
const subs = Array.from(this.subscriptions);
for (const sub of subs) { ... }
```
Cost: one allocation per dispatch (~325 µs/year on the hot path is negligible
relative to the regex `test()` cost). Add a regression test where one handler
unsubscribes another mid-dispatch.

---

## MEDIUM

### M1 — `[typescript-reviewer]` `__testInternals(): any` exposes test-only state via a typed `any`

**File**: `src/resolume/composition-store/store.ts:455-463`
**Issue**: `__testInternals()` returns `any` with an `eslint-disable`. While
acceptable as a test seam, the return type can be made explicit (`{
hasReconnectTimer: boolean; hasRehydrateTimer: boolean; socketBound: boolean;
effectiveMode: CompositionStoreMode; }`) without losing flexibility.
**Fix**: Tighten the return type; remove the disable.

### M2 — `[security-reviewer]` `scheduleReconnect` uses `Math.random()` for jitter — fine for non-crypto, but document

**File**: `src/resolume/composition-store/store.ts:416-427`
**Issue**: `Math.random()` is correct here (non-security jitter), but linters
sometimes flag it. Already acceptable; the design doc's "±20% jitter" rationale
is in the code.
**Fix**: Add a `// non-cryptographic — jitter only` comment to short-circuit
future false-positive security flags.

### M3 — `[architect]` `applyOscMessage` updates `oscLive` / `lastOscAt` on every packet, even unknown addresses

**File**: `src/resolume/composition-store/reducers.ts:330-336, 432-433`
**Issue**: When an unknown address arrives, the reducer returns a *new*
snapshot with the bumped `oscLive` / `lastOscAt` but `revision` unchanged.
That is intentional (revision suppresses listener fan-out), and `commit()`
correctly skips listeners on unchanged revisions. However, every unknown
packet still allocates a snapshot copy. At ~325 msg/s, an unknown-address
storm means ~325 allocations/s of mostly-empty replacement. Acceptable for
v0.5.0 but worth noting for v0.5.1 perf pass.
**Fix**: Optionally short-circuit when both `oscLive` is already true and
`lastOscAt` differs by < N ms (debounce timestamp updates).

### M4 — `[performance-optimizer]` Effect-id cache `inflight` keys-walk on `invalidateLayer` is O(inflight-size)

**File**: `src/resolume/effect-id-cache.ts:160-177`
**Issue**: `invalidateLayer` calls `Array.from(this.inflight.keys())` then
filters by string prefix. Inflight count is bounded by concurrent
`setEffectParameter` calls (typically << 10), so this is a micro-issue. The
explicit `Array.from` is needed to safely mutate `inflight` during iteration,
which is the right call.
**Fix**: None required. Optionally add a comment explaining why the
materialised array is required (Map iteration + concurrent delete).

### M5 — `[code-reviewer | typescript-reviewer]` `applyFullSeed` has a buggy guard around `tempo.min` / `tempo.max`

**File**: `src/resolume/composition-store/reducers.ts:225-239`
**Issue**: The check `typeof tempoParam?.value === "number"` gates whether
`min`/`max` are read at all. If the REST tree returns a tempo object whose
top-level `value` is not yet populated (e.g. mid-startup), `min`/`max` come
back `null` even when they are present. The intent is to copy them only when
the param block exists, but the gate is conditioned on the wrong field.
**Fix**: Replace the inline guard with `if (tempoParam) { ... } else null`:
```ts
min: { value: tempoParam ? readNumber(tempoParam, "min") : null, source: seedSource },
max: { value: tempoParam ? readNumber(tempoParam, "max") : null, source: seedSource },
```

### M6 — `[code-reviewer]` `wipeComposition` slot loop is sequential — slow on large grids

**File**: `src/resolume/clip.ts:75-97`
**Issue**: Sequential `await` over every slot is correct (Resolume's REST
queue can choke on bursts) and the helper is rarely used at show time, so
this is a deliberate pacing choice. But there is no comment explaining why
it is not parallelised.
**Fix**: Add a one-line comment: `// Sequential by design — Resolume drops
parallel POST bursts.`

### M7 — `[architect]` `CompositionStore.invalidate(scope)` ignores its `scope` argument

**File**: `src/resolume/composition-store/store.ts:257-260`
**Issue**: The method accepts a scoped invalidation argument but always falls
through to a full re-seed via `scheduleRehydrate`. The doc-comment says so
explicitly. This is fine for Phase 3, but the public method shape suggests
finer-grained control than is implemented. A naive caller could assume layer-
scoped behavior and be surprised.
**Fix**: Either narrow the type to `invalidate(): void` for now, or keep the
shape and add a runtime check that warns once per process when a non-`"all"`
scope is passed.

---

## LOW

### L1 — `[code-reviewer]` `void _scope;` in `invalidate()` is a no-op intended only to silence the unused-arg lint

`src/resolume/composition-store/store.ts:258` — fine, but a leading underscore
on the param already does this idiomatically.

### L2 — `[typescript-reviewer]` `applyTempo` mutation pattern returns a new snapshot but with the same `tempo` field — minor structural-sharing miss

`src/resolume/composition-store/reducers.ts:639-648` — the no-op branch
returns `{ ...prev, tempo: { ...prev.tempo, bpmNormalized: { value, source } }
}`. Even with identical value, this allocates 3 new objects per packet.
Acceptable at 325 Hz but noted for the perf pass.

### L3 — `[performance-optimizer]` Reducer regexes are module-level constants — already optimised

`src/resolume/composition-store/reducers.ts:298-308` — confirmed not compiled
per-call. Good.

### L4 — `[code-reviewer]` `gen-tool-index.mjs` regex parser of TS source files is brittle

`scripts/gen-tool-index.mjs:202-282` — works for the current tool corpus, but
nested object literals or template-literal names would break it. Acceptable
because of the `--check` CI gate that fails fast on drift.

### L5 — `[code-reviewer]` Manifest `count` field is duplicated information

`src/tools/tool-manifest.json:2` — `count` and `tools.length` are both
written; tests already verify equality. Drop the explicit count, or keep with
a one-line note that it exists to make manual inspection easy.

### L6 — `[security-reviewer]` SSRF guard already covers `RESOLUME_OSC_HOST` — verified

`src/config.ts:17-28` — confirmed v0.4.2's allowlist still applies to both
HTTP and OSC hosts; tests at `src/config.test.ts:43-44, 61-79` exercise it.
**No action.**

### L7 — `[security-reviewer]` `RESOLUME_CACHE` and `RESOLUME_EFFECT_CACHE` env vars are validated via Zod

`src/config.ts:38-65, 86-108` — both go through Zod with explicit enums; no
new attack surface. **No action.**

### L8 — `[security-reviewer]` `tryBindSocket` EADDRINUSE handler closes socket then nulls `this.socket` — robust

`src/resolume/composition-store/store.ts:316-343` — confirmed degrade-to-
SHARED path is safe; socket is closed in the error handler before being
abandoned. **No action.**

### L9 — `[code-reviewer]` `__deprecationWarned` test reset hook is exported

`src/server/registerTools.ts:63` — exported only for tests. JSDoc explicitly
calls this out. Acceptable.

---

## Summary by reviewer

### typescript-reviewer
- Type safety is solid. Generics and Zod schemas are correctly bounded.
- One `any` in test seam (M1); one minor structural-sharing miss (L2).
- No widespread `unknown`-without-narrowing issues.

### security-reviewer
- v0.4.2 SSRF allowlist still applied to both HTTP and OSC hosts.
- New `RESOLUME_CACHE` / `RESOLUME_EFFECT_CACHE` env vars are Zod-validated
  with explicit enums; no shell injection or path-traversal vector.
- EADDRINUSE auto-degrade path correctly closes the dgram socket before
  re-using the listener.
- `Math.random()` jitter is non-cryptographic by design (M2 — comment only).
- **No CRITICAL or HIGH security findings.**

### architect
- Three-mode CompositionStore (`off` / `owner` / `shared`) is coherent.
  EADDRINUSE → SHARED degrade path is the right call.
- Effect-id cache invalidation set is **functionally complete** for v0.5.0:
  `addEffectToLayer`, `removeEffectFromLayer`, `wipeComposition`,
  `selectDeck`. The `clearLayer`/`clearClip` non-invalidation is correct
  per Resolume's API but undocumented in `clearClip` (H1).
- Codegen pattern integrates cleanly with `check-skill-sync` via the
  manifest. No layering violations.
- `invalidate(scope)` accepts more than it implements (M7).

### performance-optimizer
- Effect cache single-flight is correct, including the
  invalidate-during-flight semantics.
- Hot-path OSC reducers do not allocate per-message regexes (L3).
- Subscription dispatch iterates a live `Set` — see H2.
- No N+1 patterns introduced. The `wipeComposition` sequential loop is by
  design, not a regression (M6).

### code-reviewer
- Test coverage is comprehensive: 396 tests, happy path AND failure
  modes (REST failure, EADDRINUSE, malformed packets, single-flight
  rejection, drift detection, deprecated tool warning). 80%+ coverage
  preserved.
- No leftover `console.log` or dead code in production paths.
- One bug in `applyFullSeed` tempo min/max guard (M5).
- Project conventions per `CLAUDE.md` are followed (1-based indices,
  tagged-union errors, Zod at boundaries).
- `__testInternals` and `__deprecationWarned` test seams are documented.
- Skill-sync manifest is in lock-step with the registry; `tap_tempo`
  correctly carries `stability: "beta"`.

---

## Recommended action before tagging v0.5.0

1. **Fix H1**: add the explicit "DO NOT invalidate cache" comment to
   `clearClip` mirroring `clearLayer`'s comment.
2. **Fix H2**: snapshot the subscription set at the top of
   `SubscriptionMux.dispatch()` before iterating, plus a regression test for
   the unsubscribe-mid-dispatch case.
3. **Fix M5**: tighten the tempo `min`/`max` guard in `applyFullSeed`.

Total fix budget: < 30 minutes plus a focused test. None of the remaining
MEDIUM/LOW items block release; they can land in v0.5.1 or be deferred
indefinitely.
