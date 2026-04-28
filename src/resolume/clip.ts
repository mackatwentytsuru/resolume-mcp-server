/**
 * Clip-scope operations extracted from ResolumeClient.
 *
 * "Clip" here is one cell in Resolume's grid (`/composition/layers/{l}/clips/{c}`).
 * This module covers triggering and selecting clips, transport controls
 * (direction, play mode, position), thumbnail fetch, the destructive
 * single-slot clear, and the multi-slot `wipeComposition` helper that loops
 * over every layer and clears each slot in turn.
 *
 * `wipeComposition` calls into composition.ts to read the current layer
 * shape — that's why this file is extracted last in the per-domain split.
 *
 * Module-level helpers take a `ResolumeRestClient` as the first argument,
 * matching the precedent set by effects.ts.
 */

import { ResolumeRestClient } from "./rest.js";
import { ResolumeApiError } from "../errors/types.js";
import { assertIndex, filterStringOptions } from "./shared.js";
import { getComposition } from "./composition.js";
import type { EffectIdCache } from "./effect-id-cache.js";

// ---- Trigger / select ----

/** Connects (plays) a clip. Equivalent to clicking it in the Resolume UI. */
export async function triggerClip(
  rest: ResolumeRestClient,
  layer: number,
  clip: number
): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  await rest.post(`/composition/layers/${layer}/clips/${clip}/connect`);
}

/** Puts the clip under selection focus without connecting it. */
export async function selectClip(
  rest: ResolumeRestClient,
  layer: number,
  clip: number
): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  await rest.post(`/composition/layers/${layer}/clips/${clip}/select`);
}

// ---- Clear ----

/**
 * Empties a single clip slot — removes the loaded media so the slot is blank.
 * This is more destructive than clearLayer (which only disconnects what's
 * playing); after clearClip the slot has no source, no name, no thumbnail.
 */
export async function clearClip(
  rest: ResolumeRestClient,
  layer: number,
  clip: number
): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  // DO NOT invalidate the effect-id cache here. Clearing a single clip slot
  // empties the slot's *media* but does not touch the layer's effect chain;
  // effect ids on this layer remain stable. (Mirrors the `clearLayer`
  // convention in `layer.ts`. Bulk wipes go through `wipeComposition` which
  // invalidates conservatively.)
  await rest.post(`/composition/layers/${layer}/clips/${clip}/clear`);
}

/**
 * Empties every clip slot on every layer of the active composition. Returns
 * the number of slots actually cleared.
 *
 * This is the "wipe everything" button — useful when starting from a fresh
 * state, e.g. before loading a new deck or building a show from scratch.
 *
 * Reads the composition shape from composition.getComposition; the one-way
 * dependency on composition.ts is what forces clip.ts to be the last module
 * extracted in the per-domain split.
 *
 * Implementation note (v0.5 Sprint C / Component 4 Phase 2): instead of
 * issuing one POST per clip slot (O(layers × clips) requests), we issue one
 * `POST /composition/layers/{n}/clearclips` per layer (O(layers) requests).
 * `clearclips` is documented in Resolume's official OpenAPI spec
 * (`/composition/layers/{layer-index}/clearclips`, returns 204) and clears
 * every clip on that layer in one shot. We then run those per-layer POSTs
 * in parallel with a small concurrency cap so we don't flood Resolume's
 * single-threaded HTTP server.
 *
 * `slotsCleared` reports the *intended* wipe size (sum of `layer.clips.length`
 * pre-flight), NOT a count of slots actually cleared on the wire. The
 * per-layer `/clearclips` endpoint returns 204 with no body, so the only
 * way to attribute counts would be to GET each layer back. If a per-layer
 * POST fails, `Promise.all` rejects on the first failure and other layers'
 * work is lost — `slotsCleared` will then over-count for the failed layers.
 * This matches the contract of the previous (v0.5.0/0.5.1) sequential
 * implementation; consumers needing strict accounting should re-read the
 * composition after the call.
 *
 * The concurrency cap defaults to `WIPE_LAYER_CONCURRENCY = 4`. Override
 * via `RESOLUME_WIPE_CONCURRENCY` env (range 1..16) for compositions with
 * many layers where the default 4 round-trips serially (a 30-layer comp
 * dispatches 7-8 batches at concurrency 4 vs 4-5 at concurrency 8). The
 * upper bound of 16 is conservative — Resolume's single-threaded HTTP
 * server starts to lose throughput beyond ~8 in-flight requests in
 * informal testing; raise only if telemetry shows headroom.
 */
export const WIPE_LAYER_CONCURRENCY_DEFAULT = 4;
export const WIPE_LAYER_CONCURRENCY_MAX = 16;

export async function wipeComposition(
  rest: ResolumeRestClient,
  cache?: EffectIdCache,
  concurrency: number = WIPE_LAYER_CONCURRENCY_DEFAULT
): Promise<{ layers: number; slotsCleared: number }> {
  const composition = await getComposition(rest);
  const layers = composition.layers ?? [];
  // Pre-compute the expected slot count and per-layer indices.
  const targets = layers.map((layer, idx) => ({
    layerIndex: idx + 1,
    clipCount: (layer.clips ?? []).length,
  }));
  const expectedCleared = targets.reduce((sum, t) => sum + t.clipCount, 0);
  // Dispatch with a fixed-size concurrency window. Workers pull from a shared
  // index counter so a slow layer (large clip set) doesn't stall the others.
  // The 4-way cap prevents flooding Resolume's single-threaded HTTP server
  // (the previous v0.5.0 implementation was sequential for that reason; the
  // /clearclips endpoint absorbs all clips on a layer in one POST so we now
  // need O(layers) requests instead of O(layers × clips), and a small
  // concurrency window is safe).
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= targets.length) return;
      const t = targets[i];
      // Skip layers with zero clips — `clearclips` is harmless on an empty
      // layer (returns 204) but the no-op round-trip is wasteful.
      if (t.clipCount === 0) continue;
      await rest.post(`/composition/layers/${t.layerIndex}/clearclips`);
    }
  }
  const safeConcurrency = Math.max(
    1,
    Math.min(concurrency, WIPE_LAYER_CONCURRENCY_MAX, targets.length || 1)
  );
  const workers = Array.from({ length: safeConcurrency }, () => worker());
  await Promise.all(workers);
  // Conservative wipe — composition shape may be different after; drop
  // the entire effect-id cache. (clearClip is clip-only and would not
  // invalidate effect ids on its own; we treat the bulk wipe as a hard
  // reset signal regardless.)
  cache?.clearAll();
  return { layers: layers.length, slotsCleared: expectedCleared };
}

// ---- Transport (direction / play mode / position) ----

export async function setClipPlayDirection(
  rest: ResolumeRestClient,
  layer: number,
  clip: number,
  direction: "<" | "||" | ">"
): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  if (direction !== "<" && direction !== "||" && direction !== ">") {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "direction",
      value: direction,
      hint: 'direction must be "<" (reverse), "||" (pause), or ">" (forward).',
    });
  }
  await rest.put(`/composition/layers/${layer}/clips/${clip}`, {
    transport: { controls: { playdirection: { value: direction } } },
  });
}

export async function setClipPlayMode(
  rest: ResolumeRestClient,
  layer: number,
  clip: number,
  mode: string
): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  if (typeof mode !== "string" || mode.length === 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "mode",
      value: mode,
      hint: 'mode is one of "Loop", "Bounce", "Random", "Play Once & Clear", "Play Once & Hold".',
    });
  }
  // Validate against the live options to avoid Resolume's silent no-op on
  // unknown mode names.
  const clipData = (await rest.get(`/composition/layers/${layer}/clips/${clip}`)) as {
    transport?: {
      controls?: { playmode?: { options?: unknown[] } };
    };
  };
  const available = filterStringOptions(clipData?.transport?.controls?.playmode?.options);
  if (available.length > 0 && !available.includes(mode)) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "mode",
      value: mode,
      hint: `Unknown play mode "${mode}". Available: ${available.join(", ")}.`,
    });
  }
  await rest.put(`/composition/layers/${layer}/clips/${clip}`, {
    transport: { controls: { playmode: { value: mode } } },
  });
}

export async function setClipPosition(
  rest: ResolumeRestClient,
  layer: number,
  clip: number,
  position: number
): Promise<void> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  if (!Number.isFinite(position) || position < 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "position",
      value: position,
      hint: "position is a non-negative number in clip-internal time units.",
    });
  }
  await rest.put(`/composition/layers/${layer}/clips/${clip}`, {
    transport: { position: { value: position } },
  });
}

// ---- Thumbnail ----

/**
 * Returns the clip's thumbnail as base64-encoded image bytes. Resolume serves
 * thumbnails at `.../thumbnail` and ignores trailing path segments — the
 * cache-buster must be a query string.
 *
 * @param cacheBuster Internal: function returning a unique number per call
 *                    to defeat HTTP caches. Default: `Date.now`. Override
 *                    only in tests where you need a deterministic URL.
 */
export async function getClipThumbnail(
  rest: ResolumeRestClient,
  layer: number,
  clip: number,
  cacheBuster: () => number = () => Date.now()
): Promise<{ base64: string; mediaType: string }> {
  assertIndex("layer", layer);
  assertIndex("clip", clip);
  // Resolume serves thumbnails at .../thumbnail and uses content negotiation;
  // the cache-buster is a query string, not a path segment, so it doesn't 404.
  return rest.getBinary(
    `/composition/layers/${layer}/clips/${clip}/thumbnail?t=${cacheBuster()}`
  );
}
