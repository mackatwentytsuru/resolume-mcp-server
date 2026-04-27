import { z } from "zod";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

const setSchema = {
  layer: z.number().int().min(1).max(9999).describe("1-based layer index."),
  blendMode: z
    .string()
    .min(1)
    .describe(
      'Exact blend mode name as Resolume reports it (e.g. "Add", "Multiply", "Screen", "Lighten"). Use resolume_list_layer_blend_modes to enumerate.'
    ),
} as const;

export const setLayerBlendModeTool: ToolDefinition<typeof setSchema> = {
  name: "resolume_set_layer_blend_mode",
  title: "Set layer blend mode",
  description:
    "Changes how a layer is mixed with the layers below it (Add, Multiply, Screen, etc.). Resolume offers 60+ modes — call resolume_list_layer_blend_modes first to see the available names.",
  inputSchema: setSchema,
  handler: async ({ layer, blendMode }, ctx) => {
    await ctx.client.setLayerBlendMode(layer, blendMode);
    return textResult(`Layer ${layer} blend mode = ${blendMode}.`);
  },
};

const listSchema = {
  layer: z.number().int().min(1).max(9999),
} as const;

export const listLayerBlendModesTool: ToolDefinition<typeof listSchema> = {
  name: "resolume_list_layer_blend_modes",
  title: "List layer blend modes",
  description:
    "Returns the list of available blend mode names for a given layer. Names vary by Resolume version, so list before setting.",
  inputSchema: listSchema,
  handler: async ({ layer }, ctx) => {
    const modes = await ctx.client.getLayerBlendModes(layer);
    return jsonResult({ layer, blendModes: modes });
  },
};
