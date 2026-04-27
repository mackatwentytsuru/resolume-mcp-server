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

  async getComposition(): Promise<Composition> {
    const raw = await this.rest.get("/composition");
    return CompositionSchema.parse(raw);
  }

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

  async getCompositionSummary(): Promise<CompositionSummary> {
    const [composition, product] = await Promise.all([
      this.getComposition(),
      this.getProductInfo(),
    ]);
    return summarizeComposition(composition, product);
  }

  // ---- Clip / column / deck actions ----

  async triggerClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/connect`);
  }

  async selectClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/select`);
  }

  async triggerColumn(column: number): Promise<void> {
    assertIndex("column", column);
    await this.rest.post(`/composition/columns/${column}/connect`);
  }

  async selectDeck(deck: number): Promise<void> {
    assertIndex("deck", deck);
    await this.rest.post(`/composition/decks/${deck}/select`);
  }

  async clearLayer(layer: number): Promise<void> {
    assertIndex("layer", layer);
    await this.rest.post(`/composition/layers/${layer}/clear`);
  }

  // ---- Layer parameters (nested PUT) ----

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

  async setLayerBypass(layer: number, bypassed: boolean): Promise<void> {
    assertIndex("layer", layer);
    await this.rest.put(`/composition/layers/${layer}`, {
      bypassed: { value: bypassed },
    });
  }

  async setLayerBlendMode(layer: number, blendMode: string): Promise<void> {
    assertIndex("layer", layer);
    if (typeof blendMode !== "string" || blendMode.length === 0) {
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: "blendMode",
        value: blendMode,
        hint: "blendMode must be a non-empty string. Use resolume_get_layer_blend_modes to list options.",
      });
    }
    await this.rest.put(`/composition/layers/${layer}`, {
      video: { mixer: { "Blend Mode": { value: blendMode } } },
    });
  }

  async getLayerBlendModes(layer: number): Promise<string[]> {
    assertIndex("layer", layer);
    const raw = (await this.rest.get(`/composition/layers/${layer}`)) as {
      video?: { mixer?: { "Blend Mode"?: { options?: unknown } } };
    };
    const opts = raw?.video?.mixer?.["Blend Mode"]?.options;
    if (!Array.isArray(opts)) return [];
    return opts.filter((o): o is string => typeof o === "string");
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
  ): Promise<Array<{ id: number; name: string; params: string[] }>> {
    assertIndex("layer", layer);
    const raw = (await this.rest.get(`/composition/layers/${layer}`)) as {
      video?: { effects?: Array<{ id?: number; name?: string; params?: Record<string, unknown> }> };
    };
    const effects = raw?.video?.effects ?? [];
    return effects.map((e) => ({
      id: typeof e.id === "number" ? e.id : 0,
      name: typeof e.name === "string" ? e.name : "",
      params: e.params ? Object.keys(e.params) : [],
    }));
  }

  /**
   * Set a parameter on an existing effect attached to a layer.
   * `effectIndex` is 1-based across `layer.video.effects`.
   * `paramName` is the human-readable parameter name (e.g. "Scale", "Position X").
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
        what: "clip", // closest existing kind; effect index isn't its own kind yet
        index: effectIndex,
        hint: "effectIndex is the 1-based position of the effect on the layer. Call resolume_list_layer_effects to enumerate.",
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
    // Build the nested PUT body. We need to pad the effects array up to effectIndex.
    const effects: Array<Record<string, unknown>> = [];
    for (let i = 0; i < effectIndex - 1; i += 1) effects.push({});
    effects.push({ params: { [paramName]: { value } } });
    await this.rest.put(`/composition/layers/${layer}`, {
      video: { effects },
    });
  }

  // ---- Thumbnails ----

  async getClipThumbnail(
    layer: number,
    clip: number,
    cacheBuster: () => number = () => Date.now()
  ): Promise<{ base64: string; mediaType: string }> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    return this.rest.getBinary(
      `/composition/layers/${layer}/clips/${clip}/thumbnail/${cacheBuster()}`
    );
  }
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
