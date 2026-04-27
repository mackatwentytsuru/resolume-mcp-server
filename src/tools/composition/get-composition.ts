import { jsonResult, type ToolDefinition } from "../types.js";

const inputSchema = {} as const;

export const getCompositionTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_get_composition",
  title: "Get composition state",
  description:
    "Returns a compact summary of the current Resolume composition: detected version, layers (with their connected clip), columns, and decks. Always call this first when you need to make decisions based on the live state — every other tool refers to layers/clips/columns by 1-based index.",
  inputSchema,
  handler: async (_args, ctx) => {
    const summary = await ctx.client.getCompositionSummary();
    return jsonResult(summary);
  },
};
