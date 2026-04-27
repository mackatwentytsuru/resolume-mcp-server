import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const directionSchema = {
  layer: z.number().int().min(1).max(9999),
  clip: z.number().int().min(1).max(9999),
  direction: z
    .enum(["<", "||", ">"])
    .describe('"<" plays in reverse, "||" pauses, ">" plays forward.'),
} as const;

export const setClipPlayDirectionTool: ToolDefinition<typeof directionSchema> = {
  name: "resolume_set_clip_play_direction",
  title: "Set clip play direction",
  description:
    'Controls a clip\'s playback direction: ">" forward, "<" reverse, "||" pause. This is the closest equivalent to play/pause for a connected clip.',
  inputSchema: directionSchema,
  handler: async ({ layer, clip, direction }, ctx) => {
    await ctx.client.setClipPlayDirection(layer, clip, direction);
    return textResult(`Layer ${layer} clip ${clip} play direction = ${direction}.`);
  },
};

const playmodeSchema = {
  layer: z.number().int().min(1).max(9999),
  clip: z.number().int().min(1).max(9999),
  mode: z
    .string()
    .min(1)
    .describe(
      'One of: "Loop", "Bounce", "Random", "Play Once & Clear", "Play Once & Hold". Resolume rejects unknown modes silently — pass exactly as listed.'
    ),
} as const;

export const setClipPlayModeTool: ToolDefinition<typeof playmodeSchema> = {
  name: "resolume_set_clip_play_mode",
  title: "Set clip play mode",
  description:
    'Sets how a clip behaves at end-of-clip: Loop (repeat), Bounce (reverse), Random (random frame), Play Once & Clear (auto-disconnect), Play Once & Hold (hold last frame).',
  inputSchema: playmodeSchema,
  handler: async ({ layer, clip, mode }, ctx) => {
    await ctx.client.setClipPlayMode(layer, clip, mode);
    return textResult(`Layer ${layer} clip ${clip} play mode = ${mode}.`);
  },
};

const positionSchema = {
  layer: z.number().int().min(1).max(9999),
  clip: z.number().int().min(1).max(9999),
  position: z
    .number()
    .min(0)
    .describe(
      "Playback position. Units are clip-internal time (read transport.position.max from get_composition for the clip's range)."
    ),
} as const;

export const setClipPositionTool: ToolDefinition<typeof positionSchema> = {
  name: "resolume_set_clip_position",
  title: "Set clip playback position",
  description:
    "Seeks the connected clip to a specific position. Useful for re-triggering at the beginning (position 0) or jumping to a known cue point.",
  inputSchema: positionSchema,
  handler: async ({ layer, clip, position }, ctx) => {
    await ctx.client.setClipPosition(layer, clip, position);
    return textResult(`Layer ${layer} clip ${clip} position = ${position}.`);
  },
};
