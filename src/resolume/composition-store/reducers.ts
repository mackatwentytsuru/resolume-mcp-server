/**
 * Pure reducers for the composition store.
 *
 * All functions in this module are side-effect free: they take a snapshot
 * (and a message or REST tree) and return a new snapshot. No timers, no I/O,
 * no class state. This keeps the logic exhaustively testable and lets the
 * `CompositionStore` class be a thin coordinator on top.
 *
 * Two entry points:
 *   - `applyFullSeed(snapshot, restTree)` — replaces structural shape from REST.
 *   - `applyOscMessage(snapshot, message)` — routes a single OSC packet.
 *
 * The OSC dispatcher pattern matches the address against a small set of
 * regex-extracted index captures. Unknown addresses are returned unchanged
 * but reported via the `onUnknownAddress` callback so the caller can debounce
 * structural-drift re-seeds.
 */

import { z } from "zod";
import type { ReceivedOscMessage } from "../osc-client.js";
import type {
  CachedClip,
  CachedComposition,
  CachedLayer,
  CachedScalar,
  CachedTempo,
  Source,
} from "./types.js";

// ───────────────────────── empty snapshot ─────────────────────────

const UNKNOWN: Source = { kind: "unknown" };

function unknownScalar<T>(value: T): CachedScalar<T> {
  return { value, source: UNKNOWN };
}

const EMPTY_TEMPO: CachedTempo = Object.freeze({
  bpm: unknownScalar<number | null>(null),
  bpmNormalized: unknownScalar<number | null>(null),
  min: unknownScalar<number | null>(null),
  max: unknownScalar<number | null>(null),
});

export function createEmptySnapshot(): CachedComposition {
  return {
    revision: 0,
    hydrated: false,
    oscLive: false,
    lastOscAt: null,
    lastSeedAt: null,
    tempo: EMPTY_TEMPO,
    crossfaderPhase: unknownScalar<number | null>(null),
    beatSnap: unknownScalar<string | null>(null),
    beatSnapOptions: [],
    layerCount: 0,
    columnCount: 0,
    deckCount: 0,
    selectedDeck: unknownScalar<number | null>(null),
    layers: [],
    columnNames: [],
    deckNames: [],
  };
}

// ───────────────────────── REST seed ─────────────────────────

/**
 * Permissive Zod shape for the REST `/composition` tree. We only declare the
 * fields we actually consume; everything else passes through. Resolume's
 * field shapes vary across 7.x minors, so deep validation is deliberately
 * avoided here — see `types.ts` (`ParameterSchema`) for the same pattern.
 */
const ParameterShape = z
  .object({ value: z.unknown().optional(), options: z.unknown().optional() })
  .passthrough();

const SeedClipSchema = z
  .object({
    name: ParameterShape.optional(),
    connected: ParameterShape.optional(),
    selected: ParameterShape.optional(),
    transport: z.unknown().optional(),
    video: z.unknown().optional(),
    audio: z.unknown().optional(),
  })
  .passthrough();

const SeedLayerSchema = z
  .object({
    name: ParameterShape.optional(),
    bypassed: ParameterShape.optional(),
    solo: ParameterShape.optional(),
    video: z.unknown().optional(),
    clips: z.array(SeedClipSchema).optional(),
    transition: z.unknown().optional(),
    position: ParameterShape.optional(),
  })
  .passthrough();

const SeedDeckSchema = z
  .object({ name: ParameterShape.optional(), selected: ParameterShape.optional() })
  .passthrough();

const SeedColumnSchema = z.object({ name: ParameterShape.optional() }).passthrough();

const SeedCompositionSchema = z
  .object({
    layers: z.array(SeedLayerSchema).optional(),
    columns: z.array(SeedColumnSchema).optional(),
    decks: z.array(SeedDeckSchema).optional(),
    tempocontroller: z.unknown().optional(),
    crossfader: z.unknown().optional(),
    clipbeatsnap: ParameterShape.optional(),
  })
  .passthrough();

function nameValue(p: { value?: unknown } | undefined): string | null {
  if (!p) return null;
  const v = p.value;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function boolValue(p: { value?: unknown } | undefined): boolean {
  if (!p) return false;
  const v = p.value;
  // Resolume sometimes serializes `connected` as the string "Connected"/"Disconnected".
  if (typeof v === "string") return v === "Connected" || v === "true" || v === "True";
  return v === true;
}

function numberOrNull(p: { value?: unknown } | undefined): number | null {
  if (!p) return null;
  const v = p.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOptions(p: { options?: unknown } | undefined): string[] {
  if (!p) return [];
  const opts = p.options;
  if (!Array.isArray(opts)) return [];
  return opts.filter((o): o is string => typeof o === "string");
}

interface RestParam {
  value?: unknown;
  options?: unknown;
}

function paramAt(obj: unknown, ...path: string[]): RestParam | undefined {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return (cur as RestParam | undefined) ?? undefined;
}

/**
 * Replace structural shape and seed every cached field with REST-sourced values.
 * Bumps revision once. `hydrated` is set true and `lastSeedAt` is set to `now`.
 *
 * Unknown REST shapes pass through Zod's `.passthrough()` — we never throw on
 * extra fields. Missing fields fall back to `unknownScalar(null)`.
 */
export function applyFullSeed(
  prev: CachedComposition,
  restTree: unknown,
  now: number = Date.now()
): CachedComposition {
  const parsed = SeedCompositionSchema.parse(restTree);
  const seedSource: Source = { kind: "rest", fetchedAt: now };

  const layers: CachedLayer[] = (parsed.layers ?? []).map((rawLayer, layerIdx) => {
    const layerIndex = layerIdx + 1;
    const opacityParam = paramAt(rawLayer, "video", "opacity");
    const blendModeParam = paramAt(rawLayer, "video", "mixer", "Blend Mode");
    const clips: CachedClip[] = (rawLayer.clips ?? []).map((rawClip, clipIdx) => {
      const clipIndex = clipIdx + 1;
      const transportPosParam = paramAt(rawClip, "transport", "position");
      // REST exposes raw video/source descriptor; treat presence of `video` as "has media".
      const hasMedia = rawClip.video !== undefined && rawClip.video !== null;
      return {
        layerIndex,
        clipIndex,
        name: { value: nameValue(rawClip.name), source: seedSource },
        connected: { value: boolValue(rawClip.connected), source: seedSource },
        selected: { value: boolValue(rawClip.selected), source: seedSource },
        transportPosition: {
          value: numberOrNull(transportPosParam),
          source: seedSource,
        },
        hasMedia: { value: hasMedia, source: seedSource },
      };
    });
    return {
      layerIndex,
      name: { value: nameValue(rawLayer.name), source: seedSource },
      opacity: { value: numberOrNull(opacityParam) ?? 0, source: seedSource },
      bypassed: { value: boolValue(rawLayer.bypassed), source: seedSource },
      solo: { value: boolValue(rawLayer.solo), source: seedSource },
      position: { value: numberOrNull(rawLayer.position), source: seedSource },
      blendMode: {
        value:
          blendModeParam && typeof blendModeParam.value === "string"
            ? blendModeParam.value
            : null,
        source: seedSource,
      },
      clips,
    };
  });

  const columns = parsed.columns ?? [];
  const decks = parsed.decks ?? [];
  const columnNames: (string | null)[] = columns.map((c) => nameValue(c.name));
  const deckNames: (string | null)[] = decks.map((d) => nameValue(d.name));

  const tempoParam = paramAt(parsed.tempocontroller, "tempo");
  // Gate `min`/`max` on the param block's existence, not on `value`.
  // Mid-startup Resolume can return a tempocontroller whose tempo `value`
  // is null while `min`/`max` are already populated; the previous gate
  // dropped them. (Review M5.)
  const tempo: CachedTempo = {
    bpm: { value: numberOrNull(tempoParam), source: seedSource },
    bpmNormalized: prev.tempo.bpmNormalized, // OSC-only — preserve last OSC if any
    min: {
      value: tempoParam ? readNumber(tempoParam, "min") ?? null : null,
      source: seedSource,
    },
    max: {
      value: tempoParam ? readNumber(tempoParam, "max") ?? null : null,
      source: seedSource,
    },
  };

  const crossfaderPhaseParam = paramAt(parsed.crossfader, "phase");
  const crossfaderPhase: CachedScalar<number | null> = {
    value: numberOrNull(crossfaderPhaseParam),
    source: seedSource,
  };

  const beatSnapParam = parsed.clipbeatsnap as RestParam | undefined;
  const beatSnap: CachedScalar<string | null> = {
    value:
      beatSnapParam && typeof beatSnapParam.value === "string"
        ? beatSnapParam.value
        : null,
    source: seedSource,
  };
  const beatSnapOptions = stringOptions(beatSnapParam);

  const selectedDeckIndex = decks.findIndex((d) => boolValue(d.selected));
  const selectedDeck: CachedScalar<number | null> = {
    value: selectedDeckIndex >= 0 ? selectedDeckIndex + 1 : null,
    source: seedSource,
  };

  return {
    ...prev,
    revision: prev.revision + 1,
    hydrated: true,
    lastSeedAt: now,
    tempo,
    crossfaderPhase,
    beatSnap,
    beatSnapOptions,
    layerCount: layers.length,
    columnCount: columns.length,
    deckCount: decks.length,
    selectedDeck,
    layers,
    columnNames,
    deckNames,
  };
}

function readNumber(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ───────────────────────── OSC message routing ─────────────────────────

/**
 * Address-pattern table. Each entry has a regex over the OSC address and
 * a sub-reducer that consumes the captured indices + the message args.
 *
 * Order matters only for fall-through; the first match wins.
 */

const RE_LAYER_OPACITY = /^\/composition\/layers\/(\d+)\/video\/opacity$/;
const RE_LAYER_BYPASS = /^\/composition\/layers\/(\d+)\/bypassed$/;
const RE_LAYER_SOLO = /^\/composition\/layers\/(\d+)\/solo$/;
const RE_LAYER_POSITION = /^\/composition\/layers\/(\d+)\/position$/;
const RE_CLIP_TRANSPORT = /^\/composition\/layers\/(\d+)\/clips\/(\d+)\/transport\/position$/;
const RE_CLIP_CONNECT = /^\/composition\/layers\/(\d+)\/clips\/(\d+)\/connect$/;
const RE_CLIP_SELECT = /^\/composition\/layers\/(\d+)\/clips\/(\d+)\/select$/;
const RE_TEMPO = /^\/composition\/tempocontroller\/tempo$/;
const RE_CROSSFADER = /^\/composition\/crossfader\/phase$/;
const RE_BEATSNAP = /^\/composition\/clipbeatsnap$/;
const RE_DECK_SELECT = /^\/composition\/decks\/(\d+)\/select$/;

/**
 * Debounce window for `lastOscAt` updates on unknown addresses. At ~325 msg/s
 * an unknown-address storm would otherwise allocate a fresh snapshot per
 * packet to bump bookkeeping fields. 50 ms is small enough that freshness
 * gates still see lastOscAt near-realtime, large enough to coalesce ~16 bursts
 * into one allocation.
 */
const UNKNOWN_ADDRESS_DEBOUNCE_MS = 50;

export interface OscRouteOptions {
  /** Invoked with the raw address whenever it does not match any known reducer. */
  readonly onUnknownAddress?: (address: string) => void;
  /** Invoked when an address references an out-of-range layer/clip index. */
  readonly onDriftDetected?: (info: { address: string; layer: number; clip?: number }) => void;
}

/**
 * Apply a single OSC message and return the resulting snapshot. If the
 * address is not recognized OR references an out-of-range index, the snapshot
 * is returned unchanged but the appropriate callback is fired.
 */
export function applyOscMessage(
  prev: CachedComposition,
  msg: ReceivedOscMessage,
  options: OscRouteOptions = {}
): CachedComposition {
  const source: Source = { kind: "osc", receivedAt: msg.timestamp };

  // Always update the OSC liveness fields, regardless of whether the address
  // matches a known reducer — Resolume sending *anything* means it's alive.
  const baseline: CachedComposition = {
    ...prev,
    oscLive: true,
    lastOscAt: msg.timestamp,
  };

  let m: RegExpExecArray | null;

  m = RE_LAYER_OPACITY.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    return applyOpacity(baseline, layer, firstNumber(msg.args), source, msg.address, options);
  }

  m = RE_LAYER_BYPASS.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    return applyBypass(baseline, layer, firstBool(msg.args), source, msg.address, options);
  }

  m = RE_LAYER_SOLO.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    return applySolo(baseline, layer, firstBool(msg.args), source, msg.address, options);
  }

  m = RE_LAYER_POSITION.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    return applyLayerPosition(baseline, layer, firstNumber(msg.args), source, msg.address, options);
  }

  m = RE_CLIP_TRANSPORT.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    const clip = parseInt(m[2]!, 10);
    return applyTransportPosition(
      baseline,
      layer,
      clip,
      firstNumber(msg.args),
      source,
      msg.address,
      options
    );
  }

  m = RE_CLIP_CONNECT.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    const clip = parseInt(m[2]!, 10);
    return applyConnect(
      baseline,
      layer,
      clip,
      firstBool(msg.args),
      source,
      msg.address,
      options
    );
  }

  m = RE_CLIP_SELECT.exec(msg.address);
  if (m) {
    const layer = parseInt(m[1]!, 10);
    const clip = parseInt(m[2]!, 10);
    return applySelect(
      baseline,
      layer,
      clip,
      firstBool(msg.args),
      source,
      msg.address,
      options
    );
  }

  if (RE_TEMPO.test(msg.address)) {
    return applyTempo(baseline, firstNumber(msg.args), source);
  }

  if (RE_CROSSFADER.test(msg.address)) {
    return applyCrossfader(baseline, firstNumber(msg.args), source);
  }

  if (RE_BEATSNAP.test(msg.address)) {
    const v = msg.args[0];
    if (typeof v === "string") {
      return applyBeatSnap(baseline, v, source);
    }
    return baseline;
  }

  m = RE_DECK_SELECT.exec(msg.address);
  if (m) {
    const deck = parseInt(m[1]!, 10);
    const value = firstBool(msg.args);
    return applySelectedDeck(baseline, deck, value, source);
  }

  // No match — bookkeeping only. Debounce timestamp-only updates so an
  // unknown-address storm doesn't allocate a fresh snapshot per packet.
  // The first packet always promotes oscLive=true; subsequent packets
  // within the debounce window return the previous snapshot unchanged.
  options.onUnknownAddress?.(msg.address);
  if (
    prev.oscLive &&
    prev.lastOscAt !== null &&
    msg.timestamp - prev.lastOscAt < UNKNOWN_ADDRESS_DEBOUNCE_MS
  ) {
    return prev;
  }
  return baseline;
}

// ───────────────────────── sub-reducers ─────────────────────────

function firstNumber(args: ReadonlyArray<unknown>): number | null {
  const a = args[0];
  return typeof a === "number" && Number.isFinite(a) ? a : null;
}

function firstBool(args: ReadonlyArray<unknown>): boolean {
  const a = args[0];
  if (typeof a === "boolean") return a;
  if (typeof a === "number") return a !== 0;
  if (typeof a === "string") return a === "true" || a === "True" || a === "Connected";
  return false;
}

function bumpRevision(snap: CachedComposition): CachedComposition {
  return { ...snap, revision: snap.revision + 1 };
}

function ensureLayerInRange(
  snap: CachedComposition,
  layer: number,
  address: string,
  options: OscRouteOptions
): boolean {
  if (layer < 1 || layer > snap.layerCount) {
    options.onDriftDetected?.({ address, layer });
    return false;
  }
  return true;
}

function ensureClipInRange(
  snap: CachedComposition,
  layer: number,
  clip: number,
  address: string,
  options: OscRouteOptions
): boolean {
  if (!ensureLayerInRange(snap, layer, address, options)) return false;
  const layerSlot = snap.layers[layer - 1]!;
  if (clip < 1 || clip > layerSlot.clips.length) {
    options.onDriftDetected?.({ address, layer, clip });
    return false;
  }
  return true;
}

function replaceLayer(
  snap: CachedComposition,
  layerIndex: number,
  next: CachedLayer
): CachedComposition {
  const layers = snap.layers.map((l, idx) => (idx === layerIndex - 1 ? next : l));
  return bumpRevision({ ...snap, layers });
}

function replaceClip(
  snap: CachedComposition,
  layerIndex: number,
  clipIndex: number,
  next: CachedClip
): CachedComposition {
  const targetLayer = snap.layers[layerIndex - 1]!;
  const clips = targetLayer.clips.map((c, idx) => (idx === clipIndex - 1 ? next : c));
  const newLayer: CachedLayer = { ...targetLayer, clips };
  return replaceLayer(snap, layerIndex, newLayer);
}

export function applyOpacity(
  prev: CachedComposition,
  layer: number,
  value: number | null,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (value === null) return prev;
  if (!ensureLayerInRange(prev, layer, address, options)) return prev;
  const target = prev.layers[layer - 1]!;
  if (target.opacity.value === value && target.opacity.source.kind === source.kind) {
    return prev; // no-op
  }
  const next: CachedLayer = { ...target, opacity: { value, source } };
  return replaceLayer(prev, layer, next);
}

export function applyBypass(
  prev: CachedComposition,
  layer: number,
  value: boolean,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (!ensureLayerInRange(prev, layer, address, options)) return prev;
  const target = prev.layers[layer - 1]!;
  if (target.bypassed.value === value) return prev;
  const next: CachedLayer = { ...target, bypassed: { value, source } };
  return replaceLayer(prev, layer, next);
}

export function applySolo(
  prev: CachedComposition,
  layer: number,
  value: boolean,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (!ensureLayerInRange(prev, layer, address, options)) return prev;
  const target = prev.layers[layer - 1]!;
  if (target.solo.value === value) return prev;
  const next: CachedLayer = { ...target, solo: { value, source } };
  return replaceLayer(prev, layer, next);
}

export function applyLayerPosition(
  prev: CachedComposition,
  layer: number,
  value: number | null,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (value === null) return prev;
  if (!ensureLayerInRange(prev, layer, address, options)) return prev;
  const target = prev.layers[layer - 1]!;
  // For continuously-pushed values we always update the source even if value matches,
  // so freshness gates work correctly. But avoid bumping revision for identical values.
  if (target.position.value === value) {
    const next: CachedLayer = { ...target, position: { value, source } };
    return { ...prev, layers: prev.layers.map((l, i) => (i === layer - 1 ? next : l)) };
  }
  const next: CachedLayer = { ...target, position: { value, source } };
  return replaceLayer(prev, layer, next);
}

export function applyTransportPosition(
  prev: CachedComposition,
  layer: number,
  clip: number,
  value: number | null,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (value === null) return prev;
  if (!ensureClipInRange(prev, layer, clip, address, options)) return prev;
  const target = prev.layers[layer - 1]!.clips[clip - 1]!;
  if (target.transportPosition.value === value) {
    // Refresh source freshness without revision bump (high-frequency path).
    const next: CachedClip = { ...target, transportPosition: { value, source } };
    const layerSlot = prev.layers[layer - 1]!;
    const clips = layerSlot.clips.map((c, idx) => (idx === clip - 1 ? next : c));
    const newLayer: CachedLayer = { ...layerSlot, clips };
    return {
      ...prev,
      layers: prev.layers.map((l, i) => (i === layer - 1 ? newLayer : l)),
    };
  }
  const next: CachedClip = { ...target, transportPosition: { value, source } };
  return replaceClip(prev, layer, clip, next);
}

export function applyConnect(
  prev: CachedComposition,
  layer: number,
  clip: number,
  value: boolean,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (!ensureClipInRange(prev, layer, clip, address, options)) return prev;
  const target = prev.layers[layer - 1]!.clips[clip - 1]!;
  if (target.connected.value === value) return prev;
  const next: CachedClip = { ...target, connected: { value, source } };
  return replaceClip(prev, layer, clip, next);
}

export function applySelect(
  prev: CachedComposition,
  layer: number,
  clip: number,
  value: boolean,
  source: Source,
  address: string,
  options: OscRouteOptions
): CachedComposition {
  if (!ensureClipInRange(prev, layer, clip, address, options)) return prev;
  const target = prev.layers[layer - 1]!.clips[clip - 1]!;
  if (target.selected.value === value) return prev;
  const next: CachedClip = { ...target, selected: { value, source } };
  return replaceClip(prev, layer, clip, next);
}

export function applyTempo(
  prev: CachedComposition,
  value: number | null,
  source: Source
): CachedComposition {
  if (value === null) return prev;
  if (prev.tempo.bpmNormalized.value === value) {
    // No-op: same value as last observation. Return prev unchanged so we
    // avoid allocating three objects per packet on the ~325 Hz tempo stream.
    // Source freshness is sacrificed but isFresh() falls back to lastOscAt
    // (already updated in the baseline) for coarse tempo freshness checks.
    return prev;
  }
  return bumpRevision({
    ...prev,
    tempo: { ...prev.tempo, bpmNormalized: { value, source } },
  });
}

export function applyCrossfader(
  prev: CachedComposition,
  value: number | null,
  source: Source
): CachedComposition {
  if (value === null) return prev;
  if (prev.crossfaderPhase.value === value) {
    return { ...prev, crossfaderPhase: { value, source } };
  }
  return bumpRevision({ ...prev, crossfaderPhase: { value, source } });
}

export function applyBeatSnap(
  prev: CachedComposition,
  value: string,
  source: Source
): CachedComposition {
  if (prev.beatSnap.value === value) return prev;
  return bumpRevision({ ...prev, beatSnap: { value, source } });
}

export function applySelectedDeck(
  prev: CachedComposition,
  deck: number,
  selected: boolean,
  source: Source
): CachedComposition {
  // Only "selected = true" tells us which deck is now active.
  if (!selected) return prev;
  if (prev.selectedDeck.value === deck) {
    return { ...prev, selectedDeck: { value: deck, source } };
  }
  return bumpRevision({ ...prev, selectedDeck: { value: deck, source } });
}
