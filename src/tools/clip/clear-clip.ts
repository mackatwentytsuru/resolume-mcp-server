import { errorResult, jsonResult, textResult, type ToolDefinition } from "../types.js";
import {
  clipIndexSchema,
  confirmSchema,
  layerIndexSchema,
} from "../schema-helpers.js";

const clearSchema = {
  layer: layerIndexSchema,
  clip: clipIndexSchema,
  confirm: confirmSchema.describe(
    "Must be true. Clearing a clip removes its loaded media (source, name, thumbnail) — the slot becomes empty. Pass true only when the user has explicitly asked to remove a clip from a slot."
  ),
} as const;

export const clearClipTool: ToolDefinition<typeof clearSchema> = {
  name: "resolume_clear_clip",
  title: "Clear clip slot",
  description:
    "DESTRUCTIVE: empties a single clip slot — removes the loaded media so the slot is blank. Different from clear_layer (which only disconnects). Requires confirm: true.",
  destructive: true,
  inputSchema: clearSchema,
  handler: async ({ layer, clip, confirm }, ctx) => {
    if (!confirm) {
      return errorResult(
        "Refusing to clear clip without confirm=true. Ask the user to confirm before retrying."
      );
    }
    await ctx.client.clearClip(layer, clip);
    return textResult(`Cleared clip slot layer=${layer} clip=${clip}.`);
  },
};

const wipeSchema = {
  confirm: confirmSchema.describe(
    'Must be true. This empties EVERY clip slot on EVERY layer — irreversible. Pass true only after the user has explicitly asked to "wipe", "clear all clips", or equivalent. Always confirm with the user first.'
  ),
} as const;

export const wipeCompositionTool: ToolDefinition<typeof wipeSchema> = {
  name: "resolume_wipe_composition",
  title: "Wipe composition",
  description:
    "DESTRUCTIVE: empties every clip slot on every layer in the active composition. The deck structure (deck list, layer count, column count) stays intact — only loaded clip media is removed. Requires confirm: true.",
  destructive: true,
  inputSchema: wipeSchema,
  handler: async ({ confirm }, ctx) => {
    if (!confirm) {
      return errorResult(
        "Refusing to wipe composition without confirm=true. This empties every clip slot on every layer. Ask the user to confirm explicitly."
      );
    }
    const result = await ctx.client.wipeComposition();
    return jsonResult({
      cleared: result.failedLayers.length === 0,
      layers: result.layers,
      slotsCleared: result.slotsCleared,
      failedLayers: result.failedLayers,
    });
  },
};
