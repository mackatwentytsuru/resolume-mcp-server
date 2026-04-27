/**
 * Layer-scope operations extracted from ResolumeClient.
 *
 * Layers are the vertical slots in Resolume's clip grid. Each carries video
 * settings (opacity, blend mode, bypass), a transition (duration + blend
 * mode used during clip changes), and a "clear" action that disconnects all
 * its clips. Helpers PUT to `/composition/layers/{n}` with the appropriate
 * nested envelope, or POST to `.../clear` for the destructive disconnect.
 *
 * Module-level helpers take a `ResolumeRestClient` as the first argument,
 * matching the precedent set by effects.ts. The thin facade methods on
 * ResolumeClient re-surface these unchanged.
 */

import { ResolumeRestClient } from "./rest.js";
import { ResolumeApiError } from "../errors/types.js";
import { assertIndex, filterStringOptions } from "./shared.js";

// ---- Clear (disconnect all clips on the layer) ----

/** Disconnects all clips on the layer (layer goes black). */
export async function clearLayer(rest: ResolumeRestClient, layer: number): Promise<void> {
  assertIndex("layer", layer);
  await rest.post(`/composition/layers/${layer}/clear`);
}

// ---- Opacity / bypass ----

/** Master opacity in 0..1. */
export async function setLayerOpacity(
  rest: ResolumeRestClient,
  layer: number,
  value: number
): Promise<void> {
  assertIndex("layer", layer);
  if (value < 0 || value > 1 || Number.isNaN(value)) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "opacity",
      value,
      hint: "Opacity must be a number between 0 and 1.",
    });
  }
  await rest.put(`/composition/layers/${layer}`, {
    video: { opacity: { value } },
  });
}

/** Mute/unmute the layer (skips rendering when bypassed). */
export async function setLayerBypass(
  rest: ResolumeRestClient,
  layer: number,
  bypassed: boolean
): Promise<void> {
  assertIndex("layer", layer);
  await rest.put(`/composition/layers/${layer}`, {
    bypassed: { value: bypassed },
  });
}

// ---- Blend mode ----

/** Returns the list of available blend mode names for the layer. */
export async function getLayerBlendModes(
  rest: ResolumeRestClient,
  layer: number
): Promise<string[]> {
  assertIndex("layer", layer);
  const raw = (await rest.get(`/composition/layers/${layer}`)) as {
    video?: { mixer?: { "Blend Mode"?: { options?: unknown } } };
  };
  return filterStringOptions(raw?.video?.mixer?.["Blend Mode"]?.options);
}

/** Layer blend mode (Add, Multiply, Screen, etc.). Pre-validates against live options. */
export async function setLayerBlendMode(
  rest: ResolumeRestClient,
  layer: number,
  blendMode: string
): Promise<void> {
  assertIndex("layer", layer);
  if (typeof blendMode !== "string" || blendMode.length === 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "blendMode",
      value: blendMode,
      hint: "blendMode must be a non-empty string. Use resolume_list_layer_blend_modes to enumerate options.",
    });
  }
  // Resolume silently no-ops if you PUT an unknown blend mode name. Validate
  // against the layer's available options first so the LLM gets a useful error.
  const available = await getLayerBlendModes(rest, layer);
  if (available.length > 0 && !available.includes(blendMode)) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "blendMode",
      value: blendMode,
      hint: `Unknown blend mode "${blendMode}". Available: ${available.slice(0, 10).join(", ")}${available.length > 10 ? `, ... (${available.length} total)` : ""}.`,
    });
  }
  await rest.put(`/composition/layers/${layer}`, {
    video: { mixer: { "Blend Mode": { value: blendMode } } },
  });
}

// ---- Transition ----

/** Sets the layer's transition duration in seconds (0..10). 0 = instant cuts. */
export async function setLayerTransitionDuration(
  rest: ResolumeRestClient,
  layer: number,
  durationSeconds: number
): Promise<void> {
  assertIndex("layer", layer);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 10) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "durationSeconds",
      value: durationSeconds,
      hint: "Layer transition duration must be 0..10 seconds.",
    });
  }
  await rest.put(`/composition/layers/${layer}`, {
    transition: { duration: { value: durationSeconds } },
  });
}

/** Returns the available transition blend modes for a layer (50+ options). */
export async function getLayerTransitionBlendModes(
  rest: ResolumeRestClient,
  layer: number
): Promise<string[]> {
  assertIndex("layer", layer);
  const raw = (await rest.get(`/composition/layers/${layer}`)) as {
    transition?: { blend_mode?: { options?: unknown[] } };
  };
  return filterStringOptions(raw?.transition?.blend_mode?.options);
}

/** Sets the layer's transition blend mode (the visual effect applied during clip changes). */
export async function setLayerTransitionBlendMode(
  rest: ResolumeRestClient,
  layer: number,
  blendMode: string
): Promise<void> {
  assertIndex("layer", layer);
  if (typeof blendMode !== "string" || blendMode.length === 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "blendMode",
      value: blendMode,
      hint: "Pre-validate against the layer's transition options. List them first if unsure.",
    });
  }
  const available = await getLayerTransitionBlendModes(rest, layer);
  if (available.length > 0 && !available.includes(blendMode)) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "blendMode",
      value: blendMode,
      hint: `Unknown transition blend mode "${blendMode}". Available: ${available.slice(0, 10).join(", ")}${available.length > 10 ? `, ... (${available.length} total)` : ""}.`,
    });
  }
  await rest.put(`/composition/layers/${layer}`, {
    transition: { blend_mode: { value: blendMode } },
  });
}
