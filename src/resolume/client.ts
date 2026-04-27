import { ResolumeRestClient } from "./rest.js";
import type {
  Composition,
  CompositionSummary,
  ProductInfo,
  TempoState,
  EffectCatalogEntry,
} from "./types.js";
import { ResolumeApiError } from "../errors/types.js";
import { assertIndex } from "./shared.js";
import * as composition from "./composition.js";
import * as effects from "./effects.js";
import * as tempo from "./tempo.js";

export { summarizeComposition } from "./composition.js";

/**
 * High-level facade over the Resolume REST API. This is the surface tools
 * call into; it adds schema validation and helpful summaries on top of the
 * raw REST client.
 *
 * IMPORTANT: Resolume's REST API does NOT expose parameter values at deep
 * paths like `/composition/layers/1/video/opacity`. Instead, all parameter
 * mutations are PUT requests to a *parent* path with the parameter nested
 * inside the body. The convention used here:
 *
 *   PUT /composition                      with `{tempocontroller: {tempo: {value: 130}}}`
 *   PUT /composition/layers/{n}           with `{video: {opacity: {value: 0.5}}}`
 *   POST /composition/.../<action>        for action triggers (connect, select, clear)
 */
export class ResolumeClient {
  constructor(private readonly rest: ResolumeRestClient) {}

  static fromConfig(config: { host: string; port: number; timeoutMs: number }): ResolumeClient {
    const rest = new ResolumeRestClient({
      baseUrl: `http://${config.host}:${config.port}`,
      timeoutMs: config.timeoutMs,
    });
    return new ResolumeClient(rest);
  }

  // ---- Composition / state (implementations in ./composition.ts) ----

  /** Returns the full raw composition tree as Resolume serves it. */
  async getComposition(): Promise<Composition> {
    return composition.getComposition(this.rest);
  }

  /** Resolume version + product info. Returns null on Resolume builds where /product 404s. */
  async getProductInfo(): Promise<ProductInfo | null> {
    return composition.getProductInfo(this.rest);
  }

  /** Compact LLM-facing summary: version, BPM, layer/column/deck overview. */
  async getCompositionSummary(): Promise<CompositionSummary> {
    const [comp, product] = await Promise.all([
      this.getComposition(),
      this.getProductInfo(),
    ]);
    return composition.summarizeComposition(comp, product);
  }

  // ---- Clip / column / deck actions ----

  /** Connects (plays) a clip. Equivalent to clicking it in the Resolume UI. */
  async triggerClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/connect`);
  }

  /** Puts the clip under selection focus without connecting it. */
  async selectClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/select`);
  }

  /** Fires every clip in the column simultaneously across all layers. */
  async triggerColumn(column: number): Promise<void> {
    return composition.triggerColumn(this.rest, column);
  }

  /** Switches the active deck. Decks act as scene/song banks. */
  async selectDeck(deck: number): Promise<void> {
    return composition.selectDeck(this.rest, deck);
  }

  /** Disconnects all clips on the layer (layer goes black). */
  async clearLayer(layer: number): Promise<void> {
    assertIndex("layer", layer);
    await this.rest.post(`/composition/layers/${layer}/clear`);
  }

  /**
   * Empties a single clip slot — removes the loaded media so the slot is blank.
   * This is more destructive than clearLayer (which only disconnects what's
   * playing); after clearClip the slot has no source, no name, no thumbnail.
   */
  async clearClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/clear`);
  }

  /**
   * Empties every clip slot on every layer of the active composition. Returns
   * the number of slots actually cleared.
   *
   * This is the "wipe everything" button — useful when starting from a fresh
   * state, e.g. before loading a new deck or building a show from scratch.
   */
  async wipeComposition(): Promise<{ layers: number; slotsCleared: number }> {
    const composition = await this.getComposition();
    const layers = composition.layers ?? [];
    let cleared = 0;
    for (let li = 0; li < layers.length; li += 1) {
      const clips = layers[li].clips ?? [];
      for (let ci = 0; ci < clips.length; ci += 1) {
        await this.rest.post(
          `/composition/layers/${li + 1}/clips/${ci + 1}/clear`
        );
        cleared += 1;
      }
    }
    return { layers: layers.length, slotsCleared: cleared };
  }

  // ---- Layer parameters (nested PUT) ----

  /** Master opacity in 0..1. */
  async setLayerOpacity(layer: number, value: number): Promise<void> {
    assertIndex("layer", layer);
    if (value < 0 || value > 1 || Number.isNaN(value)) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "opacity",
        value,
        hint: "Opacity must be a number between 0 and 1.",
      });
    }
    await this.rest.put(`/composition/layers/${layer}`, {
      video: { opacity: { value } },
    });
  }

  /** Mute/unmute the layer (skips rendering when bypassed). */
  async setLayerBypass(layer: number, bypassed: boolean): Promise<void> {
    assertIndex("layer", layer);
    await this.rest.put(`/composition/layers/${layer}`, {
      bypassed: { value: bypassed },
    });
  }

  /** Layer blend mode (Add, Multiply, Screen, etc.). Pre-validates against live options. */
  async setLayerBlendMode(layer: number, blendMode: string): Promise<void> {
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
    const available = await this.getLayerBlendModes(layer);
    if (available.length > 0 && !available.includes(blendMode)) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "blendMode",
        value: blendMode,
        hint: `Unknown blend mode "${blendMode}". Available: ${available.slice(0, 10).join(", ")}${available.length > 10 ? `, ... (${available.length} total)` : ""}.`,
      });
    }
    await this.rest.put(`/composition/layers/${layer}`, {
      video: { mixer: { "Blend Mode": { value: blendMode } } },
    });
  }

  /** Returns the list of available blend mode names for the layer. */
  async getLayerBlendModes(layer: number): Promise<string[]> {
    assertIndex("layer", layer);
    const raw = (await this.rest.get(`/composition/layers/${layer}`)) as {
      video?: { mixer?: { "Blend Mode"?: { options?: unknown } } };
    };
    const opts = raw?.video?.mixer?.["Blend Mode"]?.options;
    if (!Array.isArray(opts)) return [];
    return opts.filter((o): o is string => typeof o === "string");
  }

  // ---- Crossfader (implementations in ./composition.ts) ----

  /** Returns the crossfader phase (-1 = full A, 0 = center, 1 = full B). */
  async getCrossfader(): Promise<{ phase: number | null }> {
    return composition.getCrossfader(this.rest);
  }

  /** Sets the crossfader phase. -1 = side A, 0 = center, 1 = side B. */
  async setCrossfader(phase: number): Promise<void> {
    return composition.setCrossfader(this.rest, phase);
  }

  // ---- Layer transition ----

  /** Sets the layer's transition duration in seconds (0..10). 0 = instant cuts. */
  async setLayerTransitionDuration(layer: number, durationSeconds: number): Promise<void> {
    assertIndex("layer", layer);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > 10) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "durationSeconds",
        value: durationSeconds,
        hint: "Layer transition duration must be 0..10 seconds.",
      });
    }
    await this.rest.put(`/composition/layers/${layer}`, {
      transition: { duration: { value: durationSeconds } },
    });
  }

  /** Returns the available transition blend modes for a layer (50+ options). */
  async getLayerTransitionBlendModes(layer: number): Promise<string[]> {
    assertIndex("layer", layer);
    const raw = (await this.rest.get(`/composition/layers/${layer}`)) as {
      transition?: { blend_mode?: { options?: unknown[] } };
    };
    const opts = raw?.transition?.blend_mode?.options;
    if (!Array.isArray(opts)) return [];
    return opts.filter((o): o is string => typeof o === "string");
  }

  /** Sets the layer's transition blend mode (the visual effect applied during clip changes). */
  async setLayerTransitionBlendMode(layer: number, blendMode: string): Promise<void> {
    assertIndex("layer", layer);
    if (typeof blendMode !== "string" || blendMode.length === 0) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "blendMode",
        value: blendMode,
        hint: "Pre-validate against the layer's transition options. List them first if unsure.",
      });
    }
    const available = await this.getLayerTransitionBlendModes(layer);
    if (available.length > 0 && !available.includes(blendMode)) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "blendMode",
        value: blendMode,
        hint: `Unknown transition blend mode "${blendMode}". Available: ${available.slice(0, 10).join(", ")}${available.length > 10 ? `, ... (${available.length} total)` : ""}.`,
      });
    }
    await this.rest.put(`/composition/layers/${layer}`, {
      transition: { blend_mode: { value: blendMode } },
    });
  }

  // ---- Tempo controller (implementations in ./tempo.ts) ----

  async getTempo(): Promise<TempoState> {
    return tempo.getTempo(this.rest);
  }

  async setTempo(bpm: number): Promise<void> {
    return tempo.setTempo(this.rest, bpm);
  }

  /** Send a single tap to the tap-tempo controller. Multiple taps in succession recalibrate Resolume's BPM. */
  async tapTempo(): Promise<void> {
    return tempo.tapTempo(this.rest);
  }

  async resyncTempo(): Promise<void> {
    return tempo.resyncTempo(this.rest);
  }

  // ---- Effects (implementations in ./effects.ts) ----

  /** Resolume full video effect catalog. Implemented in effects.ts. */
  async listVideoEffects(): Promise<EffectCatalogEntry[]> {
    return effects.listVideoEffects(this.rest);
  }

  async listLayerEffects(layer: number): Promise<Awaited<ReturnType<typeof effects.listLayerEffects>>> {
    return effects.listLayerEffects(this.rest, layer);
  }

  async setEffectParameter(layer: number, effectIndex: number, paramName: string, value: number | string | boolean): Promise<void> {
    return effects.setEffectParameter(this.rest, layer, effectIndex, paramName, value);
  }

  async addEffectToLayer(layer: number, effectName: string): Promise<void> {
    return effects.addEffectToLayer(this.rest, layer, effectName);
  }

  async removeEffectFromLayer(layer: number, effectIndex: number): Promise<void> {
    return effects.removeEffectFromLayer(this.rest, layer, effectIndex);
  }
  // ---- Composition-level beat snap (implementations in ./composition.ts) ----

  async getBeatSnap(): Promise<{ value: string | null; options: string[] }> {
    return composition.getBeatSnap(this.rest);
  }

  async setBeatSnap(value: string): Promise<void> {
    return composition.setBeatSnap(this.rest, value);
  }

  // ---- Clip transport ----

  async setClipPlayDirection(
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
    await this.rest.put(`/composition/layers/${layer}/clips/${clip}`, {
      transport: { controls: { playdirection: { value: direction } } },
    });
  }

  async setClipPlayMode(layer: number, clip: number, mode: string): Promise<void> {
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
    const layerData = (await this.rest.get(`/composition/layers/${layer}/clips/${clip}`)) as {
      transport?: {
        controls?: { playmode?: { options?: unknown[] } };
      };
    };
    const opts = layerData?.transport?.controls?.playmode?.options;
    const available = Array.isArray(opts)
      ? opts.filter((o): o is string => typeof o === "string")
      : [];
    if (available.length > 0 && !available.includes(mode)) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "mode",
        value: mode,
        hint: `Unknown play mode "${mode}". Available: ${available.join(", ")}.`,
      });
    }
    await this.rest.put(`/composition/layers/${layer}/clips/${clip}`, {
      transport: { controls: { playmode: { value: mode } } },
    });
  }

  async setClipPosition(layer: number, clip: number, position: number): Promise<void> {
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
    await this.rest.put(`/composition/layers/${layer}/clips/${clip}`, {
      transport: { position: { value: position } },
    });
  }

  // ---- Thumbnails ----

  /**
   * Returns the clip's thumbnail as base64-encoded image bytes. Resolume serves
   * thumbnails at `.../thumbnail` and ignores trailing path segments — the
   * cache-buster must be a query string.
   *
   * @param cacheBuster Internal: function returning a unique number per call
   *                    to defeat HTTP caches. Default: `Date.now`. Override
   *                    only in tests where you need a deterministic URL.
   */
  async getClipThumbnail(
    layer: number,
    clip: number,
    cacheBuster: () => number = () => Date.now()
  ): Promise<{ base64: string; mediaType: string }> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    // Resolume serves thumbnails at .../thumbnail and uses content negotiation;
    // the cache-buster is a query string, not a path segment, so it doesn't 404.
    return this.rest.getBinary(
      `/composition/layers/${layer}/clips/${clip}/thumbnail?t=${cacheBuster()}`
    );
  }
}

