import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  layer: z.number().int().min(1).max(9999).describe("1-based layer index."),
  effectIndex: z
    .number()
    .int()
    .min(1)
    .max(99)
    .describe("1-based effect position on the layer. Call resolume_list_layer_effects to enumerate."),
  paramName: z
    .string()
    .min(1)
    .describe('Parameter name as reported by Resolume (e.g. "Scale", "Position X", "Amount").'),
  value: z
    .union([z.number(), z.string(), z.boolean()])
    .describe("New value. Type depends on the parameter — Range params take numbers, Choice params take strings, Boolean params take true/false."),
} as const;

export const setEffectParameterTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_set_effect_parameter",
  title: "Set effect parameter",
  description:
    "Changes a single parameter on an existing effect attached to a layer. Use resolume_list_layer_effects to discover which effects and parameters exist on a layer first.",
  inputSchema,
  handler: async ({ layer, effectIndex, paramName, value }, ctx) => {
    await ctx.client.setEffectParameter(layer, effectIndex, paramName, value);
    return textResult(
      `Set layer=${layer} effect[${effectIndex}].${paramName} = ${JSON.stringify(value)}.`
    );
  },
};
