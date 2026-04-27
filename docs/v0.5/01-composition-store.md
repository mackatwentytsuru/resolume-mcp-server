# CompositionStore Design (v0.5)

## Overview

`CompositionStore` is an **in-memory, push-driven cache** of Resolume composition state, fed primarily by Resolume's OSC OUT broadcast stream and seeded/reconciled via REST. Its goal is to eliminate REST round-trips for high-frequency reads (BPM, layer opacity, clip transport position) while preserving the existing REST-only paths for data Resolume does not push (thumbnails, blend-mode option lists, full slot metadata).

**Why now:** v0.4 verified Resolume pushes ~325 msg/s of live state on `/composition/*`. Today, every read tool blocks on a 1–10 ms HTTP round-trip; an LLM that polls playhead position 30× per second pays 30 round-trips. With the cache, those become synchronous, allocation-free reads.

**Design constraints honored:**
- **Additive only** — `ResolumeClient` keeps every existing method intact.
- **Opt-in** — `RESOLUME_CACHE=1` toggles the cache; default behavior is bit-for-bit identical to v0.4.
- **Coexistence** — must not break `resolume_osc_subscribe`, which exclusively binds the OSC OUT port.
- **No new runtime deps** — reuses `osc-codec.ts`, `node:dgram`.
- **TS strict, 80%+ coverage**.

---

## State shape

The snapshot is a plain immutable record. Mutators always return a new object (spread-copy), so concurrent readers never observe a torn write.

```typescript
// src/resolume/composition-store/types.ts

/** Provenance tag on every cached field — drives staleness checks and tool diagnostics. */
export type Source =
  | { kind: "osc"; receivedAt: number }       // last OSC push time (ms epoch)
  | { kind: "rest"; fetchedAt: number }       // last REST hydration time
  | { kind: "unknown" };                      // never observed

export interface CachedScalar<T> {
  value: T;
  source: Source;
}

/** Per-clip slice — only fields Resolume reliably pushes via OSC. */
export interface CachedClip {
  layerIndex: number;        // 1-based
  clipIndex: number;         // 1-based
  name: CachedScalar<string | null>;          // OSC: rare; mostly REST-seeded
  connected: CachedScalar<boolean>;           // OSC: /composition/layers/N/clips/M/connect (T/F)
  selected: CachedScalar<boolean>;            // OSC: /composition/layers/N/clips/M/select
  /** Normalized 0..1 — pushed every frame at ~325 msg/s aggregate. */
  transportPosition: CachedScalar<number | null>;
  /** REST-only: never pushed by OSC. */
  hasMedia: CachedScalar<boolean>;
}

export interface CachedLayer {
  layerIndex: number;        // 1-based
  name: CachedScalar<string | null>;          // REST + occasional OSC echo
  opacity: CachedScalar<number>;              // OSC: /composition/layers/N/video/opacity
  bypassed: CachedScalar<boolean>;            // OSC: /composition/layers/N/bypassed
  solo: CachedScalar<boolean>;                // OSC: /composition/layers/N/solo
  /** Layer-level normalized position — pushed by Resolume per CLAUDE.md note. */
  position: CachedScalar<number | null>;
  /** REST-only — Resolume does not push the *string* value of Blend Mode, only its index. */
  blendMode: CachedScalar<string | null>;
  clips: ReadonlyArray<CachedClip>;
}

export interface CachedTempo {
  /** REST stores raw BPM; OSC pushes 0..1 normalized. We keep both. */
  bpm: CachedScalar<number | null>;           // raw BPM (REST-seeded, OSC-decoded if range known)
  bpmNormalized: CachedScalar<number | null>; // OSC: /composition/tempocontroller/tempo
  min: CachedScalar<number | null>;           // REST-only
  max: CachedScalar<number | null>;           // REST-only
}

export interface CachedComposition {
  /** Monotonic version, bumped on every applied mutation. Lets readers detect change. */
  revision: number;
  /** Was the snapshot ever populated? False until first REST seed succeeds. */
  hydrated: boolean;
  /** True iff the OSC listener is bound and has received at least one packet. */
  oscLive: boolean;
  /** ms epoch of the last OSC packet (any address). null if never. */
  lastOscAt: number | null;
  /** ms epoch of the last full REST seed. null if never. */
  lastSeedAt: number | null;

  tempo: CachedTempo;
  crossfaderPhase: CachedScalar<number | null>;          // OSC + REST
  beatSnap: CachedScalar<string | null>;                 // REST-only (option list)
  beatSnapOptions: ReadonlyArray<string>;                // REST-only

  layerCount: number;        // derived from layers.length
  columnCount: number;       // REST-only
  deckCount: number;         // REST-only
  selectedDeck: CachedScalar<number | null>;             // OSC: /composition/decks/N/select

  layers: ReadonlyArray<CachedLayer>;
  /** Raw column/deck names (REST-only — OSC doesn't push these). */
  columnNames: ReadonlyArray<string | null>;
  deckNames: ReadonlyArray<string | null>;
}
```

**OSC-pushed vs REST-only matrix:**

| Field | OSC pushed | REST seed | Notes |
|---|---|---|---|
| `tempo.bpmNormalized` | yes | no | normalized 0..1 |
| `tempo.bpm` raw | no | yes | derived from REST `tempocontroller.tempo.value` |
| `tempo.min`/`max` | no | yes | needed to denormalize OSC tempo |
| `crossfaderPhase` | yes | yes | -1..1 |
| `beatSnap` value | yes | yes | string |
| `beatSnapOptions` | no | yes | option list never pushed |
| `layer.opacity` | yes | yes | 0..1 |
| `layer.bypassed`/`solo` | yes | yes | boolean |
| `layer.blendMode` | partial | yes | OSC pushes index, REST gives string label |
| `clip.connected`/`selected` | yes | yes | boolean |
| `clip.transportPosition` | yes (~325 Hz) | yes | normalized 0..1 |
| `clip.name` | rare | yes | REST authoritative |
| `clip.hasMedia` | no | yes | structural |
| `columnNames`/`deckNames` | no | yes | structural |
| thumbnails | no | yes | binary, never cached |

---

## Subscription strategy

This is the hardest part: `osc-client.ts` is intentionally stateless and `resolume_osc_subscribe` exclusively binds OSC OUT. We need a long-lived listener without breaking either invariant.

### Three operating modes

The store negotiates one of three modes at startup based on env config and runtime state:

1. **`OWNER` mode (default when `RESOLUME_CACHE=1`)** — the store owns a persistent UDP socket bound to OSC OUT. The legacy `resolume_osc_subscribe` tool detects this and **multiplexes through the store** instead of creating its own bound socket.

2. **`SHARED` mode (env `RESOLUME_CACHE=passive`)** — the store does NOT bind. Instead, when other tools (`resolume_osc_subscribe`, `resolume_osc_query`) collect messages, they push them into the store via a `feed(message)` API. The store's freshness degrades when no tool is listening, but no port contention.

3. **`OFF` mode (default, no env flag)** — store is not constructed; tools fall through to REST exactly as they do today.

### Owner-mode socket lifecycle

```typescript
interface CompositionStoreOptions {
  socketFactory?: SocketFactory;       // dgram default; tests inject fake
  rest: ResolumeRestClient;            // shared with ResolumeClient
  osc: OscConfig;                      // host + inPort + outPort
  mode: "owner" | "shared" | "off";
  hydrationTimeoutMs?: number;         // default 5000
  rehydrateThrottleMs?: number;        // default 500 — debounces drift refetches
}

class CompositionStore {
  private socket: UdpSocketLike | null = null;
  private snapshot: CachedComposition;  // immutable; replaced on each apply
  private listeners: Set<(s: CachedComposition) => void> = new Set();
}
```

On `start()` in OWNER mode:
1. `factory()` → bind `outPort`. On `EADDRINUSE`, automatically downgrade to `SHARED` mode (warn on stderr) so the user's existing OSC listener keeps working.
2. Attach `message`/`error` listeners. Decode each packet via `decodePacket`, update `lastOscAt`, route address → reducer.
3. Run REST hydration in parallel (see next section).
4. After both complete, set `hydrated = true` and publish.

### Coexistence with `resolume_osc_subscribe`

The current tool spins up its own socket on the same port → **EADDRINUSE if store is bound**. Solution: introduce a `SubscriptionMux`.

```typescript
class CompositionStore {
  // additive: tools can subscribe to a pattern *without* binding their own socket.
  subscribe(pattern: string, handler: (msg: ReceivedOscMessage) => void): () => void;
  // collect helper for the existing subscribe tool — replicates current behavior.
  collect(pattern: string, durationMs: number, maxMessages: number): Promise<ReceivedOscMessage[]>;
}
```

The `resolume_osc_subscribe` tool is updated to:

```typescript
handler: async (args, ctx) => {
  if (ctx.store) {
    // OWNER mode — multiplex through the store, no port contention
    const messages = await ctx.store.collect(args.addressPattern, args.durationMs, args.maxMessages);
    return jsonResult({ ... });
  }
  // Legacy path — unchanged
  const messages = await subscribeOsc(ctx.osc.outPort, args.addressPattern, args.durationMs, args.maxMessages);
  return jsonResult({ ... });
}
```

The legacy code path stays compiled in and is the only path used when `RESOLUME_CACHE` is unset, preserving every existing behavior bit-for-bit.

---

## Hydration flow

OSC pushes incremental updates; it never gives you the full tree. So we need a REST seed at startup, plus targeted re-seeds on drift.

### Startup (Owner mode)

```
start()
  ├─ bind socket on outPort
  │    ├─ EADDRINUSE → degrade to SHARED, continue
  │    └─ other error → bubble up; store stays oscLive=false
  ├─ in parallel:
  │    ├─ REST GET /composition  →  applyFullSeed()  →  hydrated=true
  │    └─ first OSC packet      →  oscLive=true
  └─ resolve start() once *either* hydration completes OR hydrationTimeoutMs elapses
```

`start()` never throws on hydration failure — it logs to stderr and leaves `hydrated=false`. Reads then transparently fall through to REST. This matches Resolume's reality: it may not be running at MCP boot.

### Resolume not running at startup

- REST seed fails → store stays `hydrated=false`, `oscLive=false`.
- Background **reconnect loop**: every 5s (jittered ±20%), retry REST seed with a short timeout (1s). On success, hydrate + bump revision. Loop stops once hydrated.
- Reads always fall through to REST when `!hydrated`. The cache is always *opt-in optimization*, never a single point of failure.

### Re-seed triggers

- Detected drift (clip count change, layer added/removed) → throttled `applyFullSeed()`.
- Explicit invalidation after writes — see below.
- Manual refresh tool: `resolume_cache_refresh` (new in v0.5).

---

## Invalidation

We use a **hybrid strategy** — TTL is too coarse, message-driven alone misses structural changes.

### 1. Per-field freshness (TTL guards)

Every `read*()` consults `source.receivedAt` / `fetchedAt`. If the field is older than its kind-specific TTL, the store falls through to REST.

| Field | TTL | Rationale |
|---|---|---|
| `transportPosition` | 250 ms | Pushed every 3 ms when playing; if silent for 250 ms, clip likely stopped — refetch is cheap. |
| `opacity`, `bypassed`, `solo` | 5 s | User-driven, low frequency. |
| `bpm`, `crossfaderPhase` | 2 s | Per-show params. |
| structural (clip count, names) | 30 s | Rarely change at show time. |

TTLs are constants in `composition-store/ttl.ts` and overridable via `CompositionStoreOptions.ttls`.

### 2. Message-driven invalidation

When the OSC listener decodes an address that does NOT match any known reducer (e.g. a layer index ≥ `layerCount`), it queues a debounced full re-seed:

```typescript
private onUnknownAddress(addr: string): void {
  this.scheduleRehydrate("structural-drift", addr);
}
```

Debounce is `rehydrateThrottleMs` (default 500 ms).

### 3. Write-driven invalidation

Every mutating method on `ResolumeClient` (e.g. `setLayerOpacity`, `triggerClip`) optimistically updates the cache **before** the REST PUT, then on success leaves it as-is, on failure rolls back. The optimistic write is the **same shape** the OSC echo would deliver, so the next OSC frame is a no-op.

For coarse mutations (`clearLayer`, `selectDeck`), the store schedules a targeted REST refetch of just that subtree (`GET /composition/layers/N`) instead of the whole tree.

### 4. Explicit refresh tool

`resolume_cache_refresh` (new tool, gated on `RESOLUME_CACHE`) runs `applyFullSeed()` synchronously and returns timings. Useful for debugging and for the LLM to recover from rare drift.

---

## API surface

Two entry points, no breaking changes.

### A. New `CompositionStore` class — sits **alongside** `ResolumeClient`

```typescript
// src/resolume/composition-store/index.ts

export class CompositionStore {
  // Lifecycle
  static fromConfig(config: ResolumeConfig, rest: ResolumeRestClient, opts?: Partial<CompositionStoreOptions>): CompositionStore;
  start(): Promise<void>;                    // bind + seed
  stop(): Promise<void>;                     // close socket, clear timers (idempotent)

  // Snapshot reads — synchronous, never throw
  readSnapshot(): CachedComposition;
  readTempo(): CachedTempo;
  readLayer(layerIndex: number): CachedLayer | null;
  readClip(layer: number, clip: number): CachedClip | null;
  readClipPosition(layer: number, clip: number): { value: number | null; ageMs: number; source: Source };
  readCrossfader(): CachedScalar<number | null>;

  // Freshness gates — used by ResolumeClient when deciding cache-vs-REST
  isFresh(field: "transportPosition" | "opacity" | "bpm" | "structural", ageMs?: number): boolean;
  isHydrated(): boolean;
  isOscLive(): boolean;

  // Subscription mux
  subscribe(pattern: string, handler: (msg: ReceivedOscMessage) => void): () => void;
  collect(pattern: string, durationMs: number, maxMessages: number): Promise<ReceivedOscMessage[]>;

  // Manual invalidation
  feed(msg: ReceivedOscMessage): void;       // SHARED mode push-in API
  refresh(): Promise<{ durationMs: number; revision: number }>;
  invalidate(scope: "all" | { layer: number } | { layer: number; clip: number }): void;

  // Diagnostics
  stats(): {
    revision: number;
    hydrated: boolean;
    oscLive: boolean;
    lastOscAt: number | null;
    lastSeedAt: number | null;
    msgsReceived: number;
    rehydrationsTriggered: number;
    mode: "owner" | "shared" | "off";
  };

  // Reactivity
  onChange(listener: (snapshot: CachedComposition) => void): () => void;
}
```

### B. `ResolumeClient` — new optional `store` dependency, additive read-fast paths

```typescript
export class ResolumeClient {
  constructor(
    private readonly rest: ResolumeRestClient,
    private readonly store: CompositionStore | null = null   // NEW, optional
  ) {}

  static fromConfig(config: ResolumeConfig, store?: CompositionStore): ResolumeClient { ... }

  // Existing methods unchanged. New cached variants prefer the cache when fresh:
  async getTempoFast(): Promise<TempoState> {
    const t = this.store?.readTempo();
    if (t && this.store!.isFresh("bpm")) {
      return { bpm: t.bpm.value, min: t.min.value, max: t.max.value };
    }
    return this.getTempo();   // REST fallback
  }

  async getClipPositionFast(layer: number, clip: number): Promise<number | null> {
    const c = this.store?.readClipPosition(layer, clip);
    if (c && c.value !== null && c.ageMs < 500) return c.value;
    const raw = await this.rest.get(`/composition/layers/${layer}/clips/${clip}`);
    return extractPosition(raw);
  }
}
```

**Naming convention:** existing methods (`getTempo`) are unchanged and always REST. New `*Fast` variants are cache-first. Tools opt in by calling the `Fast` variant; no auto-magical switching.

### C. Tool integration

- `getCompositionTool` — unchanged (full REST snapshot is the right shape).
- `resolume_get_clip_position` (new) — uses `getClipPositionFast`.
- `resolume_cache_refresh` (new) — calls `store.refresh()`.
- `resolume_cache_status` (new) — calls `store.stats()`.
- `resolume_osc_subscribe` — when `ctx.store` exists, multiplexes via `store.collect(...)`.

---

## Backward compat / opt-in flag

Single env knob:

```
RESOLUME_CACHE=        # absent or empty   → mode "off"   (v0.4 behavior, no socket bound)
RESOLUME_CACHE=1       # or "owner"         → store binds OSC OUT exclusively
RESOLUME_CACHE=passive # or "shared"        → store does NOT bind; fed by other tools
```

`config.ts` parses it into `ResolumeConfig.cache: { mode: "off" | "owner" | "shared" }`.

`index.ts` becomes:

```typescript
const config = loadConfig();
const rest = new ResolumeRestClient({ baseUrl: ..., timeoutMs: config.timeoutMs });
const store = config.cache.mode === "off"
  ? null
  : CompositionStore.fromConfig(config, rest, { mode: config.cache.mode });
const client = new ResolumeClient(rest, store);
if (store) {
  await store.start();
  process.on("SIGINT", () => store.stop());
}
registerTools(server, { client, osc: config.osc, store });
```

**Default = off** is a deliberate conservative choice: zero behavior change for existing users.

---

## Test strategy

Reuse the `FakeSocket` pattern from `osc-client.test.ts`. The store accepts a `SocketFactory` and a `fetchImpl`, so tests run with zero real I/O.

### Unit — `composition-store/reducers.test.ts`
Pure reducer functions: given a snapshot + an OSC message, return the new snapshot.
- `applyOpacityUpdate` for valid layer index / out-of-range layer
- `applyTransportPosition` honors the clip-level address
- `applyFullSeed` from a fixture REST tree
- Immutability: assert `prev !== next` and `prev.layers[0] !== next.layers[0]` only when that layer changed

### Unit — `composition-store/ttl.test.ts`
- Vitest fake timers; verify `isFresh()` flips at exact thresholds.

### Integration — `composition-store/store.test.ts`
- Construct with `FakeSocket` + mocked `fetchImpl`.
- `start()`:
  - happy path: REST returns canned `/composition` JSON, fake socket emits a tempo packet → assert `hydrated && oscLive`.
  - REST fails: assert reconnect loop fires, eventually succeeds.
  - EADDRINUSE on bind: assert mode degrades to SHARED, no socket bound.
- Drift: emit a packet for `/composition/layers/9/...` when `layerCount=3` → assert `applyFullSeed` called once after debounce.
- Mux: `subscribe("/composition/layers/*/video/opacity", h)` then emit two matching + one non-matching packet → assert `h` called twice with right messages.
- Optimistic write: `client.setLayerOpacity(2, 0.5)` mutates cache before REST resolves; if REST rejects, cache rolls back.

### Integration — `client.cache-fast.test.ts`
- New `*Fast` methods read from cache when fresh, fall through to REST when stale.

### Coverage
Target file `composition-store/*` ≥ 85% (above project floor).

---

## Failure modes

| Failure | Detection | Behavior |
|---|---|---|
| `EADDRINUSE` on bind | `socket.on("error")` during `bind` | Degrade to `SHARED` mode, log warning |
| Resolume not running at startup | REST seed times out | `hydrated=false`; reconnect loop retries every 5s |
| Network blip mid-show | No OSC packet for >2 s while previously live | `oscLive` flips false; per-field TTLs make stale reads degrade gracefully |
| Schema drift (Resolume update) | OSC address matches no reducer or REST returns unexpected JSON | Unknown reducer logs once, falls through; REST seed parses with Zod's `.passthrough()` |
| Clip count change without our knowing | First OSC ref to OOB clip | Triggers `scheduleRehydrate` (debounced) |
| Resolume restart | Sustained packet silence + new packets after gap | Background heartbeat (3 s no-packet) triggers REST seed re-check |
| Coexisting OSC tool already bound | EADDRINUSE on store start | SHARED mode |
| Process exit | `SIGINT`/`SIGTERM` | `store.stop()` closes socket, clears timers |
| Bad packet (malformed UDP) | `decodePacket` throws | Caught, ignored, counter incremented in `stats().malformed` |
| OSC tempo unit confusion | Field carries `bpmNormalized` separately from `bpm` raw | Type system enforces |

---

## Risks

1. **Optimistic write divergence.** If a write succeeds at REST but Resolume internally clamps the value, our cache holds wrong value until next OSC echo. Mitigation: only apply optimistic write *after* REST 2xx; rely on OSC echo as authoritative.
2. **Memory.** ~2 MB worst case for 16-layer × 64-clip grid — negligible. Reducers only bump revision when value actually changes.
3. **Test flakiness on real timers.** Fake timers cover most paths. Reuse `osc-client.test.ts` FakeSocket pattern.
4. **Resolume version drift.** Field shapes vary across 7.x minors. Zod schemas use `.passthrough()`.
5. **OSC blend mode encoding.** Resolume pushes index, not string. Cache option list during REST seed; expose resolved string when both available.
6. **Coexistence assumptions.** If a user starts another tool that binds OSC OUT first, store falls into SHARED mode automatically. Document this.
7. **Skill sync.** `check-skill-sync` will fail loudly if `resolume_cache_refresh`/`resolume_cache_status`/`resolume_get_clip_position` are missed in SKILL.md.

---

## Implementation phases

### Phase 1 — Types & reducers (no I/O)
- `src/resolume/composition-store/types.ts`
- `src/resolume/composition-store/reducers.ts` — pure functions
- `src/resolume/composition-store/ttl.ts`
- Tests: pure-fn coverage ≥90%.

### Phase 2 — Store class + lifecycle
- `src/resolume/composition-store/store.ts`
- Inject `SocketFactory` like `osc-client.ts`.
- Reconnect loop, debounce/throttle, optimistic-write API.

### Phase 3 — Config + bootstrap
- Extend `config.ts` with `cache: { mode }`.
- Wire `index.ts` to construct store conditionally and call `start()`.

### Phase 4 — `ResolumeClient` cache-fast methods
- Add optional `store` ctor param.
- Add `getTempoFast`, `getClipPositionFast`, `getCrossfaderFast`, `getLayerOpacityFast`.

### Phase 5 — Tool integrations
- New: `resolume_cache_refresh`, `resolume_cache_status`, `resolume_get_clip_position`.
- Update `resolume_osc_subscribe` to multiplex through the store.
- Update `ToolContext` with optional `store?: CompositionStore`.
- Update `SKILL.md`.

### Phase 6 — Documentation & live verification
- Update `CLAUDE.md` with cache section + `RESOLUME_CACHE` env doc.
- Manual live test against real Resolume.
- Update CHANGELOG.

---

## Executive summary

- **Push-driven cache, REST fallback.** `CompositionStore` consumes Resolume's ~325 msg/s OSC OUT broadcast for live state and reconciles via REST seeds + per-field TTLs; reads degrade gracefully when OSC is silent or Resolume isn't running.
- **Three modes for socket coexistence.** `OWNER` binds OSC OUT exclusively (and multiplexes the legacy `resolume_osc_subscribe` tool through itself), `SHARED` lets other tools feed the store via a `feed()` API, and `OFF` (default) reproduces v0.4 behavior bit-for-bit.
- **Additive, opt-in, non-breaking.** New `*Fast` methods on `ResolumeClient` sit alongside existing REST methods; `RESOLUME_CACHE=1` enables the cache; absent the flag the v0.4 code paths run unchanged.
- **Hybrid invalidation.** Per-field TTLs + structural-drift detection (unknown layer/clip indices trigger debounced re-seeds) + write-time optimistic updates with REST-confirm rollback give correctness without polling.
- **Testable without Resolume.** Reuses the proven `FakeSocket` + `fetchImpl` injection pattern; pure reducers carry most logic, integration tests cover lifecycle, EADDRINUSE degradation, drift, and optimistic writes — targeting ≥85% coverage on new code with no impact on existing tests.
