import { z } from "zod";
import { jsonResult, textResult, type ToolDefinition } from "../types.js";

const getSchema = {} as const;

export const getCrossfaderTool: ToolDefinition<typeof getSchema> = {
  name: "resolume_get_crossfader",
  title: "Get crossfader",
  description:
    "Returns the current crossfader phase (-1 = full side A, 0 = center, 1 = full side B). Use before set_crossfader for context.",
  inputSchema: getSchema,
  handler: async (_args, ctx) => {
    const cf = await ctx.client.getCrossfader();
    return jsonResult(cf);
  },
};

const setSchema = {
  phase: z
    .number()
    .min(-1)
    .max(1)
    .describe("Crossfader position. -1 = full side A, 0 = center (both sides equal), 1 = full side B."),
} as const;

export const setCrossfaderTool: ToolDefinition<typeof setSchema> = {
  name: "resolume_set_crossfader",
  title: "Set crossfader",
  description:
    "Sets the master crossfader phase between Side A and Side B. Use small steps (e.g. 0.1 increments) for smooth transitions, or jump directly for hard cuts. -1 = full A, 0 = center, 1 = full B.",
  inputSchema: setSchema,
  handler: async ({ phase }, ctx) => {
    await ctx.client.setCrossfader(phase);
    return textResult(`Crossfader phase = ${phase}.`);
  },
};
