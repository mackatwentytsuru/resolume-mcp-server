import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { allTools } from "./index.js";
import type { ResolumeClient } from "../resolume/client.js";

function buildCtx(overrides: Partial<ResolumeClient> = {}) {
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
    getClipThumbnail: vi.fn(async () => ({ base64: "AAAA", mediaType: "image/png" })),
    ...overrides,
  } as unknown as ResolumeClient;
  return { client, ctx: { client } };
}

function findTool(name: string) {
  const t = allTools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

describe("tool registry", () => {
  it("registers all v0.2 tools with unique resolume_-prefixed names", () => {
    const names = allTools.map((t) => t.name);
    // 28 tools as of v0.2.5.
    expect(names.length).toBe(28);
    for (const n of names) {
      expect(n).toMatch(/^resolume_/);
    }
    expect(new Set(names).size).toBe(names.length);
    // Spot-check core tools are present.
    const expectedCore = [
      "resolume_get_composition",
      "resolume_trigger_clip",
      "resolume_set_layer_opacity",
      "resolume_set_bpm",
      "resolume_tap_tempo",
      "resolume_trigger_column",
      "resolume_select_deck",
      "resolume_set_layer_bypass",
      "resolume_set_layer_blend_mode",
      "resolume_list_video_effects",
      "resolume_set_effect_parameter",
    ];
    for (const expected of expectedCore) {
      expect(names).toContain(expected);
    }
  });

  it("every tool has a non-empty description over 40 chars (LLM context)", () => {
    for (const t of allTools) {
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("resolume_get_composition", () => {
  it("returns the summary as JSON text", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_get_composition").handler({}, ctx);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ layerCount: 1 });
  });
});

describe("resolume_trigger_clip", () => {
  it("calls the client and returns a confirmation", async () => {
    const { client, ctx } = buildCtx();
    const result = await findTool("resolume_trigger_clip").handler({ layer: 2, clip: 3 }, ctx);
    expect(client.triggerClip).toHaveBeenCalledWith(2, 3);
    expect((result.content[0] as { text: string }).text).toContain("layer=2");
  });

  it("rejects non-positive indices via schema", () => {
    const tool = findTool("resolume_trigger_clip");
    const parsed = z.object(tool.inputSchema).safeParse({ layer: 0, clip: 1 });
    expect(parsed.success).toBe(false);
  });
});

describe("resolume_set_layer_opacity", () => {
  it("rejects opacity > 1 at the schema boundary", () => {
    const tool = findTool("resolume_set_layer_opacity");
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ layer: 1, opacity: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ layer: 1, opacity: 0.5 }).success).toBe(true);
  });

  it("forwards to client", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_set_layer_opacity").handler({ layer: 1, opacity: 0.5 }, ctx);
    expect(client.setLayerOpacity).toHaveBeenCalledWith(1, 0.5);
  });
});

describe("resolume_clear_layer", () => {
  it("refuses without confirm=true", async () => {
    const { client, ctx } = buildCtx();
    const result = await findTool("resolume_clear_layer").handler(
      { layer: 1, confirm: false },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(client.clearLayer).not.toHaveBeenCalled();
  });

  it("clears with confirm=true", async () => {
    const { client, ctx } = buildCtx();
    const result = await findTool("resolume_clear_layer").handler(
      { layer: 4, confirm: true },
      ctx
    );
    expect(client.clearLayer).toHaveBeenCalledWith(4);
    expect(result.isError).toBeFalsy();
  });
});

describe("resolume_get_clip_thumbnail", () => {
  it("returns image content alongside text label", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_get_clip_thumbnail").handler(
      { layer: 1, clip: 2 },
      ctx
    );
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
});

describe("resolume_select_clip", () => {
  it("forwards to client", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_select_clip").handler({ layer: 2, clip: 5 }, ctx);
    expect(client.selectClip).toHaveBeenCalledWith(2, 5);
  });
});
