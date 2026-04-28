# v0.5.1 Pre-release Review

Scope: commits in `v0.5.0..HEAD` on `main` (21 commits across four merged
agent streams: A — `*Fast` methods + `get_clip_position`; B — cache_status,
cache_refresh, osc_subscribe mux; C — sub-endpoint static probe +
`wipeComposition` rewrite; D — backlog M1-M7 + L1-L5).

Reviewers: typescript-reviewer, security-reviewer, architect,
performance-optimizer, code-reviewer (5 perspectives, executed in parallel
by the orchestrating session against the same diff).

---

## Bottom-line call

**SHIP** — no CRITICAL findings. The four HIGH findings are all
documentation / wording / hardening items that do not change runtime
correctness, can be addressed in a 0.5.2 patch if not done before tag, and
would not gate a stable release in any of the reviewers' judgment.

The diff is well-structured, well-tested (407-line `client.fast.test.ts`
covers the new code path matrix exhaustively), keeps the v0.4 default
behavior bit-identical, and the most invasive change (`wipeComposition`
rewrite) lands behind tests that prove the slot-count contract and the
concurrency cap are both honored.

## Severity counts

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 4 |
| MEDIUM | 9 |
| LOW | 12 |

---

## CRITICAL + HIGH list (block / strongly fix before release)

### HIGH

1. **[security] `src/tools/store/cache-refresh.ts:18` — `resolume_cache_refresh` has no rate limit / cooldown → trivial DoS surface against Resolume's single-threaded HTTP server.**
   The handler unconditionally calls `ctx.store.refresh()`, which fires `GET /composition` against Resolume. A misbehaving LLM that calls this in a tight loop hammers REST at the speed the MCP transport can dispatch — Resolume serves HTTP single-threaded, so this also blocks every other tool's REST traffic for the duration. The store internally has a `rehydrateThrottleMs` debounce on the *passive* path (`scheduleRehydrate`), but the explicit `refresh()` API skips it.
   → Fix: gate `refresh()` with a minimum-interval guard inside `CompositionStore.refresh()` itself (e.g. reject if last `refresh()` call was within ~500 ms, returning `{ throttled: true, lastDurationMs }`). Mirror the same coalescing the rehydrate timer already does. The tool description already says "Should NOT be called frequently" — make the implementation enforce it instead of trusting the LLM to read.

2. **[architect] `src/tools/store/cache-refresh.ts` — `cache_refresh` shouldn't be LLM-callable. It's an operator escape hatch.**
   Belongs as a CLI flag (`node build/index.js --refresh-cache` or a stderr-driven SIGUSR1 hook), not a tool exposed to every LLM session. The tool description already discourages use ("Should NOT be called frequently"); shipping it as a tool invites exactly the foot-gun the docstring warns about. The diagnostic value (`cache_status`) is fine LLM-callable; the **action** of forcing a re-seed should require operator intent.
   → Fix (cheap): mark `stability: "alpha"` so default `RESOLUME_TOOLS_STABILITY=beta` hides it from the LLM. Operators who want it can opt in via `RESOLUME_TOOLS_STABILITY=alpha`. This both signals the intended audience and removes the DoS surface in the default config without removing capability. Pair with finding #1.

3. **[security/architect] `src/resolume/client.ts:62` — Optional store dependency is plumbed via constructor but the `*Fast` methods don't propagate the store's health (`isHydrated`, `isOscLive`) into their fall-through decisions.**
   `getTempoFast` / `getCrossfaderFast` / `getLayerOpacityFast` only consult `isFresh(field)`, which itself only checks `lastOscAt`. When the store is constructed but **never hydrated** (REST seed failed, OSC port idle), `lastOscAt` stays null → `isFresh()` returns false → REST fall-through, which is correct. **However**, in OWNER mode where OSC is live but `hydrated=false` (REST seed failed), `isFresh()` returns true and the `*Fast` reads will return whatever placeholder values the empty-snapshot reducers wrote — for `getLayerOpacityFast` this is the `unknownScalar` source-kind guard which IS checked, but `getCrossfaderFast` only checks `cf.value !== null` and `getTempoFast` only checks `t.bpm.value !== null`. Both can be `null` while OSC is live, so the actual code is safe — but the guard relies on coincidence rather than an explicit hydration check. A future change to seed default scalars to non-null (e.g. crossfader phase=0) silently breaks the contract.
   → Fix: gate every `*Fast` method on `this.store.isHydrated()` before consulting cached values. Adds one bool read per call; matches the design intent that the cache is "an opt-in optimization, never a single point of failure" (`store.ts:106`). Mirror the same pattern used implicitly in `getLayerOpacityFast` (`source.kind !== "unknown"`), but explicit and uniform.

4. **[code-reviewer] `src/tools/clip/get-position.ts:8` — `max(9999)` upper bound on `layer` / `clip` is pulled out of thin air; the rest of the codebase uses `assertIndex` via the client which has no upper bound.**
   `assertIndex` in `shared.ts` only enforces ≥ 1 + integer. A schema-side `max(9999)` here is the **only** tool that imposes one. Two issues: (a) inconsistency — every other tool that takes layer/clip indices does NOT cap, so the LLM sees a different surface for this one tool with no documented reason; (b) Resolume technically supports more than 9999 layers (rare in practice but the API doesn't reject it). If a user has 10000+ layers (synthetic test, art installation, scripted setup), `resolume_get_clip_position` is the one tool that fails at the schema boundary while every other index-taking tool works.
   → Fix: drop `.max(9999)` from both fields, or extract a shared `INDEX_SCHEMA` constant in `tools/types.ts` and apply it everywhere indices appear (consistent surface). The lower-bound `min(1)` is correct and worth keeping.

---

## MEDIUM (should-fix before next minor)

5. **[performance-optimizer] `src/resolume/clip.ts:108` — `wipeComposition` `expectedCleared` is computed pre-flight; a layer with N clips that fails mid-`clearclips` is still counted as N cleared.**
   The previous sequential implementation also computed the count from the snapshot, so this is contract-preserving. But it now hides per-layer failure: with the parallel cap of 4, if layer 3 returns 500 mid-wipe, the workers don't surface that — the whole `Promise.all` rejects only on the first failure and other layers' work is lost. The reported `slotsCleared` then over-counts. Acceptable for "wipe everything" semantics but worth a comment that the count is the *intended* wipe size, not necessarily the achieved one.
   → Fix: either add `Promise.allSettled` accounting, or document explicitly in the docstring (already partially done at `clip.ts:91-93` but doesn't call out the partial-failure case).

6. **[performance-optimizer] `src/resolume/clip.ts:95` — `WIPE_LAYER_CONCURRENCY = 4` is hard-coded.**
   The 4-way cap is reasonable as a default but is not configurable. A long composition with 30+ layers waits ~7-8 round-trips serially (vs ~7 batches). Could be lifted to 6-8 for hot paths or env-flag-driven. Current value is fine for ship; flag it for tuning post-launch with telemetry.
   → Fix: leave as-is for v0.5.1; consider exposing as `RESOLUME_WIPE_CONCURRENCY` later if telemetry shows it matters. Document the rationale comment slightly more explicitly: today's comment says "small concurrency window is safe" — quantify "small" and what the upper bound of safe is.

7. **[code-reviewer] `src/tools/test-helpers.ts:60-64` — `getClipPositionFastTagged` mock returns `source: "rest"` by default, which means tests that don't explicitly override see "rest" even when they intuitively expect a cache hit.**
   Subtle test-fixture trap. The default helps `tools.test.ts:179-182` (the null-position case) but works against tests authored later that assume "the default is the same path the production default takes". With store=null in production, "rest" is right; the inconsistency only bites if a test author forgets and asserts `source === "cache"` against the default mock.
   → Fix: rename `getClipPositionFastTagged` default to `source: "rest" as const` with a JSDoc note (`// matches store=null production default`) on the helper. Alternatively, default to a sentinel ("test-default") and require tests to set their expected source. Cosmetic; not blocking.

8. **[typescript-reviewer] `src/resolume/client.ts:294-306` — `getClipPositionFastTagged` tag union is opportunity for a discriminated-union type that includes the cache age.**
   The current `{ value: number | null; source: "cache" | "rest" }` is correct but loses the `ageMs` data the tool already reads. Surfacing it would let callers tune their refresh strategy ("got rest because ageMs=600 > 500") without re-fetching. Not a fix-before-ship item; design improvement for v0.5.2.
   → Suggest: extend to `{ value, source: "cache", ageMs: number } | { value, source: "rest" }` for richer tooling.

9. **[code-reviewer] `src/tools/store/cache-status.ts:9` — Description is one giant sentence ("Diagnostics tool ... safe to call any time.") at ~600 chars.**
   The other tools follow a 2-3 sentence pattern. This one runs all the operational guidance into one breath. Hurts readability for the LLM and for skim-reading by humans. Same shape pattern in `cache-refresh.ts:9` and slightly so in `osc/subscribe.ts:33`.
   → Fix: break into 2-3 shorter sentences. Move "Read-only and side-effect free" to a separate sentence; surface the field list as a bulleted comment in the source rather than embedded.

10. **[security-reviewer] `src/resolume/composition-store/store.ts:427` — `Math.random()` is correctly annotated as "non-cryptographic" but the jitter computation lacks documentation that it's bounded.**
    Bounded by `Math.max(100, ...)`, so DoS-via-very-short-reconnect is ruled out. The annotation comment "non-cryptographic — jitter only" is good. Promote it to a 2-line comment explaining the floor and the ±20% rationale ties to the design doc.
    → Fix: reference `docs/v0.5/01-composition-store.md` reconnect strategy section in the comment.

11. **[architect] `src/resolume/client.ts:73-91` — `fromConfig` accepts `store?: CompositionStore` but the constructor wraps `store ?? null`. Two-step nullability indirection.**
    Internal construct-with-undefined and construct-with-null both work. Pick one and stick. The tests use the constructor directly (3-arg, with `null`); production uses `fromConfig` (2-arg, with optional). Both paths flow through the same instance methods so behavior is identical, but the type signature could be tighter — accept `CompositionStore | null` everywhere and drop the `?` plus the `?? null` coercion.
    → Fix: in v0.5.2, normalize to `CompositionStore | null` end-to-end. Cosmetic.

12. **[architect] `src/resolume/composition-store/store.ts:262` — `invalidate()` is now no-arg (per L4 cleanup), but a future scope-aware variant will be a *new* method name, not a re-typed `invalidate(scope)`.**
    Re-broadening a method's signature is a breaking change for existing call sites that use the no-arg form. Lock the contract: rename future scoped variants `invalidateLayer(n)`, `invalidateClip(n,m)` to match `EffectIdCache`'s precedent. The docstring already hints "this method will gain a typed argument again" — that's the trap. Don't.
    → Fix: change the docstring to "Future scoped invalidation will land as separate methods (`invalidateLayer`, `invalidateClip`) following the `EffectIdCache` precedent."

13. **[code-reviewer] `skills/resolume-mcp-tester/SKILL.md:30` — "39 tools" matches manifest.json + tools.test.ts. Cross-checked.** Confirmation, not a finding. The OSC bullet at `SKILL.md:38` says "(v0.4)" but `Cache (v0.5.1, gated on RESOLUME_CACHE)` at line 39 documents the new tools. Both correct.

---

## LOW (note / consider)

14. **[typescript] `src/resolume/client.fast.test.ts:75-101` — `makeFakeStore` casts to `CompositionStore` via `as unknown as`. Tight but not type-safe; if `CompositionStore` adds a method, the fake silently misses it and tests pass even though production calls a method that doesn't exist on the fake.**
    → Use `Partial<CompositionStore>` + spread in a default fully-stubbed object. Or accept the trade-off — these are unit tests for the cache-decision logic and the fake intentionally covers only the methods exercised.

15. **[typescript] `src/resolume/client.fast.test.ts:46` — `fetchSpy` is typed as `ReturnType<typeof vi.fn>` losing the `(string|URL) → Promise<Response>` shape.** Acceptable; `.mock.calls[0]?.[0]?.toString()` works.

16. **[performance] `src/resolume/composition-store/reducers.ts:469` — `bumpRevision` allocates a fresh object every call. With the new debounce on unknown addresses, this should be << before; verify with a microbenchmark in a follow-up.**

17. **[code-reviewer] `src/tools/clip/get-position.ts:23` — Description includes "~325 msg/s aggregate, sub-ms read latency" as a hard claim. The "sub-ms" is true for cache hits but the REST fallback path shows seconds-of-latency-aware behavior. Soften to "sub-ms cache-hit / typical REST latency on miss".**

18. **[architect] `src/index.ts:52` — `ResolumeClient.fromConfig(config, store)` passes the store as positional arg #2; the constructor takes it as positional arg #3 (with `cacheOptions` in slot 2). Slightly inconsistent but the static factory papers over it. Fine.**

19. **[code-reviewer] `src/resolume/clip.ts:97-100` — `wipeComposition` exports as `async function` rather than the existing per-domain pattern of a top-level `async function` declaration. Already matches; ignore.**

20. **[performance] `src/resolume/composition-store/reducers.ts:660-666` — `applyTempo` no-op return is correct (L2 backlog item). Verified: `prev.tempo.bpmNormalized.value === value` short-circuits before the spread. Solid.**

21. **[security] `src/index.ts:77-86` — Loopback-host warning still printed to stderr only on first connect. Consider also stamping a warning when `RESOLUME_CACHE` is enabled with non-loopback `RESOLUME_OSC_HOST`. (Today the OSC host inherits from REST host; non-loopback OSC would mean the cache is binding the OSC OUT port on a routable interface. Edge case but worth a stderr hint.)**

22. **[code-reviewer] `src/tools/osc/subscribe.test.ts:85-88` — Test assertion `description.toLowerCase().contains("multiplex")` is fragile — couples a test to a specific noun in the description. If marketing reword ever calls it "fanout" instead, breaks. Loose, but acceptable.**

23. **[architect] `src/resolume/composition-store/store.ts:105-120` — `start()` races REST seed against `hydrationTimeoutMs` via `Promise.race(..., sleep(N))` but the seed itself runs to completion regardless. Means start() returns "early" if REST is slow; reads correctly fall through to REST. Reviewers concur this is the intended contract; reads with `isHydrated()=false` see the v0.4 path. Documented at line 105-107.**

24. **[code-reviewer] Manifest `count: 39` matches `tools.length` enforcement test in `tools.test.ts:18` (`expect(names.length).toBe(39)`). Consistency confirmed.**

25. **[security] `scripts/probe-subendpoints.mjs` — Script uses `fetch` against arbitrary host/port from argv; validates port via `Number()` but not range. Not user-facing risk (developer-run); fine as-is.**

---

## What landed and how it was assessed

| Stream | Headline | Test coverage | Risk note |
|---|---|---|---|
| Agent A (Phase 4) | `*Fast` cache-fast methods + `getClipPositionFastTagged` split + `resolume_get_clip_position` tool | `client.fast.test.ts` 407 LOC, 4-case matrix per method (hit / stale-fall-through / null-store / fresh-but-null) | Type signatures clean; tagged variant correctly carries provenance; null-collapse to REST is conservative-correct. **Finding #3 (HIGH) re. hydration gating.** |
| Agent B (Phase 5) | `cache_status`, `cache_refresh`; `osc_subscribe` mux | `cache-status.test.ts` (3 cases), `cache-refresh.test.ts` (3 cases), `subscribe.test.ts` (4 cases). | **Findings #1, #2 (HIGH) re. DoS surface and tool-vs-CLI placement of `cache_refresh`.** Mux behavior is sound and the EADDRINUSE auto-degrade is preserved (store.test.ts EADDRINUSE test passes after the refactor). |
| Agent C (Phase 2) | sub-endpoint static probe + `wipeComposition` rewrite | `clip.test.ts:70-128` (5 cases including the >concurrency-cap dispatch) | Probe results documented in `swagger-probe-results.md`; only #3 (clearclips) landed as a conversion. Parallelism cap of 4 is sound; **finding #5 (MEDIUM) re. partial-failure accounting**. |
| Agent D (M1-M7+L1-L5) | Backlog cleanup including `applyTempo` structural-share fix (L2), `__testInternals` typing (M1), debounced unknown-address updates (L3), regex-parser brittleness comment (L1), `invalidate()` narrow signature (L4) | reducer + store + clip tests cover each. | All low-risk; well-targeted commits. The `applyTempo` short-circuit (L2) verified to short-circuit on `prev.tempo.bpmNormalized.value === value` before the spread allocation — performance fix lands as advertised. |

## Cross-cutting confirmations

- **Test coverage**: every new public surface (`getTempoFast`, `getClipPositionFast`, `getClipPositionFastTagged`, `getCrossfaderFast`, `getLayerOpacityFast`, `cacheStatusTool`, `cacheRefreshTool`, `getClipPositionTool`, mux behavior in `oscSubscribeTool`) has at least one happy-path + one fall-through test. The matrix coverage in `client.fast.test.ts` is genuinely exhaustive on the cache-decision branch points.
- **Manifest sync**: `tool-manifest.json` count=39, `tools.test.ts` asserts `names.length === 39`, `SKILL.md` says `(v0.5.1 — 39 tools)`. All three agree.
- **Public API stability**: `client.test.ts` surface-presence test was extended with the 5 new `*Fast` methods; the v0.5.0 surface remains intact.
- **No new SSRF/auth surface**: the cache tools don't accept any user-controlled URL or path. `cache_refresh` calls into a fixed `/composition` path, `cache_status` is a pure read of in-memory bookkeeping. The osc_subscribe mux change only affects whether the address-pattern check happens against a process-owned regex (mux) or a process-bound socket (legacy) — same input shape, validated by the existing schema.
- **OSC port binding**: still gated on `RESOLUME_CACHE` env var. EADDRINUSE auto-degrades to SHARED (verified in `store.test.ts`). v0.4 default behavior unchanged — no flag, no socket bind.
- **Semver discipline**: every change is additive. `wipeComposition` is the one observable behavior change (per-layer endpoint vs per-clip endpoint); same return shape, faster execution, fewer requests.

## Recommended actions before tagging v0.5.1

1. **Address HIGH #1** (rate-limit `cache_refresh` inside `CompositionStore.refresh()`).
2. **Address HIGH #2** (mark `cache_refresh` as `stability: "alpha"`). Two-line change.
3. **Address HIGH #3** (gate `*Fast` methods on `isHydrated()`). One-line guard per method.
4. **Address HIGH #4** (drop `.max(9999)` from `get-position.ts` schema).

Items 2-4 are quick wins. Item 1 takes ~30 minutes plus a test. Total cycle time to address all HIGH findings: <2 hours.

If shipping cannot wait, **none of the four HIGH items affect default-config users** (`RESOLUME_CACHE` unset → store=null → none of the cache surfaces are reachable; `wipeComposition` partial-failure has the same contract as v0.5.0). Backlog them to v0.5.2 with explicit notes in CHANGELOG.

## Reviewers' summary

- **typescript-reviewer**: Type safety solid. Discriminated-union opportunity for the tagged variant. `__testInternals` is correctly typed now (M1 backlog item). Zod schemas in new tools follow the codebase pattern except for the unfounded upper bound in `get-position.ts` (HIGH #4).
- **security-reviewer**: No SSRF/auth regressions. `cache_refresh` is the only new surface with DoS implication (HIGH #1). EADDRINUSE auto-degrade preserved. The non-cryptographic `Math.random()` for jitter is correctly annotated.
- **architect**: `*Fast` / non-`Fast` method-pair convention scales fine with the 5 methods at this point. The store-as-optional-dependency on `ResolumeClient` is clean — it's a single private field plus null-checks at the call sites. `cache_refresh`-as-tool is the wrong placement (HIGH #2). `wipeComposition` parallel approach handles Resolume's slow-write quirks via the 4-way cap; matches the design doc commitment.
- **performance-optimizer**: `wipeComposition` parallelism with 4-way cap is conservative-safe, won't flood. `applyTempo` no-op short-circuit verified to actually skip the allocation. Cache-fast fall-through has zero redundant reads in the cache-hit path; on miss, exactly one REST GET. No flooding risk introduced.
- **code-reviewer**: Tool descriptions are inconsistently sized but technically correct. Test coverage matches the v0.5 cross-cutting principle (≥85% on new code; the reducer/store tests pad this comfortably). Manifest count verified. SKILL.md in sync.
