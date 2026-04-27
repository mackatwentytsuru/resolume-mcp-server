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
 */
export async function wipeComposition(
  rest: ResolumeRestClient,
  cache?: EffectIdCache
): Promise<{ layers: number; slotsCleared: number }> {
  const composition = await getComposition(rest);
  const layers = composition.layers ?? [];
  let cleared = 0;
  for (let li = 0; li < layers.length; li += 1) {
    const clips = layers[li].clips ?? [];
    for (let ci = 0; ci < clips.length; ci += 1) {
      await rest.post(
        `/composition/layers/${li + 1}/clips/${ci + 1}/clear`
      );
      cleared += 1;
    }
  }
  // Conservative wipe — composition shape may be different after; drop
  // the entire effect-id cache. (clearClip is clip-only and would not
  // invalidate effect ids on its own; we treat the bulk wipe as a hard
  // reset signal regardless.)
  cache?.clearAll();
  return { layers: layers.length, slotsCleared: cleared };
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
