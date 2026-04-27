import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  deck: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based deck index. Decks are saved sets of clips/scenes — switching deck changes the entire visible composition."),
} as const;

export const selectDeckTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_select_deck",
  title: "Select deck",
  description:
    "Switches to the given deck. Decks act like song banks — different decks for different tracks or sets. Use resolume_get_composition to see deck names.",
  inputSchema,
  handler: async ({ deck }, ctx) => {
    await ctx.client.selectDeck(deck);
    return textResult(`Selected deck ${deck}.`);
  },
};
