import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const resyncTempoTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_resync_tempo",
  title: "Resync tempo",
  description:
    "Sends a resync trigger to the tempo controller. Useful when Resolume's tempo has drifted from the music — the resync event aligns Resolume's beat clock to the next downbeat.",
  inputSchema,
  handler: async (_args, ctx) => {
    await ctx.client.resyncTempo();
    return textResult("Sent tempo resync trigger.");
  },
};
