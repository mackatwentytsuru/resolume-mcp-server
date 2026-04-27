import { z } from "zod";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

const durationSchema = {
  layer: z.number().int().min(1).max(9999),
  durationSeconds: z
    .number()
    .min(0)
    .max(10)
    .describe(
      "Transition fade duration in seconds, 0..10. 0 = instant cut between clips. ~0.5 is a snappy musical cut, 2-3 is a long fade."
    ),
} as const;

export const setLayerTransitionDurationTool: ToolDefinition<typeof durationSchema> = {
  name: "resolume_set_layer_transition_duration",
  title: "Set layer transition duration",
  description:
    "Sets how long the fade between clips on this layer takes. 0 is an instant cut. Used together with set_layer_transition_blend_mode to control how clip changes look.",
  inputSchema: durationSchema,
  handler: async ({ layer, durationSeconds }, ctx) => {
    await ctx.client.setLayerTransitionDuration(layer, durationSeconds);
    return textResult(`Layer ${layer} transition duration = ${durationSeconds}s.`);
  },
};

const listSchema = {
  layer: z.number().int().min(1).max(9999),
} as const;

export const listLayerTransitionBlendModesTool: ToolDefinition<typeof listSchema> = {
  name: "resolume_list_layer_transition_blend_modes",
  title: "List layer transition blend modes",
  description:
    "Returns the available transition blend modes for a layer (separate from the layer-level blend mode). Resolume offers 50+ — list before setting.",
  inputSchema: listSchema,
  handler: async ({ layer }, ctx) => {
    const modes = await ctx.client.getLayerTransitionBlendModes(layer);
    return jsonResult({ layer, modes });
  },
};

const setBlendSchema = {
  layer: z.number().int().min(1).max(9999),
  blendMode: z
    .string()
    .min(1)
    .describe(
      'Exact transition blend mode (e.g. "Alpha", "Wipe Ellipse", "Push Up"). Use list_layer_transition_blend_modes to enumerate.'
    ),
} as const;

export const setLayerTransitionBlendModeTool: ToolDefinition<typeof setBlendSchema> = {
  name: "resolume_set_layer_transition_blend_mode",
  title: "Set layer transition blend mode",
  description:
    "Sets the visual effect used while transitioning between clips on this layer (Alpha = simple fade, Wipe Ellipse = circular wipe, Push Up = scroll, etc.). Pre-validates against the layer's available options.",
  inputSchema: setBlendSchema,
  handler: async ({ layer, blendMode }, ctx) => {
    await ctx.client.setLayerTransitionBlendMode(layer, blendMode);
    return textResult(`Layer ${layer} transition blend mode = ${blendMode}.`);
  },
};
