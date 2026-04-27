/**
 * Composition store — type definitions.
 *
 * Pure types only; no I/O, no class state. The shapes here are the immutable
 * contract that reducers mutate (by spread-copy) and that read APIs surface to
 * tools. See docs/v0.5/01-composition-store.md for the design rationale.
 *
 * Every cached field carries a `Source` provenance tag so freshness can be
 * decided per-field. `ReadonlyArray` is used everywhere so the type system
 * prevents accidental mutation of cached state.
 */

/** Provenance tag on every cached field — drives staleness checks and tool diagnostics. */
export type Source =
  | { kind: "osc"; receivedAt: number }
  | { kind: "rest"; fetchedAt: number }
  | { kind: "unknown" };

export interface CachedScalar<T> {
  readonly value: T;
  readonly source: Source;
}

/** Per-clip slice — only fields Resolume reliably pushes via OSC plus REST-seeded structural data. */
export interface CachedClip {
  readonly layerIndex: number;
  readonly clipIndex: number;
  readonly name: CachedScalar<string | null>;
  readonly connected: CachedScalar<boolean>;
  readonly selected: CachedScalar<boolean>;
  /** Normalized 0..1 — pushed every frame at ~325 msg/s aggregate when playing. */
  readonly transportPosition: CachedScalar<number | null>;
  /** REST-only structural flag: whether the slot has media. */
  readonly hasMedia: CachedScalar<boolean>;
}

export interface CachedLayer {
  readonly layerIndex: number;
  readonly name: CachedScalar<string | null>;
  readonly opacity: CachedScalar<number>;
  readonly bypassed: CachedScalar<boolean>;
  readonly solo: CachedScalar<boolean>;
  /** Layer-level normalized position — pushed by Resolume per CLAUDE.md note. */
  readonly position: CachedScalar<number | null>;
  /** REST-only — Resolume pushes the *index* of Blend Mode via OSC, not the string. */
  readonly blendMode: CachedScalar<string | null>;
  readonly clips: ReadonlyArray<CachedClip>;
}

export interface CachedTempo {
  /** REST stores raw BPM; OSC pushes 0..1 normalized. We keep both. */
  readonly bpm: CachedScalar<number | null>;
  readonly bpmNormalized: CachedScalar<number | null>;
  readonly min: CachedScalar<number | null>;
  readonly max: CachedScalar<number | null>;
}

export interface CachedComposition {
  /** Monotonic version, bumped on every applied mutation. Lets readers detect change. */
  readonly revision: number;
  /** Was the snapshot ever populated? False until first REST seed succeeds. */
  readonly hydrated: boolean;
  /** True iff the OSC listener has received at least one packet since boot. */
  readonly oscLive: boolean;
  /** ms epoch of the last OSC packet (any address). null if never. */
  readonly lastOscAt: number | null;
  /** ms epoch of the last full REST seed. null if never. */
  readonly lastSeedAt: number | null;

  readonly tempo: CachedTempo;
  readonly crossfaderPhase: CachedScalar<number | null>;
  readonly beatSnap: CachedScalar<string | null>;
  readonly beatSnapOptions: ReadonlyArray<string>;

  readonly layerCount: number;
  readonly columnCount: number;
  readonly deckCount: number;
  readonly selectedDeck: CachedScalar<number | null>;

  readonly layers: ReadonlyArray<CachedLayer>;
  readonly columnNames: ReadonlyArray<string | null>;
  readonly deckNames: ReadonlyArray<string | null>;
}

/**
 * Operating mode for the store.
 *
 * - `owner`: store binds OSC OUT exclusively and is the canonical listener.
 * - `shared`: store does not bind; other tools push messages via `feed()`.
 * - `off`: store is not constructed at all (legacy v0.4 behavior).
 */
export type CompositionStoreMode = "owner" | "shared" | "off";

export interface CompositionStoreTtlOverrides {
  /** Default 250 ms — clip transport position. */
  readonly transportPositionMs?: number;
  /** Default 5000 ms — opacity / bypass / solo. */
  readonly layerScalarsMs?: number;
  /** Default 2000 ms — bpm, crossfader phase. */
  readonly compositionScalarsMs?: number;
  /** Default 30000 ms — clip names, layer names, structural counts. */
  readonly structuralMs?: number;
}

export interface CompositionStoreOptions {
  /** OSC host/ports for listener bind and OSC OUT receive. */
  readonly oscHost: string;
  readonly oscOutPort: number;
  /** Operating mode. */
  readonly mode: CompositionStoreMode;
  /** ms before `start()` returns regardless of hydration outcome. Default 5000. */
  readonly hydrationTimeoutMs?: number;
  /** Debounce window for drift-driven re-seeds. Default 500. */
  readonly rehydrateThrottleMs?: number;
  /** Background reconnect interval when not yet hydrated. Default 5000. */
  readonly reconnectIntervalMs?: number;
  /** Per-field TTL overrides. */
  readonly ttls?: CompositionStoreTtlOverrides;
}
