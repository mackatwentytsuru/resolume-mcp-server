import { z } from "zod";
import { textResult, errorResult, type ToolDefinition } from "../types.js";
import { sendOsc } from "../../resolume/osc-client.js";

const inputSchema = {
  address: z
    .string()
    .min(1)
    .startsWith("/", { message: "OSC address must begin with '/'." })
    .describe("OSC address pattern, e.g. '/composition/tempocontroller/resync'."),
  args: z
    .array(z.union([z.number(), z.string(), z.boolean()]))
    .max(32)
    .default([])
    .describe(
      "Optional positional OSC arguments. Numbers become int32 if integer-valued and float32 otherwise; strings become OSC strings; booleans become OSC T/F markers."
    ),
} as const;

export const oscSendTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_osc_send",
  title: "Send raw OSC message",
  description:
    "Power-user tool: sends a single OSC message to Resolume. Useful for special commands not available via REST (e.g. /composition/tempocontroller/resync) or for one-off triggers. Numbers are auto-typed (int32 if integer, float32 otherwise). Use resolume_osc_query for read operations.",
  inputSchema,
  handler: async (args, ctx) => {
    if (!ctx.osc) return errorResult("OSC config missing — server not initialized with OSC support.");
    await sendOsc(ctx.osc.host, ctx.osc.inPort, args.address, args.args ?? []);
    return textResult(`OSC sent to ${args.address}`);
  },
};
