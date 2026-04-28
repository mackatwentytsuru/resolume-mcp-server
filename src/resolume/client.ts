import { ResolumeRestClient } from "./rest.js";
import type {
  Composition,
  CompositionSummary,
  ProductInfo,
  TempoState,
  EffectCatalogEntry,
} from "./types.js";
import * as clip from "./clip.js";
import * as composition from "./composition.js";
import * as effects from "./effects.js";
import * as layer from "./layer.js";
import * as tempo from "./tempo.js";
import { EffectIdCache, type EffectIdCacheOptions } from "./effect-id-cache.js";
import type { CompositionStore } from "./composition-store/store.js";

export { summarizeComposition } from "./composition.js";

/**
 * High-level facade over the Resolume REST API. Tools always go through this
 * class — the connection lifecycle (`fromConfig`), schema validation, and the
 * cross-domain `getCompositionSummary` projection live here. Domain logic
 * (per-call validation, request shape, error mapping) lives in the per-domain
 * modules under `src/resolume/`:
 *
 *   - composition.ts → reads, beat-snap, crossfader, column/deck triggers
 *   - clip.ts        → trigger/select/clear, transport, thumbnails, wipe
 *   - layer.ts       → opacity/bypass/blend mode, transition
 *   - tempo.ts       → tempo controller (BPM, tap, resync)
 *   - effects.ts     → effect catalog, parameter set, add/remove
 *
 * Each method below is a one-line delegate. New behavior should be added to
 * the relevant domain module, NOT to this facade.
 *
 * IMPORTANT: Resolume's REST API does NOT expose parameter values at deep
 * paths like `/composition/layers/1/video/opacity`. Instead, all parameter
 * mutations are PUT requests to a *parent* path with the parameter nested
 * inside the body. The convention used by the domain modules:
 *
 *   PUT /composition                with `{tempocontroller: {tempo: {value: 130}}}`
 *   PUT /composition/layers/{n}     with `{video: {opacity: {value: 0.5}}}`
 *   POST /composition/.../<action>  for action triggers (connect, select, clear)
 */
export class ResolumeClient {
  /**
   * Per-client effect-id cache. Halves request rate for `setEffectParameter`
   * by caching the result of the GET-then-PUT id resolution. Invalidated
   * synchronously by `addEffectToLayer`, `removeEffectFromLayer`,
   * `wipeComposition`, and `selectDeck`.
   */
  private readonly effectIdCache: EffectIdCache;

  /**
   * Optional CompositionStore for cache-fast read paths (v0.5.1).
   *
   * When `null`, all `*Fast` methods delegate transparently to their REST
   * counterparts so the public surface stays bit-for-bit identical to v0.5.0.
   * When non-null, methods consult `store.isFresh(...)` / `store.read*()`
   * before falling back to REST. The store is constructed and wired up by
   * `index.ts` only when `RESOLUME_CACHE` is set.
   */
  private readonly store: CompositionStore | null;

  constructor(
    private readonly rest: ResolumeRestClient,
    cacheOptions: EffectIdCacheOptions = {},
    store: CompositionStore | null = null
  ) {
    this.effectIdCache = new EffectIdCache(cacheOptions);
    this.store = store;
  }

  static fromConfig(
    config: {
      host: string;
      port: number;
      timeoutMs: number;
      effectCacheEnabled?: boolean;
    },
    store?: CompositionStore
  ): ResolumeClient {
    const rest = new ResolumeRestClient({
      baseUrl: `http://${config.host}:${config.port}`,
      timeoutMs: config.timeoutMs,
    });
    return new ResolumeClient(
      rest,
      { enabled: config.effectCacheEnabled ?? true },
      store ?? null
    );
  }

  // ---- Composition reads ----

  async getComposition(): Promise<Composition> {
    return composition.getComposition(this.rest);
  }
  async getProductInfo(): Promise<ProductInfo | null> {
    return composition.getProductInfo(this.rest);
  }
  async getCompositionSummary(): Promise<CompositionSummary> {
    const [comp, product] = await Promise.all([
      this.getComposition(),
      this.getProductInfo(),
    ]);
    return composition.summarizeComposition(comp, product);
  }

  // ---- Composition-level controls (beat snap, crossfader, column/deck) ----

  async getBeatSnap(): Promise<{ value: string | null; options: string[] }> {
    return composition.getBeatSnap(this.rest);
  }
  async setBeatSnap(value: string): Promise<void> {
    return composition.setBeatSnap(this.rest, value);
  }
  async getCrossfader(): Promise<{ phase: number | null }> {
    return composition.getCrossfader(this.rest);
  }
  async setCrossfader(phase: number): Promise<void> {
    return composition.setCrossfader(this.rest, phase);
  }
  async triggerColumn(column: number): Promise<void> {
    return composition.triggerColumn(this.rest, column);
  }
  async selectDeck(deck: number): Promise<void> {
    return composition.selectDeck(this.rest, deck, this.effectIdCache);
  }

  // ---- Clip ----

  async triggerClip(l: number, c: number): Promise<void> {
    return clip.triggerClip(this.rest, l, c);
  }
  async selectClip(l: number, c: number): Promise<void> {
    return clip.selectClip(this.rest, l, c);
  }
  async clearClip(l: number, c: number): Promise<void> {
    return clip.clearClip(this.rest, l, c);
  }
  async wipeComposition(): Promise<{ layers: number; slotsCleared: number }> {
    return clip.wipeComposition(this.rest, this.effectIdCache);
  }
  async setClipPlayDirection(
    l: number,
    c: number,
    direction: "<" | "||" | ">"
  ): Promise<void> {
    return clip.setClipPlayDirection(this.rest, l, c, direction);
  }
  async setClipPlayMode(l: number, c: number, mode: string): Promise<void> {
    return clip.setClipPlayMode(this.rest, l, c, mode);
  }
  async setClipPosition(l: number, c: number, position: number): Promise<void> {
    return clip.setClipPosition(this.rest, l, c, position);
  }
  async getClipThumbnail(
    l: number,
    c: number,
    cacheBuster: () => number = () => Date.now()
  ): Promise<{ base64: string; mediaType: string }> {
    return clip.getClipThumbnail(this.rest, l, c, cacheBuster);
  }

  // ---- Layer ----

  async clearLayer(l: number): Promise<void> {
    return layer.clearLayer(this.rest, l);
  }
  async setLayerOpacity(l: number, value: number): Promise<void> {
    return layer.setLayerOpacity(this.rest, l, value);
  }
  async setLayerBypass(l: number, bypassed: boolean): Promise<void> {
    return layer.setLayerBypass(this.rest, l, bypassed);
  }
  async setLayerBlendMode(l: number, blendMode: string): Promise<void> {
    return layer.setLayerBlendMode(this.rest, l, blendMode);
  }
  async getLayerBlendModes(l: number): Promise<string[]> {
    return layer.getLayerBlendModes(this.rest, l);
  }
  async setLayerTransitionDuration(l: number, durationSeconds: number): Promise<void> {
    return layer.setLayerTransitionDuration(this.rest, l, durationSeconds);
  }
  async getLayerTransitionBlendModes(l: number): Promise<string[]> {
    return layer.getLayerTransitionBlendModes(this.rest, l);
  }
  async setLayerTransitionBlendMode(l: number, blendMode: string): Promise<void> {
    return layer.setLayerTransitionBlendMode(this.rest, l, blendMode);
  }

  // ---- Tempo ----

  async getTempo(): Promise<TempoState> {
    return tempo.getTempo(this.rest);
  }
  async setTempo(bpm: number): Promise<void> {
    return tempo.setTempo(this.rest, bpm);
  }
  async tapTempo(): Promise<void> {
    return tempo.tapTempo(this.rest);
  }
  async resyncTempo(): Promise<void> {
    return tempo.resyncTempo(this.rest);
  }

  // ---- Effects ----

  async listVideoEffects(): Promise<EffectCatalogEntry[]> {
    return effects.listVideoEffects(this.rest);
  }
  async listLayerEffects(l: number): Promise<Awaited<ReturnType<typeof effects.listLayerEffects>>> {
    return effects.listLayerEffects(this.rest, l);
  }
  async setEffectParameter(
    l: number,
    effectIndex: number,
    paramName: string,
    value: number | string | boolean
  ): Promise<void> {
    return effects.setEffectParameter(
      this.rest,
      l,
      effectIndex,
      paramName,
      value,
      this.effectIdCache
    );
  }
  async addEffectToLayer(l: number, effectName: string): Promise<void> {
    return effects.addEffectToLayer(this.rest, l, effectName, this.effectIdCache);
  }
  async removeEffectFromLayer(l: number, effectIndex: number): Promise<void> {
    return effects.removeEffectFromLayer(this.rest, l, effectIndex, this.effectIdCache);
  }
}
