import { ResolumeRestClient } from "./rest.js";
import {
  CompositionSchema,
  ProductInfoSchema,
  type Composition,
  type CompositionSummary,
  type ProductInfo,
} from "./types.js";
import { ResolumeApiError } from "../errors/types.js";

/**
 * High-level facade over the Resolume REST API. This is the surface tools
 * call into; it adds schema validation and helpful summaries on top of the
 * raw REST client.
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

  async getComposition(): Promise<Composition> {
    const raw = await this.rest.get("/composition");
    return CompositionSchema.parse(raw);
  }

  async getProductInfo(): Promise<ProductInfo | null> {
    try {
      const raw = await this.rest.get("/product");
      return ProductInfoSchema.parse(raw);
    } catch (err) {
      // /product is recent; older Resolume versions may 404. That's not fatal.
      if (err instanceof ResolumeApiError && err.detail.kind === "NotFound") {
        return null;
      }
      throw err;
    }
  }

  /** Returns the summary view used as primary AI context. */
  async getCompositionSummary(): Promise<CompositionSummary> {
    const [composition, product] = await Promise.all([
      this.getComposition(),
      this.getProductInfo(),
    ]);
    return summarizeComposition(composition, product);
  }

  async triggerClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    // Setting `connected` to "Connected" triggers the clip without restart.
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/connect`);
  }

  async selectClip(layer: number, clip: number): Promise<void> {
    assertIndex("layer", layer);
    assertIndex("clip", clip);
    await this.rest.post(`/composition/layers/${layer}/clips/${clip}/select`);
  }

  async clearLayer(layer: number): Promise<void> {
    assertIndex("layer", layer);
    await this.rest.post(`/composition/layers/${layer}/clear`);
  }

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
    await this.rest.put(`/composition/layers/${layer}/video/opacity`, { value });
  }

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

  return {
    productVersion: product
      ? [product.major, product.minor, product.micro, product.revision]
          .filter((x) => x !== undefined)
          .join(".") || null
      : null,
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
