# Per-Domain Client Split (v0.5)

## Overview

`src/resolume/client.ts` has been the dumping ground for every Resolume domain (composition, clip, layer, tempo, blend, transition, crossfader, beat snap, thumbnails, effects). v0.4.2 already proved out the extraction pattern with `effects.ts`: pure module-level functions taking `ResolumeRestClient` as the first argument, re-surfaced through one-line wrapper methods on `ResolumeClient`. This produced a clean precedent — public API unchanged, effects independently testable, client.ts dropped from 806 to 549 lines.

We will repeat that pattern for the remaining domains. The `ResolumeClient` class stays as a thin facade so every existing tool keeps working without touching `src/tools/**`. Each domain file becomes the canonical home for its logic, owns its own validation helpers, and has its own focused test file.

Target end state: `client.ts` ~150 lines (constructor, factory, `summarizeComposition`, and ~30 one-line delegation methods).

## Final file layout

```
src/resolume/
├── client.ts                        # Thin facade. Constructor, fromConfig, summary, delegations. ~150 lines.
├── rest.ts                          # Untouched.
├── types.ts                         # Untouched.
├── shared.ts                        # NEW. assertIndex, value/name extractors. Shared by domain modules.
│
├── composition.ts                   # NEW. Composition-level reads + crossfader + beat snap.
│   exports: getComposition, getProductInfo, summarizeComposition,
│            getBeatSnap, setBeatSnap, getCrossfader, setCrossfader,
│            triggerColumn, selectDeck
│
├── clip.ts                          # NEW. Clip-targeted operations.
│   exports: triggerClip, selectClip, getClipThumbnail,
│            setClipPlayDirection, setClipPlayMode, setClipPosition,
│            clearClip, wipeComposition
│
├── layer.ts                         # NEW. Layer-targeted operations.
│   exports: setLayerOpacity, setLayerBypass,
│            setLayerBlendMode, getLayerBlendModes,
│            setLayerTransitionDuration,
│            setLayerTransitionBlendMode, getLayerTransitionBlendModes,
│            clearLayer
│
├── tempo.ts                         # NEW. Tempo controller.
│   exports: getTempo, setTempo, tapTempo, resyncTempo
│
├── effects.ts                       # Untouched. Already module-level pattern.
│
├── osc-codec.ts                     # Untouched.
├── osc-client.ts                    # Untouched.
│
└── tests (colocated):
    ├── client.test.ts               # Slimmed to facade-only.
    ├── composition.test.ts          # NEW.
    ├── clip.test.ts                 # NEW.
    ├── layer.test.ts                # NEW.
    ├── tempo.test.ts                # NEW.
    ├── effects.test.ts              # Renamed from client.effects.test.ts.
    ├── rest.test.ts                 # Untouched.
    ├── osc-client.test.ts           # Untouched.
    └── osc-codec.test.ts            # Untouched.
```

The legacy `client.v2.test.ts` / `client.v3.test.ts` / `client.v4.test.ts` files (named for version drops) get dissolved into per-domain test files.

### Column/deck not its own file
`triggerColumn` is one POST, `selectDeck` is one POST. Two methods don't justify a file. They live in `composition.ts`.

## Composition pattern

Three options, evaluated against the v0.4.2 `effects.ts` precedent.

### Option A — Mixin inheritance
TypeScript mixin typing is messy; loses the "pure function with explicit deps" property. Diverges from precedent. **Reject.**

### Option B — Composition (held instances)
Domain client classes carry no state beyond `rest`. Doubles boilerplate vs module-level pattern. **Reject.**

### Option C — Module-level helpers + thin facade methods (matches effects.ts)

```ts
// src/resolume/clip.ts
export async function triggerClip(rest: ResolumeRestClient, layer: number, clip: number): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  await rest.post(`/composition/layers/${layer}/clips/${clip}/connect`);
}
```

```ts
// src/resolume/client.ts
import * as clip from "./clip.js";
async triggerClip(layer: number, c: number): Promise<void> {
  return clip.triggerClip(this.rest, layer, c);
}
```

**Decision: Option C.** Matches existing precedent, satisfies all constraints, simplest of the three.

### Naming convention inside each module
Match `effects.ts` exactly. Use namespace import (`import * as clip from "./clip.js"`) — avoids name clashes between facade methods and helpers, makes provenance obvious. **Recommend switching effects import to namespace style during this refactor.**

### Shared helpers — `shared.ts`

```ts
export type IndexKind = "layer" | "column" | "clip" | "deck" | "effect";
export function assertIndex(what: IndexKind, n: number): void { ... }
export function extractName(p: { value?: unknown } | undefined): string | null { ... }
export function extractValue(p: { value?: unknown } | undefined): unknown { ... }
export function filterStringOptions(opts: unknown): string[] { ... }
```

`assertIndex` is currently defined twice (client.ts:484-493 and effects.ts:58-67). Consolidating eliminates drift.

## Migration steps

1. **Extract `shared.ts`.** Move `assertIndex` + extractors. Update existing files to import. Tests unchanged.
2. **Convert effects.ts import to namespace style** in client.ts.
3. **Extract `tempo.ts`** (canary — smallest non-trivial domain). Move 4 methods.
4. **Extract `composition.ts`.** Includes column/deck.
5. **Extract `layer.ts`.**
6. **Extract `clip.ts`** (last because `wipeComposition` calls `getComposition`).
7. **Slim `client.test.ts`** to facade-only.
8. **Rename `client.effects.test.ts` → `effects.test.ts`.**
9. **Delete obsolete client.v2/v3/v4 test files** once their describes have been relocated.
10. **Verify final state.** Add API surface presence assertion in client.test.ts.

Each numbered step is a separate `refactor:` commit. CI must pass before moving to the next.

## Test plan

Per-domain tests instantiate a mocked `ResolumeRestClient` (existing `buildClient` helper pattern) and call helpers directly — no `ResolumeClient` instance needed.

**Slim facade test** in `client.test.ts`:
- `ResolumeClient.fromConfig` constructs correctly
- `summarizeComposition` (re-export)
- One delegation smoke per domain (asserts `rest.post` is called with right path)

**Tool tests stay 100% unchanged.** They mock `ResolumeClient` via `buildCtx`. Public API is byte-identical.

**API surface presence assertion** (cheapest safety net):
```ts
const expected = ["triggerClip", "setTempo", "setLayerOpacity", "addEffectToLayer", ...];
for (const method of expected) {
  expect(typeof (client as any)[method]).toBe("function");
}
```

**Coverage**: 80% threshold preserved. Lines move, not disappear.

## Public API decision: keep the facade

Tools always go through `ResolumeClient`. Reasons:
1. Tool tests rely on it (`buildCtx` in `tools/test-helpers.ts`).
2. Connection lifecycle (`fromConfig`, base URL, timeouts) lives on the class.
3. Cross-cutting concerns (logging, retries, telemetry) want a single chokepoint.
4. Helpers are still importable for non-tool consumers.

The facade is NOT a place to add new logic. New logic always goes in the domain module.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Public method dropped during move | **HIGH** | Run full tool test suite after each step. Add surface-presence assertion. |
| `summarizeComposition` re-export missed | MEDIUM | Re-export from `client.ts`. |
| `assertIndex` divergence during step 1 | MEDIUM | Step 1 consolidates; both sites point to shared module. |
| Circular imports (clip.ts → composition.ts for `wipeComposition`) | MEDIUM | One-way edge only. Verify with `madge`. |
| Test file deletion timing | MEDIUM | Move describes in same commit as source. CI rejects coverage drop. |
| Loss of git blame on moved code | LOW | Use `git log --follow`. |

The dominant risk is **dropping a public method**. Two layers: tool test suite + surface-presence assertion.

## Sequencing (commit-by-commit)

| # | Commit | Why this order |
|---|---|---|
| 1 | `refactor: introduce shared.ts for cross-domain helpers` | Eliminate `assertIndex` duplication first |
| 2 | `refactor: import effects.js as namespace in client.ts` | Sets import-style precedent |
| 3 | `refactor: lift buildClient into resolume/test-helpers.ts` (optional) | Reduce test-file duplication |
| 4 | `refactor: extract tempo domain into tempo.ts` | **Canary** — smallest domain validates pattern |
| 5 | `refactor: extract composition domain into composition.ts` | Read-heavy backbone, extract before clip |
| 6 | `refactor: extract layer domain into layer.ts` | Self-contained |
| 7 | `refactor: extract clip domain into clip.ts` | Last — `wipeComposition` imports from composition.ts |
| 8 | `refactor: rename client.effects.test.ts → effects.test.ts` | Cosmetic |
| 9 | `chore: delete obsolete client.v2/v3/v4 test files` | Cleanup |
| 10 | `refactor: slim client.ts to facade-only and add API surface assertion` | Final shape |

After step 10: `client.ts` ~150 lines, new `shared.ts` + 4 domain files. Zero changes under `src/tools/`. CI green at every step.

---

## Executive summary

- **Match the effects.ts precedent (Option C):** module-level `async function name(rest, ...)` helpers in per-domain files, surfaced through one-line wrapper methods on `ResolumeClient`. Mixins (A) and held-instance composition (B) add ceremony the codebase has already rejected once.
- **Five new domain files** (`composition.ts`, `clip.ts`, `layer.ts`, `tempo.ts`, plus existing `effects.ts`) and one shared utility file (`shared.ts`) consolidating duplicated `assertIndex`/extractor helpers. `client.ts` shrinks from 549 lines to ~150 lines of pure delegation.
- **Public API stays byte-identical**, so zero changes under `src/tools/**` and `tools/test-helpers.ts`. Tools continue to call `ctx.client.someMethod(...)` exactly as today; the facade is the long-term entry point and should not be bypassed.
- **Tests reorganize by domain** (`tempo.test.ts`, `composition.test.ts`, `clip.test.ts`, `layer.test.ts`, `effects.test.ts`); the version-bucket files (`client.v2/v3/v4.test.ts`) get dissolved. `client.test.ts` keeps only `fromConfig`, `summarizeComposition`, and a public-API surface-presence assertion. 80%+ coverage is preserved because lines move, not disappear.
- **Sequence: shared.ts first, then tempo (canary), composition, layer, clip, then slim client.ts last.** Each step is a green-CI commit; the dominant risk (silently dropping a public method) is caught by both the existing tool test suite and an explicit method-presence check on `ResolumeClient`.
