import { describe, it, expect, vi } from "vitest";
import { allTools } from "./index.js";
import type { ResolumeClient } from "../resolume/client.js";

function buildCtx(overrides: Partial<ResolumeClient> = {}) {
  const client = {
    triggerColumn: vi.fn(async () => undefined),
    selectDeck: vi.fn(async () => undefined),
    setLayerBypass: vi.fn(async () => undefined),
    setLayerBlendMode: vi.fn(async () => undefined),
    getLayerBlendModes: vi.fn(async () => ["Add", "Multiply", "Screen"]),
    setTempo: vi.fn(async () => undefined),
    tapTempo: vi.fn(async () => undefined),
    getTempo: vi.fn(async () => ({ bpm: 128, min: 20, max: 500 })),
    listVideoEffects: vi.fn(async () => [
      { idstring: "A101", name: "Add Subtract" },
      { idstring: "A120", name: "Auto Mask" },
    ]),
    listLayerEffects: vi.fn(async () => [
      { id: 100, name: "Transform", params: ["Scale", "Position X"] },
    ]),
    setEffectParameter: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ResolumeClient;
  return { client, ctx: { client } };
}

function findTool(name: string) {
  const t = allTools.find((tool) => tool.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

describe("resolume_trigger_column", () => {
  it("forwards to client.triggerColumn", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_trigger_column").handler({ column: 5 }, ctx);
    expect(client.triggerColumn).toHaveBeenCalledWith(5);
  });
});

describe("resolume_select_deck", () => {
  it("forwards to client.selectDeck", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_select_deck").handler({ deck: 2 }, ctx);
    expect(client.selectDeck).toHaveBeenCalledWith(2);
  });
});

describe("resolume_set_layer_bypass", () => {
  it("forwards bypassed flag", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_set_layer_bypass").handler({ layer: 1, bypassed: true }, ctx);
    expect(client.setLayerBypass).toHaveBeenCalledWith(1, true);
  });
});

describe("resolume_set_layer_blend_mode", () => {
  it("forwards the blend mode name", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_set_layer_blend_mode").handler(
      { layer: 1, blendMode: "Multiply" },
      ctx
    );
    expect(client.setLayerBlendMode).toHaveBeenCalledWith(1, "Multiply");
  });
});

describe("resolume_list_layer_blend_modes", () => {
  it("returns the available modes", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_list_layer_blend_modes").handler({ layer: 1 }, ctx);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      blendModes: string[];
    };
    expect(parsed.blendModes).toEqual(["Add", "Multiply", "Screen"]);
  });
});

describe("resolume_set_bpm", () => {
  it("forwards bpm to client", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_set_bpm").handler({ bpm: 132 }, ctx);
    expect(client.setTempo).toHaveBeenCalledWith(132);
  });

  it("rejects bpm outside 20..500 at the schema layer", () => {
    const tool = findTool("resolume_set_bpm");
    const z = (tool.inputSchema as { bpm: { safeParse: (v: unknown) => { success: boolean } } })
      .bpm;
    expect(z.safeParse(10).success).toBe(false);
    expect(z.safeParse(600).success).toBe(false);
    expect(z.safeParse(120).success).toBe(true);
  });
});

describe("resolume_tap_tempo", () => {
  it("sends a single tap by default", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_tap_tempo").handler({ taps: 1 }, ctx);
    expect(client.tapTempo).toHaveBeenCalledTimes(1);
  });

  it("requires intervalMs when taps > 1", async () => {
    const { client, ctx } = buildCtx();
    const result = await findTool("resolume_tap_tempo").handler({ taps: 4 }, ctx);
    expect(result.isError).toBe(true);
    expect(client.tapTempo).not.toHaveBeenCalled();
  });

  it("sends multiple taps spaced by intervalMs", async () => {
    const { client, ctx } = buildCtx();
    const result = await findTool("resolume_tap_tempo").handler(
      { taps: 3, intervalMs: 100 },
      ctx
    );
    expect(client.tapTempo).toHaveBeenCalledTimes(3);
    expect(result.isError).toBeFalsy();
  });
});

describe("resolume_get_tempo", () => {
  it("returns the tempo state as JSON", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_get_tempo").handler({}, ctx);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      bpm: number;
    };
    expect(parsed.bpm).toBe(128);
  });
});

describe("resolume_list_video_effects", () => {
  it("returns the effect catalog with count", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_list_video_effects").handler({}, ctx);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      count: number;
      effects: unknown[];
    };
    expect(parsed.count).toBe(2);
    expect(parsed.effects).toHaveLength(2);
  });
});

describe("resolume_list_layer_effects", () => {
  it("returns layer effects with positional indices", async () => {
    const { ctx } = buildCtx();
    const result = await findTool("resolume_list_layer_effects").handler({ layer: 1 }, ctx);
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      effects: { effectIndex: number; name: string; params: string[] }[];
    };
    expect(parsed.effects[0]).toMatchObject({
      effectIndex: 1,
      name: "Transform",
      params: ["Scale", "Position X"],
    });
  });
});

describe("resolume_set_effect_parameter", () => {
  it("forwards layer/effectIndex/paramName/value", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_set_effect_parameter").handler(
      { layer: 1, effectIndex: 1, paramName: "Scale", value: 50 },
      ctx
    );
    expect(client.setEffectParameter).toHaveBeenCalledWith(1, 1, "Scale", 50);
  });

  it("accepts string and boolean values", async () => {
    const { client, ctx } = buildCtx();
    await findTool("resolume_set_effect_parameter").handler(
      { layer: 1, effectIndex: 1, paramName: "Mode", value: "Linear" },
      ctx
    );
    expect(client.setEffectParameter).toHaveBeenLastCalledWith(1, 1, "Mode", "Linear");
    await findTool("resolume_set_effect_parameter").handler(
      { layer: 1, effectIndex: 1, paramName: "Active", value: true },
      ctx
    );
    expect(client.setEffectParameter).toHaveBeenLastCalledWith(1, 1, "Active", true);
  });
});
