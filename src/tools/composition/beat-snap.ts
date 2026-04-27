import { z } from "zod";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

const getSchema = {} as const;

export const getBeatSnapTool: ToolDefinition<typeof getSchema> = {
  name: "resolume_get_beat_snap",
  title: "Get clip beat snap",
  description:
    "Returns the current composition-level clip beat-snap setting and the list of available options (None, 8 Bars, 4 Bars, 2 Bars, 1 Bar, 1/2 Bar, 1/4 Bar). When beat snap is set, triggered clips wait for the next beat boundary before connecting — essential for BPM-synced VJing.",
  inputSchema: getSchema,
  handler: async (_args, ctx) => {
    const snap = await ctx.client.getBeatSnap();
    return jsonResult(snap);
  },
};

const setSchema = {
  beatSnap: z
    .string()
    .min(1)
    .describe(
      'Exact beat-snap option as Resolume reports it (e.g. "None", "1 Bar", "1/2 Bar", "1/4 Bar"). Call resolume_get_beat_snap to enumerate.'
    ),
} as const;

export const setBeatSnapTool: ToolDefinition<typeof setSchema> = {
  name: "resolume_set_beat_snap",
  title: "Set clip beat snap",
  description:
    "Sets the composition-level clip beat-snap. Triggered clips will wait for the next beat boundary (e.g. 1 Bar, 1/4 Bar) before connecting — this is how Resolume keeps clip changes locked to the music.",
  inputSchema: setSchema,
  handler: async ({ beatSnap }, ctx) => {
    await ctx.client.setBeatSnap(beatSnap);
    return textResult(`Set clip beat snap to ${beatSnap}.`);
  },
};
