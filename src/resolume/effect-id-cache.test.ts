import { describe, it, expect, vi } from "vitest";
import {
  EffectIdCache,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
} from "./effect-id-cache.js";

/**
 * Test helper: a controllable clock. Beats `vi.useFakeTimers` for this
 * cache because the cache injects `now()` directly, so tests need only a
 * `setTime(t)` knob — no global timer interception.
 */
function makeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    setTime(ms: number) {
      t = ms;
    },
  };
}

describe("EffectIdCache constants", () => {
  it("exports the spec'd defaults so tests can override safely", () => {
    expect(DEFAULT_TTL_MS).toBe(300_000); // 5 minutes
    expect(DEFAULT_MAX_ENTRIES).toBe(1000);
  });
});

describe("EffectIdCache.lookup", () => {
  it("calls fetcher on miss and caches the result", async () => {
    const clock = makeClock();
    const cache = new EffectIdCache({ now: clock.now });
    const fetcher = vi.fn(async () => 42);

    expect(await cache.lookup(1, 1, fetcher)).toBe(42);
    // Second call hits the cache and skips the fetcher.
    expect(await cache.lookup(1, 1, fetcher)).toBe(42);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expiry", async () => {
    const clock = makeClock();
    const cache = new EffectIdCache({ ttlMs: 300_000, now: clock.now });
    let next = 100;
    const fetcher = vi.fn(async () => next);

    expect(await cache.lookup(2, 3, fetcher)).toBe(100);
    next = 200;
    // Just before TTL: still cached.
    clock.advance(299_999);
    expect(await cache.lookup(2, 3, fetcher)).toBe(100);
    // Cross the TTL boundary: refetch.
    clock.advance(2);
    expect(await cache.lookup(2, 3, fetcher)).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("EffectIdCache.invalidateLayer", () => {
  it("clears entries on the target layer only", async () => {
    const cache = new EffectIdCache();
    const f21 = vi.fn(async () => 21);
    const f22 = vi.fn(async () => 22);
    const f31 = vi.fn(async () => 31);

    await cache.lookup(2, 1, f21);
    await cache.lookup(2, 2, f22);
    await cache.lookup(3, 1, f31);

    cache.invalidateLayer(2);

    // Layer 2 entries refetch.
    await cache.lookup(2, 1, f21);
    await cache.lookup(2, 2, f22);
    expect(f21).toHaveBeenCalledTimes(2);
    expect(f22).toHaveBeenCalledTimes(2);

    // Layer 3 entry stays cached.
    await cache.lookup(3, 1, f31);
    expect(f31).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the target layer has no entries", () => {
    const cache = new EffectIdCache();
    expect(() => cache.invalidateLayer(99)).not.toThrow();
  });
});

describe("EffectIdCache.clearAll", () => {
  it("flushes every cached entry", async () => {
    const cache = new EffectIdCache();
    const fetchers = Array.from({ length: 5 }, (_, i) => vi.fn(async () => i + 1));

    for (let i = 0; i < 5; i += 1) {
      await cache.lookup(i + 1, 1, fetchers[i]);
    }
    expect(cache.size).toBe(5);

    cache.clearAll();
    expect(cache.size).toBe(0);

    // All entries refetch on next lookup.
    for (let i = 0; i < 5; i += 1) {
      await cache.lookup(i + 1, 1, fetchers[i]);
      expect(fetchers[i]).toHaveBeenCalledTimes(2);
    }
  });
});

describe("EffectIdCache single-flight", () => {
  it("coalesces concurrent misses into one fetcher call", async () => {
    const cache = new EffectIdCache();
    let resolveFetch: (id: number) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveFetch = resolve;
        })
    );

    // Two parallel callers race on the same key — they must share one GET.
    const p1 = cache.lookup(1, 1, fetcher);
    const p2 = cache.lookup(1, 1, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch(77);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(77);
    expect(r2).toBe(77);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("clears inflight on rejection so the next call retries", async () => {
    const cache = new EffectIdCache();
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return 99;
    });

    // First two callers join the same in-flight; both reject.
    const p1 = cache.lookup(1, 1, fetcher);
    const p2 = cache.lookup(1, 1, fetcher);
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Subsequent call retries cleanly.
    expect(await cache.lookup(1, 1, fetcher)).toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("EffectIdCache LRU eviction", () => {
  it("evicts the oldest entry when overflowing maxEntries", async () => {
    const cache = new EffectIdCache({ maxEntries: 3 });
    await cache.lookup(1, 1, async () => 1); // oldest
    await cache.lookup(1, 2, async () => 2);
    await cache.lookup(1, 3, async () => 3);
    expect(cache.size).toBe(3);

    // Insert one more — oldest (1,1) should be evicted, others stay.
    await cache.lookup(1, 4, async () => 4);
    expect(cache.size).toBe(3);

    // (1,2), (1,3), (1,4) are all still cached — no fetcher calls.
    const f12 = vi.fn(async () => 99);
    const f13 = vi.fn(async () => 99);
    const f14 = vi.fn(async () => 99);
    expect(await cache.lookup(1, 2, f12)).toBe(2);
    expect(await cache.lookup(1, 3, f13)).toBe(3);
    expect(await cache.lookup(1, 4, f14)).toBe(4);
    expect(f12).toHaveBeenCalledTimes(0);
    expect(f13).toHaveBeenCalledTimes(0);
    expect(f14).toHaveBeenCalledTimes(0);

    // (1,1) was evicted — fetcher gets called.
    const f11 = vi.fn(async () => 11);
    expect(await cache.lookup(1, 1, f11)).toBe(11);
    expect(f11).toHaveBeenCalledTimes(1);
  });

  it("handles overflow at maxEntries+1 with the spec'd 1000 cap", async () => {
    const cache = new EffectIdCache({ maxEntries: DEFAULT_MAX_ENTRIES });
    // Fill to cap.
    for (let i = 1; i <= DEFAULT_MAX_ENTRIES; i += 1) {
      await cache.lookup(1, i, async () => i);
    }
    expect(cache.size).toBe(DEFAULT_MAX_ENTRIES);
    // Insert one more — size stays at cap.
    await cache.lookup(1, DEFAULT_MAX_ENTRIES + 1, async () => DEFAULT_MAX_ENTRIES + 1);
    expect(cache.size).toBe(DEFAULT_MAX_ENTRIES);
  });
});

describe("EffectIdCache disabled mode", () => {
  it("calls fetcher every time and never writes", async () => {
    const cache = new EffectIdCache({ enabled: false });
    const fetcher = vi.fn(async () => 7);

    expect(await cache.lookup(1, 1, fetcher)).toBe(7);
    expect(await cache.lookup(1, 1, fetcher)).toBe(7);
    expect(await cache.lookup(1, 1, fetcher)).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(0);
    expect(cache.isEnabled).toBe(false);
  });
});

describe("EffectIdCache invalidation during in-flight", () => {
  it("does not write a resolved value if invalidated mid-flight; next call refetches", async () => {
    const cache = new EffectIdCache();
    let resolveFetch: (id: number) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const inflight = cache.lookup(2, 1, fetcher);
    // Invalidate before the fetcher resolves.
    cache.invalidateLayer(2);
    resolveFetch(55);
    expect(await inflight).toBe(55);

    // The resolved value must NOT have been written; next call refetches.
    expect(cache.size).toBe(0);
    const fetcher2 = vi.fn(async () => 66);
    expect(await cache.lookup(2, 1, fetcher2)).toBe(66);
    expect(fetcher2).toHaveBeenCalledTimes(1);
  });
});
