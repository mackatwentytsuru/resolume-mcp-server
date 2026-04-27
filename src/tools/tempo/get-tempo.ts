import { jsonResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const getTempoTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_get_tempo",
  title: "Get tempo",
  description:
    "Returns the current BPM and the accepted range (typically 20..500). Useful before calling resolume_set_bpm so you can clamp values reasonably.",
  inputSchema,
  handler: async (_args, ctx) => {
    const tempo = await ctx.client.getTempo();
    return jsonResult(tempo);
  },
};
