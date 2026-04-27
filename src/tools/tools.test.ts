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

function findTool(name: string) {
  const t = allTools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

describe("tool registry", () => {
  it("registers all v0.4 tools with unique resolume_-prefixed names", () => {
    const names = allTools.map((t) => t.name);
    // 36 tools as of v0.4 (added 4 OSC tools).
    expect(names.length).toBe(36);
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
      "resolume_add_effect_to_layer",
      "resolume_remove_effect_from_layer",
      "resolume_osc_send",
      "resolume_osc_query",
      "resolume_osc_subscribe",
      "resolume_osc_status",
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

// Mock the OSC client so tool tests exercise their handler paths without
// touching real UDP. Each function returns deterministic data; the tool
// layer's job is to convert handler args → client calls → ToolResult.
vi.mock("../resolume/osc-client.js", () => ({
  sendOsc: vi.fn(async () => undefined),
  queryOsc: vi.fn(async () => [
    { address: "/composition/master", args: [0.5], timestamp: 1700000000000 },
  ]),
  subscribeOsc: vi.fn(async () => [
    { address: "/composition/layers/1/transport/position", args: [0.25], timestamp: 1700000000001 },
    { address: "/composition/layers/2/transport/position", args: [0.75], timestamp: 1700000000002 },
  ]),
  probeOscStatus: vi.fn(async () => ({ reachable: true, lastReceived: 1700000000003 })),
}));

describe("OSC tools", () => {
  const oscCtx = {
    client: {} as unknown as ResolumeClient,
    osc: { host: "127.0.0.1", inPort: 7000, outPort: 7001 },
  };

  it("resolume_osc_send returns InvalidArguments-style error when address omits leading slash", () => {
    const tool = findTool("resolume_osc_send");
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ address: "no-slash", args: [] }).success).toBe(false);
    expect(schema.safeParse({ address: "/foo", args: [1, "x", true] }).success).toBe(true);
  });

  it("resolume_osc_send errors when osc config absent", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_osc_send").handler(
      { address: "/foo", args: [] },
      ctx
    );
    expect(result.isError).toBe(true);
  });

  it("resolume_osc_send forwards to client when osc config present", async () => {
    const { sendOsc } = await import("../resolume/osc-client.js");
    const result = await findTool("resolume_osc_send").handler(
      { address: "/composition/tempocontroller/resync", args: [] },
      oscCtx
    );
    expect(result.isError).toBeFalsy();
    expect(sendOsc).toHaveBeenCalledWith(
      "127.0.0.1",
      7000,
      "/composition/tempocontroller/resync",
      []
    );
  });

  it("resolume_osc_query rejects bad addresses and accepts wildcards", () => {
    const tool = findTool("resolume_osc_query");
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ address: "" }).success).toBe(false);
    expect(schema.safeParse({ address: "/composition/layers/*/name" }).success).toBe(true);
  });

  it("resolume_osc_query returns the mocked messages and count", async () => {
    const result = await findTool("resolume_osc_query").handler(
      { address: "/composition/master", timeoutMs: 100 },
      oscCtx
    );
    expect(result.isError).toBeFalsy();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(1);
    expect(json.messages[0].address).toBe("/composition/master");
  });

  it("resolume_osc_query errors when osc config absent", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_osc_query").handler(
      { address: "/x", timeoutMs: 100 },
      ctx
    );
    expect(result.isError).toBe(true);
  });

  it("resolume_osc_subscribe enforces duration bounds", () => {
    const tool = findTool("resolume_osc_subscribe");
    const schema = z.object(tool.inputSchema);
    expect(schema.safeParse({ addressPattern: "/foo/*", durationMs: 0 }).success).toBe(false);
    expect(schema.safeParse({ addressPattern: "/foo/*", durationMs: 999_999 }).success).toBe(false);
    expect(schema.safeParse({ addressPattern: "/foo/*", durationMs: 500 }).success).toBe(true);
  });

  it("resolume_osc_subscribe returns matched messages with timestamps", async () => {
    const result = await findTool("resolume_osc_subscribe").handler(
      {
        addressPattern: "/composition/layers/*/transport/position",
        durationMs: 200,
        maxMessages: 50,
      },
      oscCtx
    );
    expect(result.isError).toBeFalsy();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(2);
    expect(json.messages[0].timestamp).toBeTypeOf("number");
  });

  it("resolume_osc_subscribe errors when osc config absent", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_osc_subscribe").handler(
      { addressPattern: "/foo/*", durationMs: 100, maxMessages: 50 },
      ctx
    );
    expect(result.isError).toBe(true);
  });

  it("resolume_osc_status returns reachable=true and config", async () => {
    const result = await findTool("resolume_osc_status").handler({}, oscCtx);
    expect(result.isError).toBeFalsy();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.reachable).toBe(true);
    expect(json.inPort).toBe(7000);
    expect(json.outPort).toBe(7001);
  });

  it("resolume_osc_status errors when osc config absent", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_osc_status").handler({}, ctx);
    expect(result.isError).toBe(true);
  });
});
