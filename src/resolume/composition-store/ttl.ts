/**
 * TTL constants and freshness gate for cached fields.
 *
 * Per the design (docs/v0.5/01-composition-store.md, "Invalidation" section),
 * different fields have different staleness tolerances:
 *
 *   transportPosition          250 ms   pushed every ~3 ms when playing
 *   opacity / bypassed / solo  5000 ms  user-driven, low frequency
 *   bpm / crossfaderPhase      2000 ms  per-show params
 *   structural (counts/names)  30000 ms rarely change at show time
 *
 * `isFresh()` is a pure function that takes a `Source` and an "as of" wall-clock
 * time and returns whether the cached value is within its TTL. Reads always
 * fall through to REST when `isFresh` returns false.
 */

import type { Source } from "./types.js";

export type TtlField =
  | "transportPosition"
  | "opacity"
  | "bypassed"
  | "solo"
  | "bpm"
  | "crossfaderPhase"
  | "structural"
  /** Same TTL as opacity — used by reducers for layer-level normalized position pushes. */
  | "layerPosition";

export const DEFAULT_TTL_MS: Readonly<Record<TtlField, number>> = Object.freeze({
  transportPosition: 250,
  opacity: 5_000,
  bypassed: 5_000,
  solo: 5_000,
  layerPosition: 5_000,
  bpm: 2_000,
  crossfaderPhase: 2_000,
  structural: 30_000,
});

/** Wall-clock receive/seed time of a `Source`, or null if never observed. */
export function sourceTimestamp(source: Source): number | null {
  if (source.kind === "osc") return source.receivedAt;
  if (source.kind === "rest") return source.fetchedAt;
  return null;
}

/**
 * Returns true if the cached field is within its TTL.
 *
 * - "unknown" sources are never fresh.
 * - The exact threshold (`age === ttl`) is treated as **fresh** so timer-edge
 *   tests are deterministic; `age > ttl` is stale.
 */
export function isFresh(source: Source, field: TtlField, now: number = Date.now()): boolean {
  const ts = sourceTimestamp(source);
  if (ts === null) return false;
  const ttl = DEFAULT_TTL_MS[field];
  return now - ts <= ttl;
}

/** ms since the source was observed, or null if never. */
export function ageMs(source: Source, now: number = Date.now()): number | null {
  const ts = sourceTimestamp(source);
  if (ts === null) return null;
  return Math.max(0, now - ts);
}
