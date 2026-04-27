import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { addEffectToLayerTool } from "./add-effect.js";
import { removeEffectFromLayerTool } from "./remove-effect.js";
import type { ResolumeClient } from "../../resolume/client.js";

function buildCtx(overrides: Partial<ResolumeClient> = {}) {
  const client = {
    addEffectToLayer: vi.fn(async () => undefined),
    removeEffectFromLayer: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ResolumeClient;
  return { client, ctx: { client } };
}

describe("resolume_add_effect_to_layer", () => {
  it("forwards layer + effectName to the client", async () => {
    const { client, ctx } = buildCtx();
    const result = await addEffectToLayerTool.handler(
      { layer: 2, effectName: "Blur" },
      ctx
    );
    expect(client.addEffectToLayer).toHaveBeenCalledWith(2, "Blur");
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("Blur");
    expect((result.content[0] as { text: string }).text).toContain("layer 2");
  });

  it("rejects non-positive layer indices at the schema boundary", () => {
    const schema = z.object(addEffectToLayerTool.inputSchema);
    expect(schema.safeParse({ layer: 0, effectName: "Blur" }).success).toBe(false);
    expect(schema.safeParse({ layer: -1, effectName: "Blur" }).success).toBe(false);
  });

  it("rejects empty effect names at the schema boundary", () => {
    const schema = z.object(addEffectToLayerTool.inputSchema);
    expect(schema.safeParse({ layer: 1, effectName: "" }).success).toBe(false);
  });

  it("accepts effect names with spaces (e.g. Hue Rotate)", () => {
    const schema = z.object(addEffectToLayerTool.inputSchema);
    expect(schema.safeParse({ layer: 1, effectName: "Hue Rotate" }).success).toBe(true);
  });
});

describe("resolume_remove_effect_from_layer", () => {
  it("refuses to remove without confirm=true", async () => {
    const { client, ctx } = buildCtx();
    const result = await removeEffectFromLayerTool.handler(
      { layer: 1, effectIndex: 2, confirm: false },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(client.removeEffectFromLayer).not.toHaveBeenCalled();
  });

  it("removes when confirm=true", async () => {
    const { client, ctx } = buildCtx();
    const result = await removeEffectFromLayerTool.handler(
      { layer: 2, effectIndex: 3, confirm: true },
      ctx
    );
    expect(client.removeEffectFromLayer).toHaveBeenCalledWith(2, 3);
    expect(result.isError).toBeFalsy();
  });

  it("is marked destructive", () => {
    expect(removeEffectFromLayerTool.destructive).toBe(true);
  });

  it("rejects non-positive effect indices at the schema boundary", () => {
    const schema = z.object(removeEffectFromLayerTool.inputSchema);
    expect(schema.safeParse({ layer: 1, effectIndex: 0, confirm: true }).success).toBe(false);
  });
});
