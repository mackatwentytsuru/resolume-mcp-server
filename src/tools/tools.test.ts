import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { allTools } from "./index.js";
import type { ResolumeClient } from "../resolume/client.js";

function buildCtx(overrides: Partial<ResolumeClient> = {}) {
  const client = {
    getCompositionSummary: vi.fn(async () => ({
      productVersion: "7.20.0",
      layerCount: 1,
      columnCount: 1,
      deckCount: 0,
      layers: [{ index: 1, name: "L1", clipCount: 1, connectedClip: null }],
      columns: [{ index: 1, name: "C1" }],
      decks: [],
    })),
    triggerClip: vi.fn(async () => undefined),
    selectClip: vi.fn(async () => undefined),
    clearLayer: vi.fn(async () => undefined),
    setLayerOpacity: vi.fn(async () => undefined),
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
  it("registers all 6 MVP tools with unique resolume_-prefixed names", () => {
    const names = allTools.map((t) => t.name);
    expect(names).toEqual([
      "resolume_get_composition",
      "resolume_trigger_clip",
      "resolume_select_clip",
      "resolume_get_clip_thumbnail",
      "resolume_set_layer_opacity",
      "resolume_clear_layer",
    ]);
    expect(new Set(names).size).toBe(names.length);
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
