# v0.5 Master Roadmap

Synthesizes the four component designs ([01](./01-composition-store.md), [02](./02-domain-client-split.md), [03](./03-tool-registry.md), [04](./04-effect-cache-and-sub-endpoints.md)) and the [prior-art survey](./00-prior-art.md) into one execution plan.

---

## Component summary

| # | Component | Headline win | Risk | Lives | Touched files |
|---|---|---|---|---|---|
| 1 | **CompositionStore + OSC push** | Eliminate REST round-trips for high-frequency reads (~325 msg/s OSC stream cached, sync reads) | HIGH — owns persistent UDP socket, must coexist with `osc_subscribe` tool | new `composition-store/` dir | `client.ts`, `index.ts`, `config.ts`, `tools/osc/subscribe.ts`, `tools/types.ts` |
| 2 | **Per-domain client split** | `client.ts` 549 → ~150 lines, 4 new domain files matching `effects.ts` precedent | LOW — pure refactor, byte-identical public API | new `composition.ts`, `clip.ts`, `layer.ts`, `tempo.ts`, `shared.ts` | `client.ts`, all `client.v*.test.ts` |
| 3 | **Tool registry + stability tiers** | Auto-discover tools from `src/tools/**`, `[BETA]`/`[ALPHA]` prefixes, deprecation lifecycle | MEDIUM — codegen + manifest + skill-sync changes | new `gen-tool-index.mjs`, `index.generated.ts`, `tool-manifest.json`, `registry.ts` | `tools/index.ts`, `tools/types.ts`, `server/registerTools.ts`, `check-skill-sync.mjs`, `package.json` |
| 4 | **Effect-id cache + sub-endpoints** | Halve request rate for BPM-synced parameter loops; narrower endpoints where Resolume exposes them | LOW — cache is correctness-preserving by construction | new `effect-id-cache.ts` | `effects.ts`, `client.ts`, `config.ts` |

---

## Dependency graph

```
[ Component 2: client split ]
   └─→ provides clean per-domain API surface for components 1 & 4 to hook into

[ Component 3: registry + tiers ]
   └─→ INDEPENDENT — can ship in parallel; no dep on 1/2/4

[ Component 4: effect-id cache ]
   └─→ best done AFTER component 2 (so cache lives in domain effects module cleanly)
   └─→ INDEPENDENT of components 1 & 3

[ Component 1: CompositionStore ]
   └─→ best done AFTER component 2 (clean composition.ts surface to bind to)
   └─→ INDEPENDENT of components 3 & 4
```

**Critical path**: 2 → (1, 3, 4 in parallel).

---

## Recommended sequencing

### Sprint A (parallel, low risk) — ships as v0.4.3

- **Component 2 (client split)** — 10 commits per the design doc. Pure refactor.
- **Component 3 Phase 0** (codegen lands alongside manual array, no behavior change). Easy revert.

These are orthogonal and can run as two parallel feature branches. Both ship as v0.4.3 patch — no user-visible change.

### Sprint B (parallel, ships as v0.5.0)

- **Component 1 Phases 1-3** (types, reducers, store class, config + bootstrap). Library-only; no tools yet.
- **Component 3 Phases 1-2** (flip import to generated, add stability tiers). Mark `tap_tempo` as beta.
- **Component 4 Phase 1** (effect-id cache, all 3 sub-PRs).

Ships as v0.5.0 — minor bump because of additive surface and the new `RESOLUME_CACHE` / `RESOLUME_TOOLS_STABILITY` / `RESOLUME_EFFECT_CACHE` env vars.

### Sprint C — ships as v0.5.1

- **Component 1 Phases 4-6** (cache-fast `*Fast` methods on `ResolumeClient`, new tools `cache_refresh`/`cache_status`/`get_clip_position`, multiplex `osc_subscribe` through the store, live verification).
- **Component 3 v0.5.1 bonus** (stability-aware skill-sync check).
- **Component 4 Phase 2** (sub-endpoint probe + per-family conversion PRs — gated on live Resolume access).

Ships as v0.5.1.

### Sprint D — ships as v1.0.0

Stability and contract sealing:
- Bump to **v1.0.0** so any future deprecation `removeIn` can land cleanly.
- Publish to npm (first publish — README badge currently 404s).
- Document deprecation policy in `CONTRIBUTING.md`.

---

## Cross-cutting principles

These are non-negotiable across all four components:

1. **No breaking API changes.** Every existing tool keeps working. New surfaces are additive.
2. **Everything is opt-in.** Each component gates on an env var with a default that reproduces v0.4.2 behavior:
   - `RESOLUME_CACHE` (off by default for component 1)
   - `RESOLUME_TOOLS_STABILITY` (default `beta` — exposes stable + beta but not alpha)
   - `RESOLUME_EFFECT_CACHE` (default `1` — cache enabled, opt-out)
3. **80%+ coverage maintained.** Each component aims ≥85% on new code.
4. **Skill stays in sync.** Every PR that touches `src/tools/` must update `skills/resolume-mcp-tester/SKILL.md` in the same commit. `check-skill-sync` blocks publish.
5. **Live verification before release.** No new tool ships without snapshot → mutate → verify → restore via the `resolume-mcp-tester` skill (Recipe B).

---

## Prior-art takeaways applied

From the [survey](./00-prior-art.md):

- **Borrow Companion's hybrid OSC+WS state model** → component 1 design uses OSC push for hot-path reads + REST seed/reconcile.
- **Borrow Companion's single-socket recv+send pattern** → component 1's OWNER mode uses one persistent UDP socket. (Currently `osc-client.ts` is fully stateless — refactored carefully so the existing `osc_subscribe` tool keeps working in OFF mode.)
- **Borrow Companion's cached effect-param lookups** → component 4's `effect-id-cache.ts` matches their approach.
- **Borrow drohi's `confirm_destructive` envelope policy** → out of scope for v0.5 but recorded as a v0.6 candidate (would generalize the existing `clear_layer.confirm` pattern).
- **Avoid Tortillaguy's `execute(code)` meta-tool** → no plans to add anything similar.
- **Avoid drohi's 3,269-line monolithic registry** → component 2 is exactly the opposite move.
- **Stability tiers are a gap in all three reference repos** → component 3 fills it.

---

## Risk register

| Risk | Component | Severity | Mitigation |
|---|---|---|---|
| OSC OUT port contention with existing user OSC tools | 1 | HIGH | EADDRINUSE → auto-degrade to SHARED mode; document |
| Optimistic cache write divergence on Resolume clamping | 1 | MEDIUM | Apply only after REST 2xx; OSC echo is authoritative |
| Public method silently dropped during client split | 2 | HIGH | Surface-presence assertion + tool test suite |
| Codegen / source drift on tool registry | 3 | MEDIUM | `--check` CI gate + pre-commit hook |
| Bundlers strip generated tool index | 3 | LOW | Static imports — bundler-safe by design |
| Effect-id cache drift via UI/OSC mutation | 4 | MEDIUM | TTL + opt-out flag + documented |
| Speculative sub-endpoint regression | 4 | LOW | Per-family PRs; keep wide PUT as fallback |
| `tap_tempo` re-tier surprise (default `beta` exposes it) | 3 | LOW | stderr startup line documents what's hidden |

---

## What's NOT in v0.5

Explicit non-goals to keep scope tight:

- **WebSocket subscribe channel.** Companion uses Resolume's WS for state push; we have OSC push verified at higher cadence (~325 msg/s). Adding WS would duplicate the cache-feeding path. Defer.
- **Generic options cache (blend modes, transition modes, beat-snap).** Listed as "derived" in component 4 — defer to v0.6 once we have profiling data.
- **`confirm_destructive` envelope generalization.** drohi has it; we don't need it yet (only one destructive tool currently uses `confirm`). Defer to v0.6.
- **FFT / audio-level data.** Confirmed not exposed in any Resolume API — workaround is external WASAPI loopback FFT streamed as OSC.
- **WebSocket tool surface.** No tool currently uses WS; adding one for v0.5 is unjustified scope.
- **npm publish.** Hold until v1.0.0 to lock the contract first.

---

## Estimated effort

| Sprint | Components | Rough commits | Rough timeline |
|---|---|---|---|
| A (v0.4.3) | 2, 3 phase 0 | 12 | 1 session |
| B (v0.5.0) | 1 phases 1-3, 3 phases 1-2, 4 phase 1 | 15 | 1 session |
| C (v0.5.1) | 1 phases 4-6, 3 bonus, 4 phase 2 | 10 | 1 session, gated on live Resolume |
| D (v1.0.0) | npm publish, deprecation policy doc | 2 | 1 short session |

Total: ~39 commits across 4 sprints.

---

## Decision log

- **Picked Option C (module-level helpers + facade)** for component 2, matching `effects.ts` precedent. Mixin and held-instance composition rejected.
- **Picked build-time codegen** for component 3 over runtime fs discovery. Bundler-safe, fails fast at build time.
- **Cache-id only, not full param schema** in component 4. Memory + drift trade-off.
- **`OWNER` mode is default when `RESOLUME_CACHE=1`** in component 1. EADDRINUSE auto-degrades to SHARED. OFF mode is the no-flag default.
- **Tool registry default tier is `beta`** (exposes stable + beta). Conservative operators set to `stable`; daring ones set to `alpha`.
- **Bump to v1.0.0 before any tool deletion.** Pre-1.0 semver allows breakage in minors but we'll respect users' contracts.
