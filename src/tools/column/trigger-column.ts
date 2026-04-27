import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  column: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based column index. Triggering a column connects every clip in that column simultaneously across all layers."),
} as const;

export const triggerColumnTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_trigger_column",
  title: "Trigger column",
  description:
    "Triggers all clips in the given column (1-based). This is the standard way to switch scenes — each column typically represents a distinct visual scene.",
  inputSchema,
  handler: async ({ column }, ctx) => {
    await ctx.client.triggerColumn(column);
    return textResult(`Triggered column ${column}.`);
  },
};
