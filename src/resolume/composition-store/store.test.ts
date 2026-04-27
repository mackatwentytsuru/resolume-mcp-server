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
