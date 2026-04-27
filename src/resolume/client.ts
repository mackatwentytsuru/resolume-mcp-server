import { ResolumeRestClient } from "./rest.js";
import {
  CompositionSchema,
  ProductInfoSchema,
  type Composition,
  type CompositionSummary,
  type ProductInfo,
  type TempoState,
  type EffectCatalogEntry,
} from "./types.js";
import { ResolumeApiError } from "../errors/types.js";

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

  // ---- Composition / state ----

  /** Returns the full raw composition tree as Resolume serves it. */
  async getComposition(): Promise<Composition> {
    const raw = await this.rest.get("/composition");
    return CompositionSchema.parse(raw);
  }

  /** Resolume version + product info. Returns null on Resolume builds where /product 404s. */
  async getProductInfo(): Promise<ProductInfo | null> {
    try {
      const raw = await this.rest.get("/product");
      return ProductInfoSchema.parse(raw);
    } catch (err) {
      if (err instanceof ResolumeApiError && err.detail.kind === "NotFound") {
        return null;
      }
      throw err;
    }
  }

  /** Compact LLM-facing summary: version, BPM, layer/column/deck overview. */
  async getCompositionSummary(): Promise<CompositionSummary> {
    const [composition, product] = await Promise.all([
      this.getComposition(),
      this.getProductInfo(),
    ]);
    return summarizeComposition(composition, product);
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
    assertIndex("column", column);
    await this.rest.post(`/composition/columns/${column}/connect`);
  }

  /** Switches the active deck. Decks act as scene/song banks. */
  async selectDeck(deck: number): Promise<void> {
    assertIndex("deck", deck);
    await this.rest.post(`/composition/decks/${deck}/select`);
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

  // ---- Crossfader ----

  /** Returns the crossfader phase (-1 = full A, 0 = center, 1 = full B). */
  async getCrossfader(): Promise<{ phase: number | null }> {
    const composition = await this.getComposition();
    const cf = composition.crossfader as { phase?: { value?: unknown } } | undefined;
    const v = cf?.phase?.value;
    return { phase: typeof v === "number" ? v : null };
  }

  /** Sets the crossfader phase. -1 = side A, 0 = center, 1 = side B. */
  async setCrossfader(phase: number): Promise<void> {
    if (!Number.isFinite(phase) || phase < -1 || phase > 1) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "phase",
        value: phase,
        hint: "Crossfader phase must be a number in -1..1 (-1 = side A, 0 = center, 1 = side B).",
      });
    }
    await this.rest.put("/composition", {
      crossfader: { phase: { value: phase } },
    });
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

  // ---- Tempo controller ----

  async getTempo(): Promise<TempoState> {
    const composition = await this.getComposition();
    const tc = composition.tempocontroller as
      | { tempo?: { value?: unknown; min?: number; max?: number } }
      | undefined;
    const value = tc?.tempo?.value;
    return {
      bpm: typeof value === "number" ? value : null,
      min: typeof tc?.tempo?.min === "number" ? tc.tempo.min : null,
      max: typeof tc?.tempo?.max === "number" ? tc.tempo.max : null,
    };
  }

  async setTempo(bpm: number): Promise<void> {
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 500) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "bpm",
        value: bpm,
        hint: "BPM must be between 20 and 500 (Resolume's accepted range).",
      });
    }
    await this.rest.put("/composition", {
      tempocontroller: { tempo: { value: bpm } },
    });
  }

  /** Send a single tap to the tap-tempo controller. Multiple taps in succession recalibrate Resolume's BPM. */
  async tapTempo(): Promise<void> {
    await this.rest.put("/composition", {
      tempocontroller: { tempo_tap: { value: true } },
    });
  }

  async resyncTempo(): Promise<void> {
    await this.rest.put("/composition", {
      tempocontroller: { resync: { value: true } },
    });
  }

  // ---- Effects ----

  /** Resolume's full video effect catalog (~100 entries). */
  async listVideoEffects(): Promise<EffectCatalogEntry[]> {
    const raw = (await this.rest.get("/effects/video")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e): e is { idstring?: string; name?: string } => typeof e === "object" && e !== null)
      .map((e) => ({
        idstring: typeof e.idstring === "string" ? e.idstring : "",
        name: typeof e.name === "string" ? e.name : "",
      }))
      .filter((e) => e.idstring && e.name);
  }

  async listLayerEffects(
    layer: number
  ): Promise<
    Array<{
      id: number;
      name: string;
      /** Detailed parameter info: name, type, current value, range when applicable. */
      params: Array<{
        name: string;
        valuetype: string | null;
        value: number | string | boolean | null;
        min?: number;
        max?: number;
        options?: string[];
      }>;
    }>
  > {
    assertIndex("layer", layer);
    const raw = (await this.rest.get(`/composition/layers/${layer}`)) as {
      video?: {
        effects?: Array<{
          id?: number;
          name?: string;
          params?: Record<
            string,
            {
              valuetype?: string;
              value?: unknown;
              min?: number;
              max?: number;
              options?: unknown[];
            }
          >;
        }>;
      };
    };
    const effects = raw?.video?.effects ?? [];
    return effects.map((e) => ({
      id: typeof e.id === "number" ? e.id : 0,
      name: typeof e.name === "string" ? e.name : "",
      params: e.params
        ? Object.entries(e.params).map(([name, p]) => {
            const v = p?.value;
            const valueOut: number | string | boolean | null =
              typeof v === "number" || typeof v === "string" || typeof v === "boolean"
                ? v
                : null;
            const out: {
              name: string;
              valuetype: string | null;
              value: number | string | boolean | null;
              min?: number;
              max?: number;
              options?: string[];
            } = {
              name,
              valuetype: p?.valuetype ?? null,
              value: valueOut,
            };
            if (typeof p?.min === "number") out.min = p.min;
            if (typeof p?.max === "number") out.max = p.max;
            if (Array.isArray(p?.options)) {
              out.options = p.options.filter((o): o is string => typeof o === "string");
            }
            return out;
          })
        : [],
    }));
  }

  /**
   * Set a parameter on an existing effect attached to a layer.
   * `effectIndex` is 1-based across `layer.video.effects`.
   * `paramName` is the human-readable parameter name (e.g. "Scale", "Position X").
   *
   * Resolume's nested-PUT requires the target effect's `id` to identify which
   * entry in the array to mutate; without it, Resolume silently no-ops.
   * We fetch the layer, locate the effect by 1-based index, and include the id.
   */
  async setEffectParameter(
    layer: number,
    effectIndex: number,
    paramName: string,
    value: number | string | boolean
  ): Promise<void> {
    assertIndex("layer", layer);
    if (!Number.isInteger(effectIndex) || effectIndex < 1) {
      throw new ResolumeApiError({
        kind: "InvalidIndex",
        what: "effect",
        index: effectIndex,
        hint: "effectIndex is the 1-based position of the effect on the layer. List the layer's effects to enumerate.",
      });
    }
    if (typeof paramName !== "string" || paramName.length === 0) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "paramName",
        value: paramName,
        hint: "paramName must match the effect's parameter name exactly (e.g. 'Scale').",
      });
    }

    const rawLayer = (await this.rest.get(`/composition/layers/${layer}`)) as {
      video?: {
        effects?: Array<{
          id?: number;
          params?: Record<string, { valuetype?: string } | undefined>;
        }>;
      };
    };
    const effects = rawLayer?.video?.effects ?? [];
    const target = effects[effectIndex - 1];
    if (!target) {
      throw new ResolumeApiError({
        kind: "InvalidIndex",
        what: "effect",
        index: effectIndex,
        hint: `Layer ${layer} has only ${effects.length} effect(s). List the layer's effects first.`,
      });
    }
    if (typeof target.id !== "number") {
      throw new ResolumeApiError({
        kind: "Unknown",
        message: `Effect at index ${effectIndex} on layer ${layer} has no id.`,
        hint: "This is unexpected — try a different effect or reload the composition.",
      });
    }
    // Use own-property lookup so inherited names like "__proto__" or "constructor"
    // are not falsely accepted via the prototype chain (silent no-op on Resolume).
    if (
      !target.params ||
      !Object.prototype.hasOwnProperty.call(target.params, paramName)
    ) {
      const known = target.params ? Object.keys(target.params) : [];
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "paramName",
        value: paramName,
        hint: `Effect has no parameter named "${paramName}". Available: ${known.join(", ") || "(none)"}.`,
      });
    }

    // Resolume silently rejects type-mismatched values (e.g. string "175" for a
    // ParamRange) — the API returns 204 but ignores the change. Coerce based on
    // the parameter's declared valuetype so the LLM doesn't have to care about
    // exact JSON types when passing values through MCP wire encoding.
    const valuetype = target.params[paramName]?.valuetype;
    const coerced = coerceParamValue(value, valuetype, paramName);

    const body: Array<Record<string, unknown>> = [];
    for (let i = 0; i < effectIndex - 1; i += 1) body.push({});
    body.push({ id: target.id, params: { [paramName]: { value: coerced } } });
    await this.rest.put(`/composition/layers/${layer}`, {
      video: { effects: body },
    });
  }

  /**
   * Adds a video effect to a layer. The body Resolume expects is a *drag-drop
   * URI string* of the form `effect:///video/{EffectName}` — not JSON, not the
   * effect's `idstring`. The endpoint is `POST /composition/layers/{N}/effects/video/add`
   * with `Content-Type: text/plain`. Resolume returns 204 on success.
   *
   * `effectName` is the human-readable name (e.g. `"Blur"`, `"Hue Rotate"`) as
   * reported by the `/effects/video` catalog. Spaces are URL-safe in the URI
   * Resolume parses, so we leave them as-is.
   */
  async addEffectToLayer(layer: number, effectName: string): Promise<void> {
    assertIndex("layer", layer);
    if (typeof effectName !== "string" || effectName.trim().length === 0) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "effectName",
        value: effectName,
        hint: 'effectName must be a non-empty string like "Blur" or "Hue Rotate". Use resolume_list_video_effects to enumerate.',
      });
    }
    const trimmed = effectName.trim();
    // URL-encode the effect name so names with special characters (e.g. spaces,
    // parentheses) are transmitted correctly. Live-verified: Resolume's drag-drop
    // URI parser accepts percent-encoded names produced by encodeURIComponent.
    await this.rest.postText(
      `/composition/layers/${layer}/effects/video/add`,
      `effect:///video/${encodeURIComponent(trimmed)}`
    );
  }

  /**
   * Removes a video effect from a layer by its 1-based position. Resolume's
   * REST DELETE endpoint uses 0-based array indices, but we keep the public
   * API 1-based to stay consistent with the rest of the tool surface.
   *
   * Note: removing the built-in `Transform` effect (always at index 1) is
   * generally a bad idea — Resolume usually pre-installs it. We surface the
   * user's choice to them rather than blocking it.
   */
  async removeEffectFromLayer(layer: number, effectIndex: number): Promise<void> {
    assertIndex("layer", layer);
    if (!Number.isInteger(effectIndex) || effectIndex < 1) {
      throw new ResolumeApiError({
        kind: "InvalidIndex",
        what: "effect",
        index: effectIndex,
        hint: "effectIndex is the 1-based position of the effect on the layer. Call resolume_list_layer_effects first.",
      });
    }
    // Verify the index exists so we return a structured error instead of a 404.
    const existing = await this.listLayerEffects(layer);
    if (effectIndex > existing.length) {
      throw new ResolumeApiError({
        kind: "InvalidIndex",
        what: "effect",
        index: effectIndex,
        hint: `Layer ${layer} has only ${existing.length} effect(s). Call resolume_list_layer_effects to enumerate.`,
      });
    }
    const zeroBased = effectIndex - 1;
    await this.rest.delete(
      `/composition/layers/${layer}/effects/video/${zeroBased}`
    );
  }

  // ---- Composition-level beat snap / trigger style ----

  async getBeatSnap(): Promise<{ value: string | null; options: string[] }> {
    const composition = await this.getComposition();
    const cbs = composition.clipbeatsnap as { value?: unknown; options?: unknown[] } | undefined;
    const value = typeof cbs?.value === "string" ? cbs.value : null;
    const options = Array.isArray(cbs?.options)
      ? cbs.options.filter((o): o is string => typeof o === "string")
      : [];
    return { value, options };
  }

  async setBeatSnap(value: string): Promise<void> {
    if (typeof value !== "string" || value.length === 0) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "beatSnap",
        value,
        hint: "beatSnap must be a non-empty string. Call resolume_get_beat_snap to enumerate options.",
      });
    }
    const { options } = await this.getBeatSnap();
    if (options.length > 0 && !options.includes(value)) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "beatSnap",
        value,
        hint: `Unknown beat snap "${value}". Available: ${options.join(", ")}.`,
      });
    }
    await this.rest.put("/composition", {
      clipbeatsnap: { value },
    });
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

/**
 * Coerce an LLM-supplied parameter value to the type Resolume expects for the
 * given valuetype. Without this, e.g. `value: "175"` for a ParamRange would be
 * silently ignored (Resolume returns 204 but doesn't apply the change).
 */
export function coerceParamValue(
  value: number | string | boolean,
  valuetype: string | undefined,
  paramName: string
): number | string | boolean {
  if (!valuetype) return value;

  const numericTypes = new Set(["ParamRange", "ParamNumber", "ParamFloat", "ParamInt"]);
  const booleanTypes = new Set(["ParamBoolean"]);
  const stringTypes = new Set(["ParamChoice", "ParamString", "ParamText"]);

  if (numericTypes.has(valuetype)) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: paramName,
        value,
        hint: `Parameter "${paramName}" is ${valuetype} (numeric); value must be a number, got "${value}".`,
      });
    }
    if (typeof value === "boolean") return value ? 1 : 0;
  }

  if (booleanTypes.has(valuetype)) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: paramName,
      value,
      hint: `Parameter "${paramName}" is ${valuetype}; value must be true, false, 0, 1, "true", or "false". Got ${typeof value === "string" ? `"${value}"` : String(value)}.`,
    });
  }

  if (stringTypes.has(valuetype)) {
    return String(value);
  }

  // Unknown type — pass through unchanged.
  return value;
}

function assertIndex(what: "layer" | "column" | "clip" | "deck", n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new ResolumeApiError({
      kind: "InvalidIndex",
      what,
      index: n,
      hint: `${what} indices are 1-based positive integers. Call resolume_get_composition to list valid ranges.`,
    });
  }
}

export function summarizeComposition(
  composition: Composition,
  product: ProductInfo | null
): CompositionSummary {
  const layers = composition.layers ?? [];
  const columns = composition.columns ?? [];
  const decks = composition.decks ?? [];
  const tc = composition.tempocontroller as
    | { tempo?: { value?: unknown } }
    | undefined;
  const bpmValue = tc?.tempo?.value;

  return {
    productVersion: product
      ? [product.major, product.minor, product.micro, product.revision]
          .filter((x) => x !== undefined)
          .join(".") || null
      : null,
    bpm: typeof bpmValue === "number" ? bpmValue : null,
    layerCount: layers.length,
    columnCount: columns.length,
    deckCount: decks.length,
    layers: layers.map((layer, idx) => {
      const clips = layer.clips ?? [];
      const connected = clips.findIndex((c) => extractValue(c.connected) === "Connected");
      return {
        index: idx + 1,
        name: extractName(layer.name) ?? `Layer ${idx + 1}`,
        clipCount: clips.length,
        connectedClip: connected >= 0 ? connected + 1 : null,
        bypassed: extractValue(layer.bypassed) === true,
      };
    }),
    columns: columns.map((column, idx) => ({
      index: idx + 1,
      name: extractName(column.name) ?? `Column ${idx + 1}`,
    })),
    decks: decks.map((deck, idx) => ({
      index: idx + 1,
      name: extractName(deck.name) ?? `Deck ${idx + 1}`,
      selected: extractValue(deck.selected) === true,
    })),
  };
}

function extractName(p: { value?: unknown } | undefined): string | null {
  if (!p) return null;
  const v = p.value;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extractValue(p: { value?: unknown } | undefined): unknown {
  return p?.value;
}
