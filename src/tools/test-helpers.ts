import { vi } from "vitest";
import type { ResolumeClient } from "../resolume/client.js";
import type { ToolContext } from "./types.js";

/**
 * Shared test factory — creates a fully-mocked ResolumeClient and a ToolContext
 * wrapping it. Pass partial overrides to stub specific methods differently.
 */
export function buildCtx(overrides: Partial<ResolumeClient> = {}) {
  const client = {
    getCompositionSummary: vi.fn(async () => ({
      productVersion: "7.20.0",
      bpm: 128,
      layerCount: 1,
      columnCount: 1,
      deckCount: 0,
      layers: [{ index: 1, name: "L1", clipCount: 1, connectedClip: null, bypassed: false }],
      columns: [{ index: 1, name: "C1" }],
      decks: [],
    })),
    triggerClip: vi.fn(async () => undefined),
    selectClip: vi.fn(async () => undefined),
    triggerColumn: vi.fn(async () => undefined),
    setClipPlayDirection: vi.fn(async () => undefined),
    setClipPlayMode: vi.fn(async () => undefined),
    setClipPosition: vi.fn(async () => undefined),
    clearClip: vi.fn(async () => undefined),
    wipeComposition: vi.fn(async () => ({ layers: 3, slotsCleared: 27 })),
    getBeatSnap: vi.fn(async () => ({ value: "1 Bar", options: ["None", "1 Bar", "1/2 Bar"] })),
    setBeatSnap: vi.fn(async () => undefined),
    selectDeck: vi.fn(async () => undefined),
    clearLayer: vi.fn(async () => undefined),
    setLayerOpacity: vi.fn(async () => undefined),
    setLayerBypass: vi.fn(async () => undefined),
    setLayerBlendMode: vi.fn(async () => undefined),
    getLayerBlendModes: vi.fn(async () => ["Add", "Multiply"]),
    setLayerTransitionDuration: vi.fn(async () => undefined),
    setLayerTransitionBlendMode: vi.fn(async () => undefined),
    getLayerTransitionBlendModes: vi.fn(async () => ["Alpha", "Wipe Ellipse"]),
    getCrossfader: vi.fn(async () => ({ phase: 0 })),
    setCrossfader: vi.fn(async () => undefined),
    setTempo: vi.fn(async () => undefined),
    tapTempo: vi.fn(async () => undefined),
    resyncTempo: vi.fn(async () => undefined),
    getTempo: vi.fn(async () => ({ bpm: 128, min: 20, max: 500 })),
    listVideoEffects: vi.fn(async () => [{ idstring: "A101", name: "Add Subtract" }]),
    listLayerEffects: vi.fn(async () => [
      {
        id: 1,
        name: "Transform",
        params: [{ name: "Scale", valuetype: "ParamRange", value: 100, min: 0, max: 1000 }],
      },
    ]),
    setEffectParameter: vi.fn(async () => undefined),
    addEffectToLayer: vi.fn(async () => undefined),
    removeEffectFromLayer: vi.fn(async () => undefined),
    getClipThumbnail: vi.fn(async () => ({ base64: "AAAA", mediaType: "image/png" })),
    ...overrides,
  } as unknown as ResolumeClient;
  return { client, ctx: { client } };
}
