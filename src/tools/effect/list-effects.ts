import { z } from "zod";
import { jsonResult, type ToolDefinition } from "../types.js";

const catalogSchema = {} as const;

export const listVideoEffectsTool: ToolDefinition<typeof catalogSchema> = {
  name: "resolume_list_video_effects",
  title: "List available video effects",
  description:
    "Returns Resolume's full catalog of video effects (~100). Each entry has an `idstring` (use to add) and a `name` (human-friendly).",
  inputSchema: catalogSchema,
  handler: async (_args, ctx) => {
    const effects = await ctx.client.listVideoEffects();
    return jsonResult({ count: effects.length, effects });
  },
};

const layerEffectsSchema = {
  layer: z.number().int().min(1).max(9999).describe("1-based layer index."),
} as const;

export const listLayerEffectsTool: ToolDefinition<typeof layerEffectsSchema> = {
  name: "resolume_list_layer_effects",
  title: "List effects on a layer",
  description:
    "Returns the effects currently attached to the given layer, with their parameter names. Use this before resolume_set_effect_parameter to know which params exist.",
  inputSchema: layerEffectsSchema,
  handler: async ({ layer }, ctx) => {
    const effects = await ctx.client.listLayerEffects(layer);
    return jsonResult({
      layer,
      effects: effects.map((e, idx) => ({
        effectIndex: idx + 1,
        name: e.name,
        params: e.params,
      })),
    });
  },
};
