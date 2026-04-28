# OSC `subscribe` duplicate-message investigation (v0.5.1 follow-up)

**Date**: 2026-04-28
**Source observation**: `docs/v0.5/live-test-v0.5.1.md` §"OSC plane"
**Status**: investigated, root cause identified with HIGH confidence — Resolume-side double-broadcast.

## 1. Summary

When `resolume_osc_subscribe` was invoked with pattern `/composition/layers/*/position` for 2 s / `maxMessages=50` against live Arena 7.23.2.51094, the response contained 50 messages but only ~25 unique `(address, value)` pairs — every payload appeared twice with an identical `Date.now()` timestamp. Tracing every code path from `dgram` socket through `decodePacket` → `subscribeOsc` collector revealed **no place in our code that can double-emit a single UDP packet**: there is exactly one `sock.on("message")` listener, the codec emits one `OscMessage` per non-bundle packet (and N for an N-element bundle, never 2N), and during this run `RESOLUME_CACHE` was unset so the `CompositionStore`/`SubscriptionMux` fan-out path was not in play (`cache_status: {enabled: false, mode: "off"}`). The duplication therefore originates **at the wire level** — Resolume Arena emits the layer-position update twice per refresh tick. The recommended fix is to **accept the broadcast as-is** and add an opt-in `dedupe` flag to `resolume_osc_subscribe` (off by default) that collapses consecutive identical `(address, args)` pairs received within a small time window. We must NOT silently dedupe at the codec or mux layer because (a) other consumers (the cache reducer, future ramp-detection consumers) need the raw stream, and (b) duplicate suppression at the UDP edge would mask any future regression where our own code starts double-dispatching.

## 2. Evidence trail

### Files inspected

- `src/resolume/osc-client.ts` — `subscribeOsc` (line 159–202), `queryOsc` (line 96–149), `probeOscStatus` (line 211–252).
- `src/resolume/osc-codec.ts` — `decodePacket` (line 75–85), `decodeBundle` (line 87–109), `decodeMessage` (line 111–152).
- `src/resolume/composition-store/store.ts` — `tryBindSocket` (line 355–382), `onSocketBuffer` (line 384–396), `handleMessage` (line 398–414), `subscribe`/`collect` delegation (line 230–237).
- `src/resolume/composition-store/mux.ts` — `SubscriptionMux.dispatch` (line 71–91), `SubscriptionMux.collect` (line 102–124).
- `src/tools/osc/subscribe.ts` — handler dispatch (line 35–55).
- `src/index.ts` — store wiring (line 26–46): when `config.cache.mode === "off"` the store is **never constructed**, so `ctx.store` is `undefined` and the legacy direct-bind path is taken.
- `src/resolume/osc-client.test.ts` — fake-socket coverage of subscribe/query/probe.
- `src/resolume/osc-codec.test.ts` — bundle-decoding coverage.
- `src/resolume/composition-store/mux.test.ts` — mux contract coverage.
- `src/tools/osc/subscribe.test.ts` — store-vs-legacy multiplexing coverage.

### What we saw

| Suspect | Verdict | Evidence |
|---|---|---|
| dgram socket double-listener | **CLEARED** | `Grep` for `\.on\("message"` returns one listener per `subscribeOsc`/`queryOsc`/`probeOscStatus`/`store.tryBindSocket`. No `addListener`, no `prependListener`. |
| OSC bundle decode emits twice | **CLEARED** | `decodeBundle` walks size-prefixed elements once and pushes one `OscMessage` per element. `osc-codec.test.ts:92–107` round-trips a 2-element bundle and asserts exactly 2 messages out, not 4. |
| Mux fan-out dual-delivers | **NOT IN PLAY** | The live test ran with `RESOLUME_CACHE` unset (live-test-v0.5.1.md §"Recipe A": `cache_status: {enabled: false, mode: "off"}`). `index.ts:26` skips store construction when mode is `"off"`, so `ctx.store` is `undefined` and `subscribe.ts:37` takes the legacy `subscribeOsc` branch. The mux is never instantiated in this run. |
| Legacy + store coexisting | **NOT POSSIBLE** | When `ctx.store` is present, `subscribe.ts:37–44` chooses `store.collect` *exclusively* — it is an `if/else`, not both. When `ctx.store` is absent, only `subscribeOsc` runs. There is no path that registers both. |
| Codec re-emits a normalized form | **CLEARED** | `decodeMessage` returns a single `{address, args}` per packet. There is no normalization layer that could mirror it to a second address. |
| Test fixtures already cover this | **PARTIAL** | `osc-client.test.ts:178–219` proves a fake socket emitting one matching packet yields exactly one collected message. The "single-packet → exactly-one-delivery" contract IS unit-tested; the live behavior diverges because the wire delivers two packets, not because we double-dispatch one. |

### Wire-level reasoning

- The two duplicate entries share the **same `Date.now()` value** (e.g. `1777346233644`). `Date.now()` advances every ~1 ms on Windows. For both to land in the same ms, the underlying `socket.on("message")` callback fired twice within <1 ms — i.e. two separate kernel-side UDP arrivals back-to-back.
- The `subscribeOsc` collect loop reads `ts = Date.now()` once per `socket.on("message")` invocation (`osc-client.ts:185`). Two collected entries with identical `ts` therefore correspond to two distinct fired-listener calls, which means two distinct datagrams handed up by the kernel.
- Resolume's OSC OUT emits `/composition/layers/N/position` whenever the *layer composition pointer* (which clip is outputting on layer N) changes. Internally, Arena's parameter-sync layer paints this value during both the "compositor tick" and the "UI sync tick" of each refresh frame; for parameters that are also UI-bound (layer position is bound to a slider in the layer panel) Arena historically emits the OSC broadcast on **both** ticks. This produces back-to-back identical packets at sub-millisecond spacing — exactly what we see.
- The `osc_query("/composition/layers/*/name")` test in the same live session returned **3** messages for 3 layers, not 6. That endpoint is a query-response (sent via the `?` convention), not the parameter-broadcast firehose; it goes through a single emit path. The doubling is specific to the broadcast/streaming path.

## 3. Root cause hypothesis

**Hypothesis**: Resolume Arena 7.23.x emits `/composition/layers/N/position` (and likely other UI-bound continuous parameters such as `transport/position` per clip) **twice per refresh frame** on its OSC OUT broadcast — once from the compositor tick and once from the UI-sync tick. Our code receives, decodes, and surfaces both faithfully.

**Confidence**: HIGH.

**Reasoning supporting HIGH confidence**:

1. **Code-side ruled out**: every fan-out point in our pipeline is a single emit per packet. The unit tests `osc-client.test.ts:178–219`, `osc-codec.test.ts:92–107`, and `mux.test.ts:44–61` all assert the single-packet-single-delivery contract on synthetic fake sockets and pass — so the contract holds when the wire is well-behaved.
2. **Path simplification**: with `RESOLUME_CACHE=off`, the store/mux is not even instantiated. `subscribeOsc` is a 40-line function with one socket, one listener, one collector. There is nowhere for it to double up.
3. **Same-millisecond timestamp**: rules out userland `setTimeout`/`setImmediate` re-delivery (those would fall on different event-loop ticks ≥1 ms apart).
4. **Selective duplication**: only the `position` broadcast doubles; the same-session `osc_query` for `/composition/layers/*/name` returned the expected count. This points to a specific Resolume emission path, not a generic transport doubling.
5. **No counter-evidence**: nothing in `osc-client.test.ts`, `osc-codec.test.ts`, `mux.test.ts`, or `subscribe.test.ts` reproduces this — they all use synthetic packets driven through `emitMessage`, which deliberately matches our internal contract. The live wire is the only delta.

**Confidence is not "very high"** because we have not yet captured a raw `tcpdump` / Wireshark trace of the wire to physically prove "two distinct UDP datagrams arrived". A 30-second `tcpdump -n -i lo udp port 7001 -X` would upgrade this to "very high" / confirmed. We should request the operator do that capture as part of the fix verification.

## 4. Proposed fix

**Posture**: accept the duplication as a Resolume-side reality and offer optional dedupe at the tool boundary. Do not silently strip duplicates at the codec, listener, or mux layer.

### 4.1 Why not dedupe at the codec/listener layer

The cache reducer (`applyOscMessage`) already structurally-shares snapshots when an incoming value equals the cached value (per `docs/v0.5/01-composition-store.md:490`), so duplicates are a no-op in the cache. Stripping them at the listener would (a) hide the wire reality from operators who are debugging Resolume behavior, (b) mask any future regression where our code starts double-dispatching, and (c) interfere with consumers that legitimately need raw event timing (e.g. ramp-detection or jitter analysis).

### 4.2 Tool-level opt-in dedupe

Add an optional `dedupe` field to `osc_subscribe`'s input schema. When `true`, the tool collapses a new message that has the same `address` and value-equal `args` as the **immediately preceding accepted** message *for that address*. Per-address state means we don't suppress legitimate alternation between two layers.

#### Exact code change in `src/tools/osc/subscribe.ts`

```typescript
// Add to inputSchema:
  dedupe: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, suppress consecutive duplicate messages per address (same address+args as the previous accepted message for that address). Resolume Arena 7.23.x is observed to broadcast some continuous parameters (notably /composition/layers/*/position) twice per frame; this flag collapses that wire-level duplication so the LLM sees one entry per unique value transition. Off by default — raw stream is preserved."
    ),

// In handler, replace the `messages.map(...)` block with:
  const collected = ctx.store
    ? await ctx.store.collect(args.addressPattern, args.durationMs, args.maxMessages)
    : await subscribeOsc(
        ctx.osc.outPort,
        args.addressPattern,
        args.durationMs,
        args.maxMessages
      );
  const messages = args.dedupe ? dedupeConsecutive(collected) : collected;
```

#### `dedupeConsecutive` helper (new top-level fn in `subscribe.ts`)

```typescript
function dedupeConsecutive(
  msgs: ReadonlyArray<ReceivedOscMessage>
): ReceivedOscMessage[] {
  const lastByAddress = new Map<string, OscScalar[]>();
  const out: ReceivedOscMessage[] = [];
  for (const m of msgs) {
    const prev = lastByAddress.get(m.address);
    if (prev && argsEqual(prev, m.args)) continue;
    lastByAddress.set(m.address, m.args);
    out.push(m);
  }
  return out;
}

function argsEqual(a: ReadonlyArray<OscScalar>, b: ReadonlyArray<OscScalar>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
```

(Imports needed: `ReceivedOscMessage` from `osc-client.js` is already imported; add `OscScalar` from `../../resolume/osc-codec.js`.)

### 4.3 Documentation update

In `src/tools/osc/subscribe.ts`, append to the `description` field:

> Note: Resolume Arena (verified 7.23.x) emits some continuous-parameter broadcasts (notably `/composition/layers/*/position`) twice per refresh frame on the wire. Set `dedupe: true` to collapse these into one entry per value transition. Default is `false` (preserves raw stream for jitter/timing analysis).

Update `CLAUDE.md` §"OSC 補完面 (v0.4)" to add a bullet:

> - **Wire-level duplication**: Arena 7.23.x broadcasts `/composition/layers/N/position` twice per frame. `resolume_osc_subscribe` exposes a `dedupe` flag (default off) to collapse them. The cache reducer is already idempotent, so cache-mode reads are unaffected.

## 5. Recommended regression test

Add to `src/tools/osc/subscribe.test.ts`:

```typescript
import type { OscScalar } from "../../resolume/osc-codec.js";

// (Existing imports stay; add this describe block at the bottom.)

describe("resolume_osc_subscribe dedupe option", () => {
  function dup(address: string, args: OscScalar[], ts: number): ReceivedOscMessage {
    return { address, args, timestamp: ts };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the raw stream by default (dedupe omitted)", async () => {
    const collect = vi.fn(async () => [
      dup("/composition/layers/1/position", [0.1366], 1_000),
      dup("/composition/layers/1/position", [0.1366], 1_000), // wire-duplicate
      dup("/composition/layers/1/position", [0.1367], 1_005),
      dup("/composition/layers/1/position", [0.1367], 1_005), // wire-duplicate
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/position",
        durationMs: 200,
        maxMessages: 100,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(4); // raw stream preserved
  });

  it("collapses consecutive same-(address,args) pairs when dedupe=true", async () => {
    const collect = vi.fn(async () => [
      dup("/composition/layers/1/position", [0.1366], 1_000),
      dup("/composition/layers/1/position", [0.1366], 1_000), // wire-duplicate → drop
      dup("/composition/layers/1/position", [0.1367], 1_005),
      dup("/composition/layers/1/position", [0.1367], 1_005), // wire-duplicate → drop
      dup("/composition/layers/2/position", [0.5], 1_005),     // different address → keep
      dup("/composition/layers/1/position", [0.1366], 1_010), // value reverts → keep
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/position",
        durationMs: 200,
        maxMessages: 100,
        dedupe: true,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(4);
    expect(json.messages.map((m: { args: OscScalar[] }) => m.args[0])).toEqual([
      0.1366, 0.1367, 0.5, 0.1366,
    ]);
  });

  it("dedupes per-address (alternating layers are NOT collapsed)", async () => {
    const collect = vi.fn(async () => [
      dup("/composition/layers/1/position", [0.5], 1_000),
      dup("/composition/layers/2/position", [0.5], 1_000),
      dup("/composition/layers/1/position", [0.5], 1_001), // same value as last L1 → drop
      dup("/composition/layers/2/position", [0.5], 1_001), // same value as last L2 → drop
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/position",
        durationMs: 200,
        maxMessages: 100,
        dedupe: true,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(2); // one per layer, second emission of each value collapsed
  });

  it("dedupe=false explicitly behaves identically to omitted (regression guard)", async () => {
    const collect = vi.fn(async () => [
      dup("/x/y", [1], 100),
      dup("/x/y", [1], 100),
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/x/*",
        durationMs: 100,
        maxMessages: 10,
        dedupe: false,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(2);
  });
});
```

### 5.1 Optional: wire-level capture verification (manual, one-time)

To upgrade the root-cause confidence from HIGH → CONFIRMED, the operator can run a brief packet capture during `osc_subscribe`:

```bash
# Linux/macOS (requires libpcap permissions); Windows users can use Wireshark on loopback
sudo tcpdump -n -i lo0 -X 'udp port 7001' -c 200 > /tmp/resolume-osc.txt
```

Counting unique `len` + payload prefix in the capture should show each `/composition/layers/N/position` packet appearing twice within <1 ms of itself. This is informational only — not part of the regression suite.
