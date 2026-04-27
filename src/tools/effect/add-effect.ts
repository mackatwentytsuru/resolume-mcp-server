import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index. Use resolume_get_composition to list valid indices."),
  effectName: z
    .string()
    .min(1)
    .describe(
      'Human-readable effect name like "Blur", "Hue Rotate", "Bloom", "Delay RGB". Call resolume_list_video_effects to enumerate the catalog. Names are case-sensitive and must match the catalog spelling exactly.'
    ),
} as const;

export const addEffectToLayerTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_add_effect_to_layer",
  title: "Add video effect to layer",
  description:
    "Adds a video effect to a layer's effect chain. Internally posts `effect:///video/{name}` as the drag-drop URI to `/composition/layers/{N}/effects/video/add`. The new effect appears at the end of the chain. Confirmed against Resolume Arena 7.23.",
  inputSchema,
  handler: async ({ layer, effectName }, ctx) => {
    await ctx.client.addEffectToLayer(layer, effectName);
    return textResult(`Added effect "${effectName}" to layer ${layer}.`);
  },
};
