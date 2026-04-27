/**
 * Composition-level reads and global controls extracted from ResolumeClient.
 *
 * "Composition" here is Resolume's term for the top-level project: tempo
 * controller, decks, columns, layers, crossfader, beat-snap. Everything in
 * this module either reads from `/composition` or PUTs a top-level field on
 * the composition envelope.
 *
 * Column trigger and deck select are one-shot POSTs that don't justify their
 * own files, so they live here too — they target columns/decks which are
 * composition-scope objects.
 */

import { ResolumeRestClient } from "./rest.js";
import {
  CompositionSchema,
  ProductInfoSchema,
  type Composition,
  type CompositionSummary,
  type ProductInfo,
} from "./types.js";
import { ResolumeApiError } from "../errors/types.js";
import {
  assertIndex,
  extractName,
  extractValue,
  filterStringOptions,
} from "./shared.js";
import type { EffectIdCache } from "./effect-id-cache.js";

// ---- Reads ----

/** Returns the full raw composition tree as Resolume serves it. */
export async function getComposition(rest: ResolumeRestClient): Promise<Composition> {
  const raw = await rest.get("/composition");
  return CompositionSchema.parse(raw);
}

/**
 * Resolume version + product info. Returns null on Resolume builds where
 * /product 404s (older 7.x).
 */
export async function getProductInfo(rest: ResolumeRestClient): Promise<ProductInfo | null> {
  try {
    const raw = await rest.get("/product");
    return ProductInfoSchema.parse(raw);
  } catch (err) {
    if (err instanceof ResolumeApiError && err.detail.kind === "NotFound") {
      return null;
    }
    throw err;
  }
}

/**
 * Compact LLM-facing projection of the composition tree: version, BPM, and
 * per-layer / per-column / per-deck overviews. Pure — does not perform IO.
 */
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

// ---- Beat snap (composition-scope) ----

export async function getBeatSnap(
  rest: ResolumeRestClient
): Promise<{ value: string | null; options: string[] }> {
  const composition = await getComposition(rest);
  const cbs = composition.clipbeatsnap as { value?: unknown; options?: unknown[] } | undefined;
  const value = typeof cbs?.value === "string" ? cbs.value : null;
  const options = filterStringOptions(cbs?.options);
  return { value, options };
}

export async function setBeatSnap(rest: ResolumeRestClient, value: string): Promise<void> {
  if (typeof value !== "string" || value.length === 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "beatSnap",
      value,
      hint: "beatSnap must be a non-empty string. Call resolume_get_beat_snap to enumerate options.",
    });
  }
  const { options } = await getBeatSnap(rest);
  if (options.length > 0 && !options.includes(value)) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "beatSnap",
      value,
      hint: `Unknown beat snap "${value}". Available: ${options.join(", ")}.`,
    });
  }
  await rest.put("/composition", {
    clipbeatsnap: { value },
  });
}

// ---- Crossfader ----

/** Returns the crossfader phase (-1 = full A, 0 = center, 1 = full B). */
export async function getCrossfader(
  rest: ResolumeRestClient
): Promise<{ phase: number | null }> {
  const composition = await getComposition(rest);
  const cf = composition.crossfader as { phase?: { value?: unknown } } | undefined;
  const v = cf?.phase?.value;
  return { phase: typeof v === "number" ? v : null };
}

/** Sets the crossfader phase. -1 = side A, 0 = center, 1 = side B. */
export async function setCrossfader(rest: ResolumeRestClient, phase: number): Promise<void> {
  if (!Number.isFinite(phase) || phase < -1 || phase > 1) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "phase",
      value: phase,
      hint: "Crossfader phase must be a number in -1..1 (-1 = side A, 0 = center, 1 = side B).",
    });
  }
  await rest.put("/composition", {
    crossfader: { phase: { value: phase } },
  });
}

// ---- Column / deck (composition-scope POSTs) ----

/** Fires every clip in the column simultaneously across all layers. */
export async function triggerColumn(rest: ResolumeRestClient, column: number): Promise<void> {
  assertIndex("column", column);
  await rest.post(`/composition/columns/${column}/connect`);
}

/** Switches the active deck. Decks act as scene/song banks. */
export async function selectDeck(
  rest: ResolumeRestClient,
  deck: number,
  cache?: EffectIdCache
): Promise<void> {
  assertIndex("deck", deck);
  await rest.post(`/composition/decks/${deck}/select`);
  // Switching decks reloads the layer set — every cached effect id is now
  // potentially attached to a different effect (or no effect at all).
  // Drop everything.
  cache?.clearAll();
}
