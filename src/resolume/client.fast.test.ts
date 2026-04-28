/**
 * Tests for the v0.5.1 cache-fast read methods on `ResolumeClient`.
 *
 * The store is mocked at the public-method boundary — these tests verify the
 * cache-vs-REST decision logic in `getTempoFast` / `getClipPositionFast` /
 * `getCrossfaderFast` / `getLayerOpacityFast`, NOT the store internals (those
 * are exercised by `composition-store/store.test.ts`).
 *
 * The matrix per method covers four cases:
 *   - cache hit          → REST is NOT called, cached value returned
 *   - cache miss (stale) → REST IS called, REST value returned
 *   - cache disabled     → REST is called directly, no store consulted
 *   - cache fresh w/null → REST IS called (we never return cached null when
 *                          REST might give us a usable value)
 */

import { describe, expect, it, vi } from "vitest";
import { ResolumeClient } from "./client.js";
import { ResolumeRestClient } from "./rest.js";
import type { CompositionStore } from "./composition-store/store.js";
import type {
  CachedClip,
  CachedLayer,
  CachedScalar,
  CachedTempo,
} from "./composition-store/types.js";

// ───────────────────────── helpers ─────────────────────────

function oscScalar<T>(value: T, ms = 1700000000000): CachedScalar<T> {
  return { value, source: { kind: "osc", receivedAt: ms } };
}

function restScalar<T>(value: T, ms = 1700000000000): CachedScalar<T> {
  return { value, source: { kind: "rest", fetchedAt: ms } };
}

function unknownScalar<T>(value: T): CachedScalar<T> {
  return { value, source: { kind: "unknown" } };
}

function makeFakeRest(handler: (path: string) => unknown): {
  rest: ResolumeRestClient;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  const fetchSpy = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    const path = u.replace(/^https?:\/\/[^/]+\/api\/v1/, "");
    return new Response(JSON.stringify(handler(path)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const rest = new ResolumeRestClient({
    baseUrl: "http://127.0.0.1:8080",
    timeoutMs: 1000,
    fetchImpl: fetchSpy as unknown as typeof fetch,
  });
  return { rest, fetchSpy };
}

interface FakeStoreOpts {
  tempo?: Partial<CachedTempo>;
  crossfader?: CachedScalar<number | null>;
  clipPosition?: { value: number | null; ageMs: number | null };
  layer?: CachedLayer | null;
  isFreshMap?: Partial<Record<string, boolean>>;
}

/**
 * Build a minimal CompositionStore stub. Only the methods used by `*Fast`
 * paths are populated — accessing anything else surfaces as `undefined` so
 * test failures are loud.
 */
function makeFakeStore(opts: FakeStoreOpts): CompositionStore {
  const tempoBase: CachedTempo = {
    bpm: unknownScalar<number | null>(null),
    bpmNormalized: unknownScalar<number | null>(null),
    min: unknownScalar<number | null>(null),
    max: unknownScalar<number | null>(null),
    ...opts.tempo,
  };
  const cf = opts.crossfader ?? unknownScalar<number | null>(null);
  return {
    readTempo: vi.fn(() => tempoBase),
    readCrossfader: vi.fn(() => cf),
    readClipPosition: vi.fn(() =>
      opts.clipPosition
        ? {
            value: opts.clipPosition.value,
            ageMs: opts.clipPosition.ageMs,
            source: { kind: "osc" as const, receivedAt: 1700000000000 },
          }
        : { value: null, ageMs: null, source: { kind: "unknown" as const } }
    ),
    readLayer: vi.fn(() => opts.layer ?? null),
    isFresh: vi.fn((field: string) => opts.isFreshMap?.[field] ?? false),
    isHydrated: vi.fn(() => true),
    isOscLive: vi.fn(() => true),
  } as unknown as CompositionStore;
}

// ───────────────────────── getTempoFast ─────────────────────────

describe("ResolumeClient.getTempoFast", () => {
  it("returns cached tempo when fresh — REST is NOT called", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({}));
    const store = makeFakeStore({
      tempo: {
        bpm: oscScalar<number | null>(140),
        min: restScalar<number | null>(60),
        max: restScalar<number | null>(240),
      },
      isFreshMap: { bpm: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const t = await client.getTempoFast();
    expect(t).toEqual({ bpm: 140, min: 60, max: 240 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to REST when cached bpm is stale", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      tempocontroller: { tempo: { value: 132, min: 20, max: 500 } },
    }));
    const store = makeFakeStore({
      tempo: { bpm: oscScalar<number | null>(140) },
      isFreshMap: { bpm: false }, // stale
    });
    const client = new ResolumeClient(rest, {}, store);

    const t = await client.getTempoFast();
    expect(t.bpm).toBe(132);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls through to REST when store is null", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      tempocontroller: { tempo: { value: 130 } },
    }));
    const client = new ResolumeClient(rest, {}, null);

    const t = await client.getTempoFast();
    expect(t.bpm).toBe(130);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls through to REST when bpm is fresh but value is null", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      tempocontroller: { tempo: { value: 100 } },
    }));
    const store = makeFakeStore({
      tempo: { bpm: oscScalar<number | null>(null) }, // fresh-but-null
      isFreshMap: { bpm: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const t = await client.getTempoFast();
    expect(t.bpm).toBe(100);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── getClipPositionFast ─────────────────────────

describe("ResolumeClient.getClipPositionFast", () => {
  it("returns cached position when ageMs < 500 — REST is NOT called", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({}));
    const store = makeFakeStore({
      clipPosition: { value: 0.42, ageMs: 50 },
    });
    const client = new ResolumeClient(rest, {}, store);

    const value = await client.getClipPositionFast(2, 3);
    expect(value).toBe(0.42);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to REST when ageMs >= 500", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      transport: { position: { value: 0.75 } },
    }));
    const store = makeFakeStore({
      clipPosition: { value: 0.42, ageMs: 600 }, // stale
    });
    const client = new ResolumeClient(rest, {}, store);

    const value = await client.getClipPositionFast(2, 3);
    expect(value).toBe(0.75);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]?.toString()).toContain(
      "/composition/layers/2/clips/3"
    );
  });

  it("falls through to REST when store is null", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      transport: { position: { value: 0.1 } },
    }));
    const client = new ResolumeClient(rest, {}, null);

    const value = await client.getClipPositionFast(1, 1);
    expect(value).toBe(0.1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls through to REST when cache value is null even if fresh", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      transport: { position: { value: 0.25 } },
    }));
    const store = makeFakeStore({
      clipPosition: { value: null, ageMs: 50 },
    });
    const client = new ResolumeClient(rest, {}, store);

    const value = await client.getClipPositionFast(1, 1);
    expect(value).toBe(0.25);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when REST has no position field", async () => {
    const { rest } = makeFakeRest(() => ({ transport: { position: {} } }));
    const client = new ResolumeClient(rest, {}, null);

    const value = await client.getClipPositionFast(1, 1);
    expect(value).toBeNull();
  });
});

// ───────────────────────── getClipPositionFastTagged ─────────────────────────

describe("ResolumeClient.getClipPositionFastTagged", () => {
  it("reports source=cache on cache hit", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({}));
    const store = makeFakeStore({
      clipPosition: { value: 0.5, ageMs: 100 },
    });
    const client = new ResolumeClient(rest, {}, store);

    const result = await client.getClipPositionFastTagged(2, 3);
    expect(result).toEqual({ value: 0.5, source: "cache", ageMs: 100 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports source=rest on cache miss", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      transport: { position: { value: 0.9 } },
    }));
    const store = makeFakeStore({
      clipPosition: { value: 0.42, ageMs: 700 }, // stale
    });
    const client = new ResolumeClient(rest, {}, store);

    const result = await client.getClipPositionFastTagged(2, 3);
    expect(result).toEqual({ value: 0.9, source: "rest" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reports source=rest when store is null", async () => {
    const { rest } = makeFakeRest(() => ({
      transport: { position: { value: 0.3 } },
    }));
    const client = new ResolumeClient(rest, {}, null);

    const result = await client.getClipPositionFastTagged(1, 1);
    expect(result).toEqual({ value: 0.3, source: "rest" });
  });
});

// ───────────────────────── getCrossfaderFast ─────────────────────────

describe("ResolumeClient.getCrossfaderFast", () => {
  it("returns cached phase when fresh", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({}));
    const store = makeFakeStore({
      crossfader: oscScalar<number | null>(0.25),
      isFreshMap: { crossfaderPhase: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const phase = await client.getCrossfaderFast();
    expect(phase).toBe(0.25);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to REST when stale", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      crossfader: { phase: { value: -0.5 } },
    }));
    const store = makeFakeStore({
      crossfader: oscScalar<number | null>(0.25),
      isFreshMap: { crossfaderPhase: false },
    });
    const client = new ResolumeClient(rest, {}, store);

    const phase = await client.getCrossfaderFast();
    expect(phase).toBe(-0.5);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls through to REST when store is null", async () => {
    const { rest } = makeFakeRest(() => ({
      crossfader: { phase: { value: 0 } },
    }));
    const client = new ResolumeClient(rest, {}, null);

    const phase = await client.getCrossfaderFast();
    expect(phase).toBe(0);
  });

  it("falls through to REST when fresh but value is null", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      crossfader: { phase: { value: 0.7 } },
    }));
    const store = makeFakeStore({
      crossfader: oscScalar<number | null>(null), // fresh-but-null
      isFreshMap: { crossfaderPhase: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const phase = await client.getCrossfaderFast();
    expect(phase).toBe(0.7);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── getLayerOpacityFast ─────────────────────────

function makeLayer(opacity: CachedScalar<number>): CachedLayer {
  return {
    layerIndex: 1,
    name: unknownScalar<string | null>(null),
    opacity,
    bypassed: unknownScalar(false),
    solo: unknownScalar(false),
    position: unknownScalar<number | null>(null),
    blendMode: unknownScalar<string | null>(null),
    clips: [] as ReadonlyArray<CachedClip>,
  };
}

describe("ResolumeClient.getLayerOpacityFast", () => {
  it("returns cached opacity when fresh and source is non-unknown", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({}));
    const store = makeFakeStore({
      layer: makeLayer(restScalar<number>(0.6)),
      isFreshMap: { opacity: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const opacity = await client.getLayerOpacityFast(1);
    expect(opacity).toBe(0.6);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to REST when layer is missing in cache", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      video: { opacity: { value: 0.3 } },
    }));
    const store = makeFakeStore({
      layer: null, // not in snapshot
      isFreshMap: { opacity: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const opacity = await client.getLayerOpacityFast(7);
    expect(opacity).toBe(0.3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]?.toString()).toContain(
      "/composition/layers/7"
    );
  });

  it("falls through to REST when store is null", async () => {
    const { rest } = makeFakeRest(() => ({
      video: { opacity: { value: 0.5 } },
    }));
    const client = new ResolumeClient(rest, {}, null);

    const opacity = await client.getLayerOpacityFast(2);
    expect(opacity).toBe(0.5);
  });

  it("falls through to REST when cached source is unknown", async () => {
    const { rest, fetchSpy } = makeFakeRest(() => ({
      video: { opacity: { value: 0.9 } },
    }));
    const store = makeFakeStore({
      layer: makeLayer(unknownScalar(1)), // never seeded
      isFreshMap: { opacity: true },
    });
    const client = new ResolumeClient(rest, {}, store);

    const opacity = await client.getLayerOpacityFast(1);
    expect(opacity).toBe(0.9);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null when REST has no opacity field", async () => {
    const { rest } = makeFakeRest(() => ({ video: {} }));
    const client = new ResolumeClient(rest, {}, null);

    const opacity = await client.getLayerOpacityFast(1);
    expect(opacity).toBeNull();
  });
});
