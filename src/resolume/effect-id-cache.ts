/**
 * Effect-id cache for `setEffectParameter`.
 *
 * Resolume's nested-PUT body needs the target effect's numeric `id` to
 * disambiguate which array entry to mutate; without it, Resolume silently
 * no-ops. Today every `setEffectParameter` call does GET-then-PUT (2
 * roundtrips) just to look that id up. The id of a given `(layer, effectIndex)`
 * is stable as long as the effect array on that layer is not mutated
 * (no add/remove/clear) — perfect candidate for a small TTL-bounded
 * in-process cache with explicit invalidation hooks.
 *
 * Design (see `docs/v0.5/04-effect-cache-and-sub-endpoints.md`):
 *   - 300s TTL (≈ one re-fetch per song boundary, sanity check against drift).
 *   - 1000-entry LRU cap (insertion-order eviction via `Map` ordering).
 *   - Single-flight: concurrent misses for the same key share one `fetcher()`
 *     promise, preventing N→N GETs.
 *   - Per-layer index (`Map<number, Set<CacheKey>>`) for O(1) layer-wide
 *     invalidation when `addEffectToLayer` / `removeEffectFromLayer` runs.
 *   - Lazy expiry on read; no background timer.
 *
 * Cache lives on `ResolumeClient` instance (one cache per client), not
 * module-global. Test/opt-out via constructor `enabled` flag.
 *
 * Caveat: cache stores only the id, not the param schema. Subsequent hits
 * skip param-name validation; first miss validates everything. Acceptable
 * for tight-loop use; documented in spec.
 */

/** Default TTL for cached effect ids, in ms. Spec: 300s (5 minutes). */
export const DEFAULT_TTL_MS = 300_000;

/** Default soft maximum entries before LRU eviction kicks in. */
export const DEFAULT_MAX_ENTRIES = 1000;

/** `${layer}:${effectIndex}` — both 1-based as everywhere else. */
type CacheKey = `${number}:${number}`;

interface CacheEntry {
  readonly id: number;
  readonly expiresAt: number;
}

export interface EffectIdCacheOptions {
  /** TTL for cached entries in ms. Defaults to {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /** Soft maximum entries; oldest evicted on overflow. Defaults to {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
  /** When false, every {@link EffectIdCache.lookup} bypasses the cache and calls fetcher. */
  enabled?: boolean;
  /** Override clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

function makeKey(layer: number, effectIndex: number): CacheKey {
  return `${layer}:${effectIndex}`;
}

/**
 * Per-client effect-id cache. Public methods:
 *   - `lookup(layer, effectIndex, fetcher)` — returns cached id or fetches.
 *   - `invalidateLayer(layer)` — drops all entries on that layer.
 *   - `clearAll()` — drops everything.
 */
export class EffectIdCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly enabled: boolean;
  private readonly now: () => number;

  // `Map` preserves insertion order, so iterating keys gives us "oldest first"
  // for LRU eviction. We treat reads as not refreshing recency (write-LRU,
  // not access-LRU) — simpler, and entries are short-lived enough that the
  // distinction rarely matters in practice.
  private readonly entries = new Map<CacheKey, CacheEntry>();

  // Per-layer index: maps `layer` → set of cache keys present for that layer.
  // Lets `invalidateLayer` drop entries in O(layer-size) instead of scanning
  // every key in the cache.
  private readonly byLayer = new Map<number, Set<CacheKey>>();

  // Single-flight: while a fetcher is pending, additional callers join the
  // same promise rather than launching parallel GETs. Cleared on settle.
  private readonly inflight = new Map<CacheKey, Promise<number>>();

  constructor(options: EffectIdCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of currently cached entries. Test-visibility helper. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether the cache is enabled. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Returns the effect id for `(layer, effectIndex)`. On miss (or expired
   * entry), invokes `fetcher` and caches its result. Concurrent misses for
   * the same key are coalesced into a single fetcher call (single-flight).
   *
   * When `enabled` is false, always calls fetcher and never writes.
   */
  async lookup(
    layer: number,
    effectIndex: number,
    fetcher: () => Promise<number>
  ): Promise<number> {
    if (!this.enabled) {
      return fetcher();
    }

    const key = makeKey(layer, effectIndex);
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) {
      return hit.id;
    }

    // Stale entry — evict so we don't re-evaluate it on every miss.
    if (hit) {
      this.evict(key);
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = fetcher()
      .then((id) => {
        // Only commit if this single-flight is still the active one for
        // the key. If `invalidateLayer` / `clearAll` ran during the fetch,
        // it cleared `inflight[key]`; in that case, returning the value
        // is fine but writing it back would resurrect a key that was just
        // explicitly invalidated. Skip the write so the next call refetches.
        if (this.inflight.get(key) === promise) {
          this.set(key, layer, id);
        }
        return id;
      })
      .finally(() => {
        // Clear our slot only if it still belongs to us. (An invalidation
        // during in-flight will already have removed it.)
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Drops every cached entry whose key starts with `${layer}:`. Also clears
   * any in-flight promise for that layer so a fetcher resolving after this
   * call is *not* written back.
   */
  invalidateLayer(layer: number): void {
    const keys = this.byLayer.get(layer);
    if (keys) {
      for (const key of keys) {
        this.entries.delete(key);
        this.inflight.delete(key);
      }
      this.byLayer.delete(layer);
    }
    // Also catch any in-flight that hasn't yet been written. The `inflight`
    // map may hold keys for this layer that are not yet in `byLayer` (the
    // entry is added on `set`, which happens after the fetcher resolves).
    for (const key of Array.from(this.inflight.keys())) {
      if (key.startsWith(`${layer}:`)) {
        this.inflight.delete(key);
      }
    }
  }

  /** Drops every entry and every in-flight promise. */
  clearAll(): void {
    this.entries.clear();
    this.byLayer.clear();
    this.inflight.clear();
  }

  // ---- Internals ----

  private set(key: CacheKey, layer: number, id: number): void {
    // If the key already exists (shouldn't usually — TTL miss path evicts
    // first), drop it to keep `byLayer` consistent.
    if (this.entries.has(key)) {
      this.evict(key);
    }
    // LRU eviction: if at cap, drop the oldest entry (Map iteration order
    // is insertion order). This runs *before* the insert so we never exceed
    // `maxEntries` momentarily.
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    this.entries.set(key, { id, expiresAt: this.now() + this.ttlMs });
    let layerSet = this.byLayer.get(layer);
    if (!layerSet) {
      layerSet = new Set();
      this.byLayer.set(layer, layerSet);
    }
    layerSet.add(key);
  }

  private evict(key: CacheKey): void {
    this.entries.delete(key);
    // Recover layer from the key — `${layer}:${effectIndex}`.
    const colon = key.indexOf(":");
    if (colon > 0) {
      const layer = Number(key.slice(0, colon));
      const layerSet = this.byLayer.get(layer);
      if (layerSet) {
        layerSet.delete(key);
        if (layerSet.size === 0) this.byLayer.delete(layer);
      }
    }
  }
}
