import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  bpm: z
    .number()
    .min(20)
    .max(500)
    .describe("Beats per minute. Resolume accepts 20..500."),
} as const;

export const setBpmTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_set_bpm",
  title: "Set BPM",
  description:
    "Sets the master BPM on the composition tempo controller. Use this when the user names a specific tempo. For matching live music, prefer resolume_tap_tempo (call several times in succession).",
  inputSchema,
  handler: async ({ bpm }, ctx) => {
    await ctx.client.setTempo(bpm);
    return textResult(`Set BPM to ${bpm}.`);
  },
};
