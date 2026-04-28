import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { encodeMessage } from "../osc-codec.js";
import type { UdpSocketLike } from "../osc-client.js";
import { ResolumeRestClient } from "../rest.js";
import { CompositionStore } from "./store.js";
import type { CompositionStoreOptions } from "./types.js";

interface FakeSocket extends UdpSocketLike {
  bound: number | null;
  closed: boolean;
  emitMessage(buf: Buffer): void;
  emitError(err: Error): void;
}

function createFakeSocket(): FakeSocket {
  const handlers: {
    message: Array<(buf: Buffer) => void>;
    error: Array<(err: Error) => void>;
    listening: Array<() => void>;
  } = { message: [], error: [], listening: [] };
  const sock: FakeSocket = {
    bound: null,
    closed: false,
    on(event: string, listener: any) {
      if (event === "message") handlers.message.push(listener);
      else if (event === "error") handlers.error.push(listener);
      else if (event === "listening") handlers.listening.push(listener);
    },
    bind(port: number) {
      this.bound = port;
      setImmediate(() => handlers.listening.forEach((fn) => fn()));
    },
    send(_msg, _port, _host, cb) {
      setImmediate(() => cb(null));
    },
    close(cb) {
      this.closed = true;
      cb?.();
    },
    emitMessage(buf) {
      handlers.message.forEach((fn) => fn(buf));
    },
    emitError(err) {
      handlers.error.forEach((fn) => fn(err));
    },
  };
  return sock;
}

const SEED_FIXTURE = {
  layers: [
    {
      name: { value: "Layer 1" },
      bypassed: { value: false },
      solo: { value: false },
      video: { opacity: { value: 0.8 }, mixer: { "Blend Mode": { value: "Add" } } },
      clips: [
        { name: { value: "c1" }, connected: { value: true }, transport: { position: { value: 0 } } },
        { name: { value: "c2" }, connected: { value: false }, transport: { position: { value: 0 } } },
      ],
    },
  ],
  columns: [{ name: { value: "Col1" } }],
  decks: [{ name: { value: "DeckA" }, selected: { value: true } }],
  tempocontroller: { tempo: { value: 128, min: 60, max: 240 } },
  crossfader: { phase: { value: 0 } },
  clipbeatsnap: { value: "1 Bar", options: ["1/4", "1 Bar"] },
};

function makeRest(handler: (path: string) => Promise<unknown>): ResolumeRestClient {
  const fakeFetch = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const path = u.replace(/^https?:\/\/[^/]+\/api\/v1/, "");
    const body = await handler(path);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return new ResolumeRestClient({
    baseUrl: "http://127.0.0.1:8080",
    timeoutMs: 1_000,
    fetchImpl: fakeFetch,
  });
}

function makeOptions(overrides?: Partial<CompositionStoreOptions>): CompositionStoreOptions {
  return {
    oscHost: "127.0.0.1",
    oscOutPort: 7001,
    mode: "owner",
    hydrationTimeoutMs: 100,
    rehydrateThrottleMs: 50,
    reconnectIntervalMs: 100,
    ...overrides,
  };
}

describe("CompositionStore — happy path lifecycle", () => {
  it("hydrates from REST and processes a tempo packet", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    expect(store.isHydrated()).toBe(true);
    expect(store.readSnapshot().layerCount).toBe(1);
    expect(store.readTempo().bpm.value).toBe(128);
    expect(store.__testInternals().socketBound).toBe(true);
    expect(store.__testInternals().effectiveMode).toBe("owner");

    // Emit a tempo OSC packet.
    sock.emitMessage(encodeMessage("/composition/tempocontroller/tempo", [0.5]));
    expect(store.isOscLive()).toBe(true);
    expect(store.readTempo().bpmNormalized.value).toBe(0.5);

    await store.stop();
    expect(sock.closed).toBe(true);
  });
});

describe("CompositionStore — REST failure & reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries the REST seed until it succeeds", async () => {
    let attempts = 0;
    const rest = makeRest(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("ECONNREFUSED");
      return SEED_FIXTURE;
    });
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions({ hydrationTimeoutMs: 50, reconnectIntervalMs: 100 }),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    expect(store.isHydrated()).toBe(false); // first attempt failed
    expect(store.__testInternals().hasReconnectTimer).toBe(true);

    // Drive reconnect attempts; each retry calls rest -> attempts increments.
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(150);
    // After two retries it should be hydrated.
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(store.isHydrated()).toBe(true);
    expect(store.__testInternals().hasReconnectTimer).toBe(false);

    await store.stop();
  });
});

describe("CompositionStore — EADDRINUSE degrades to SHARED", () => {
  it("emits stderr warning and effectiveMode flips to shared on bind error", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    // Override bind to emit EADDRINUSE asynchronously.
    const origBind = sock.bind.bind(sock);
    sock.bind = (port: number) => {
      origBind(port);
      const err = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
      setImmediate(() => sock.emitError(err));
    };
    const stderrLines: string[] = [];
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: (s) => stderrLines.push(s) },
    });
    await store.start();
    // Wait one extra tick for the async error to propagate.
    await new Promise((r) => setImmediate(r));
    expect(store.__testInternals().effectiveMode).toBe("shared");
    expect(store.__testInternals().socketBound).toBe(false);
    expect(stderrLines.some((l) => /EADDRINUSE|already bound|degrading to SHARED/i.test(l))).toBe(true);
    await store.stop();
  });
});

describe("CompositionStore — stop() is idempotent", () => {
  it("can be called twice without throwing", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    await store.stop();
    expect(sock.closed).toBe(true);
    await expect(store.stop()).resolves.toBeUndefined();
  });

  it("clears reconnect and rehydrate timers on stop", async () => {
    const rest = makeRest(async () => {
      throw new Error("network down");
    });
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions({ hydrationTimeoutMs: 30 }),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    expect(store.__testInternals().hasReconnectTimer).toBe(true);
    await store.stop();
    expect(store.__testInternals().hasReconnectTimer).toBe(false);
  });
});

describe("CompositionStore — feed (SHARED mode)", () => {
  it("processes externally-pushed messages and updates oscLive", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const store = new CompositionStore({
      options: makeOptions({ mode: "shared" }),
      rest,
      socketFactory: () => {
        throw new Error("should not be called in shared mode");
      },
      stderr: { write: () => {} },
    });
    await store.start();
    expect(store.__testInternals().socketBound).toBe(false);
    store.feed({
      address: "/composition/layers/1/video/opacity",
      args: [0.42],
      timestamp: Date.now(),
    });
    expect(store.isOscLive()).toBe(true);
    expect(store.readLayer(1)!.opacity.value).toBe(0.42);
    await store.stop();
  });
});

describe("CompositionStore — mode 'off' is a no-op", () => {
  it("does not bind socket or run seed", async () => {
    const fetchImpl = vi.fn();
    const rest = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const store = new CompositionStore({
      options: makeOptions({ mode: "off" }),
      rest,
      socketFactory: () => {
        throw new Error("nope");
      },
      stderr: { write: () => {} },
    });
    await store.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.isHydrated()).toBe(false);
  });
});

describe("CompositionStore — subscribe / collect via mux", () => {
  it("delivers messages to subscribers as they arrive", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    const handler = vi.fn();
    store.subscribe("/composition/layers/*/video/opacity", handler);
    sock.emitMessage(encodeMessage("/composition/layers/1/video/opacity", [0.5]));
    sock.emitMessage(encodeMessage("/composition/layers/2/video/opacity", [0.7]));
    sock.emitMessage(encodeMessage("/composition/decks/1/select", [true]));
    expect(handler).toHaveBeenCalledTimes(2);
    await store.stop();
  });
});

describe("CompositionStore — stats()", () => {
  it("counts messages received and reports mode", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    sock.emitMessage(encodeMessage("/composition/tempocontroller/tempo", [0.5]));
    sock.emitMessage(encodeMessage("/composition/crossfader/phase", [0.1]));
    const s = store.stats();
    expect(s.msgsReceived).toBe(2);
    expect(s.mode).toBe("owner");
    expect(s.hydrated).toBe(true);
    expect(s.oscLive).toBe(true);
    expect(typeof s.lastSeedAt).toBe("number");
    await store.stop();
  });
});

describe("CompositionStore — non-EADDRINUSE socket errors", () => {
  it("logs the error to stderr but stays in OWNER mode", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const stderrLines: string[] = [];
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: (s) => stderrLines.push(s) },
    });
    await store.start();
    sock.emitError(new Error("ECONNRESET"));
    await new Promise((r) => setImmediate(r));
    expect(store.__testInternals().effectiveMode).toBe("owner");
    expect(stderrLines.some((l) => /socket error/i.test(l))).toBe(true);
    await store.stop();
  });
});

describe("CompositionStore — socket factory throws", () => {
  it("logs the failure and stays unbound", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const stderrLines: string[] = [];
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => {
        throw new Error("EPERM");
      },
      stderr: { write: (s) => stderrLines.push(s) },
    });
    await store.start();
    expect(store.__testInternals().socketBound).toBe(false);
    expect(stderrLines.some((l) => /socket create failed/i.test(l))).toBe(true);
    await store.stop();
  });
});

describe("CompositionStore — invalidate after stop is a no-op", () => {
  it("does not schedule timers when stopped", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    await store.stop();
    store.invalidate();
    expect(store.__testInternals().hasRehydrateTimer).toBe(false);
  });
});

describe("CompositionStore — malformed packet drop", () => {
  it("ignores non-OSC bytes silently", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    // Garbage bytes — decodePacket returns []. Should not throw.
    sock.emitMessage(Buffer.from([0xff, 0xff]));
    expect(store.stats().msgsReceived).toBe(0);
    await store.stop();
  });
});

describe("CompositionStore — read methods", () => {
  async function ready() {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    return { rest, sock, store };
  }

  it("readLayer returns null for unknown layer", async () => {
    const { store } = await ready();
    expect(store.readLayer(99)).toBeNull();
    expect(store.readLayer(0)).toBeNull();
    expect(store.readLayer(1)).not.toBeNull();
    expect(store.readLayer(1)!.layerIndex).toBe(1);
    await store.stop();
  });

  it("readClip returns null for unknown layer or clip", async () => {
    const { store } = await ready();
    expect(store.readClip(99, 1)).toBeNull();
    expect(store.readClip(1, 99)).toBeNull();
    expect(store.readClip(1, 0)).toBeNull();
    expect(store.readClip(1, 1)).not.toBeNull();
    await store.stop();
  });

  it("readCrossfader returns the cached scalar", async () => {
    const { store } = await ready();
    const cf = store.readCrossfader();
    expect(cf.value).toBe(0);
    expect(cf.source.kind).toBe("rest");
    await store.stop();
  });

  it("readClipPosition exposes age and source", async () => {
    const { store, sock } = await ready();
    sock.emitMessage(encodeMessage("/composition/layers/1/clips/1/transport/position", [0.42]));
    const pos = store.readClipPosition(1, 1);
    expect(pos.value).not.toBeNull();
    expect(pos.value!).toBeCloseTo(0.42, 4);
    expect(pos.source.kind).toBe("osc");
    expect(typeof pos.ageMs).toBe("number");
    expect(pos.ageMs).toBeGreaterThanOrEqual(0);
    await store.stop();
  });

  it("readClipPosition returns null/null for unknown clip", async () => {
    const { store } = await ready();
    const pos = store.readClipPosition(99, 1);
    expect(pos.value).toBeNull();
    expect(pos.ageMs).toBeNull();
    expect(pos.source.kind).toBe("unknown");
    await store.stop();
  });
});

describe("CompositionStore — freshness gates", () => {
  async function ready() {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    return { sock, store };
  }

  it("isFresh respects override age in ms", async () => {
    const { store } = await ready();
    expect(store.isFresh("transportPosition", 100)).toBe(true);
    expect(store.isFresh("transportPosition", 1_000)).toBe(false);
    expect(store.isFresh("opacity", 4_999)).toBe(true);
    expect(store.isFresh("bpm", 1_999)).toBe(true);
    expect(store.isFresh("structural", 29_999)).toBe(true);
    await store.stop();
  });

  it("isFresh without override falls back to lastOscAt", async () => {
    const { store, sock } = await ready();
    expect(store.isFresh("bpm")).toBe(false); // no OSC yet
    sock.emitMessage(encodeMessage("/composition/tempocontroller/tempo", [0.5]));
    expect(store.isFresh("bpm")).toBe(true);
    await store.stop();
  });

  it("isHydrated and isOscLive flip independently", async () => {
    const { store, sock } = await ready();
    expect(store.isHydrated()).toBe(true);
    expect(store.isOscLive()).toBe(false);
    sock.emitMessage(encodeMessage("/composition/tempocontroller/tempo", [0.5]));
    expect(store.isOscLive()).toBe(true);
    await store.stop();
  });

  it("respects custom TTL overrides via options.ttls", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions({
        ttls: {
          transportPositionMs: 100,
          layerScalarsMs: 1_000,
          compositionScalarsMs: 500,
          structuralMs: 10_000,
        },
      }),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    expect(store.isFresh("transportPosition", 100)).toBe(true);
    expect(store.isFresh("transportPosition", 101)).toBe(false);
    expect(store.isFresh("opacity", 1_000)).toBe(true);
    expect(store.isFresh("bpm", 500)).toBe(true);
    expect(store.isFresh("structural", 10_000)).toBe(true);
    await store.stop();
  });
});

describe("CompositionStore — drift detection (debounced re-seed)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-seeds once after debounce when an OOB layer index is observed", async () => {
    let seedCalls = 0;
    const rest = makeRest(async () => {
      seedCalls += 1;
      return SEED_FIXTURE;
    });
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions({ rehydrateThrottleMs: 50, hydrationTimeoutMs: 30 }),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    expect(seedCalls).toBe(1); // initial seed
    // SEED_FIXTURE has layerCount=1; reference layer 9 to trigger drift.
    sock.emitMessage(encodeMessage("/composition/layers/9/video/opacity", [0.5]));
    expect(store.stats().rehydrationsTriggered).toBe(1);
    // Multiple drift packets within debounce window — still only one refetch.
    sock.emitMessage(encodeMessage("/composition/layers/9/bypassed", [true]));
    sock.emitMessage(encodeMessage("/composition/layers/8/solo", [true]));
    expect(store.stats().rehydrationsTriggered).toBe(1);
    // Advance past debounce.
    await vi.advanceTimersByTimeAsync(60);
    expect(seedCalls).toBe(2);
    await store.stop();
  });

  it("re-seeds for unknown OSC addresses (forward-compat with new Resolume features)", async () => {
    let seedCalls = 0;
    const rest = makeRest(async () => {
      seedCalls += 1;
      return SEED_FIXTURE;
    });
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions({ rehydrateThrottleMs: 30, hydrationTimeoutMs: 30 }),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    expect(seedCalls).toBe(1);
    sock.emitMessage(encodeMessage("/composition/something/totally-new", [1]));
    expect(store.stats().rehydrationsTriggered).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(seedCalls).toBe(2);
    await store.stop();
  });
});

describe("CompositionStore — refresh() and invalidate()", () => {
  it("refresh() runs REST seed and bumps revision", async () => {
    let seedCalls = 0;
    const rest = makeRest(async () => {
      seedCalls += 1;
      return SEED_FIXTURE;
    });
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    const initialRev = store.readSnapshot().revision;
    expect(seedCalls).toBe(1);
    const r = await store.refresh();
    expect(seedCalls).toBe(2);
    expect(r.revision).toBeGreaterThan(initialRev);
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    await store.stop();
  });

  it("invalidate() schedules a debounced re-seed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let seedCalls = 0;
      const rest = makeRest(async () => {
        seedCalls += 1;
        return SEED_FIXTURE;
      });
      const sock = createFakeSocket();
      const store = new CompositionStore({
        options: makeOptions({ rehydrateThrottleMs: 30 }),
        rest,
        socketFactory: () => sock,
        stderr: { write: () => {} },
      });
      await store.start();
      expect(seedCalls).toBe(1);
      store.invalidate();
      expect(store.stats().rehydrationsTriggered).toBe(1);
      // Coalesces additional invalidate calls within debounce window.
      store.invalidate();
      store.invalidate();
      expect(store.stats().rehydrationsTriggered).toBe(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(seedCalls).toBe(2);
      await store.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CompositionStore — onChange reactivity", () => {
  it("fires on snapshot replacement, not on no-op writes", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    const listener = vi.fn();
    const unsub = store.onChange(listener);
    // listener fires once when opacity changes from seeded 0.8 → 0.5.
    sock.emitMessage(encodeMessage("/composition/layers/1/video/opacity", [0.5]));
    const after1 = listener.mock.calls.length;
    expect(after1).toBeGreaterThanOrEqual(1);
    // Identical opacity → no-op, revision unchanged, no listener call.
    sock.emitMessage(encodeMessage("/composition/layers/1/video/opacity", [0.5]));
    expect(listener).toHaveBeenCalledTimes(after1);
    unsub();
    sock.emitMessage(encodeMessage("/composition/layers/1/video/opacity", [0.7]));
    expect(listener).toHaveBeenCalledTimes(after1);
    await store.stop();
  });

  it("isolates listener errors", async () => {
    const rest = makeRest(async () => SEED_FIXTURE);
    const sock = createFakeSocket();
    const store = new CompositionStore({
      options: makeOptions(),
      rest,
      socketFactory: () => sock,
      stderr: { write: () => {} },
    });
    await store.start();
    const ok = vi.fn();
    store.onChange(() => {
      throw new Error("boom");
    });
    store.onChange(ok);
    sock.emitMessage(encodeMessage("/composition/tempocontroller/tempo", [0.5]));
    expect(ok).toHaveBeenCalled();
    await store.stop();
  });
});
