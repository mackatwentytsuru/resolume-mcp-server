import { z } from "zod";
import { textResult, type ToolDefinition } from "../types.js";

const inputSchema = {
  taps: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1)
    .describe(
      "Number of consecutive taps to send (Resolume averages over recent taps to compute BPM). Default 1; pass 4 for one bar of 4/4."
    ),
  intervalMs: z
    .number()
    .int()
    .min(100)
    .max(3000)
    .optional()
    .describe(
      "Milliseconds between taps. Required when taps > 1. For BPM N, intervalMs = 60000 / N (e.g. 120 BPM = 500ms)."
    ),
} as const;

export const tapTempoTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_tap_tempo",
  title: "Tap tempo",
  description:
    "Sends one or more taps to Resolume's tap-tempo controller. Use this to set BPM by feel — call multiple times in rhythm with the music. If you know the target BPM, pass `taps: 4, intervalMs: 60000/BPM` for a single bar of taps.",
  inputSchema,
  handler: async ({ taps, intervalMs }, ctx) => {
    if (taps > 1 && intervalMs === undefined) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "intervalMs is required when taps > 1. Compute intervalMs = 60000 / target_bpm.",
          },
        ],
      };
    }
    for (let i = 0; i < taps; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.client.tapTempo();
      if (intervalMs !== undefined && i < taps - 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    return textResult(`Sent ${taps} tap(s) to the tempo controller.`);
  },
};
