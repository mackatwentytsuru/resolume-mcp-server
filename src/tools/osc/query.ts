import { z } from "zod";
import { jsonResult, errorResult, type ToolDefinition } from "../types.js";
import { queryOsc } from "../../resolume/osc-client.js";
import { assertSupportedOscPattern } from "../../resolume/osc-codec.js";

const inputSchema = {
  address: z
    .string()
    .min(1)
    .startsWith("/", { message: "OSC address must begin with '/'." })
    .describe(
      "OSC address to query. May contain '*' wildcards (e.g. '/composition/layers/*/clips/1/name') for bulk reads."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(50)
    .max(10_000)
    .optional()
    .default(1000)
    .describe("How long to wait for replies before returning. Default 1000ms."),
} as const;

export const oscQueryTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_osc_query",
  title: "Query OSC value(s)",
  description:
    "Sends an OSC '?' query for the given address (or wildcard pattern) and returns the values Resolume echoes back within the timeout. This is the fastest way to read many values at once: '/composition/layers/*/clips/1/name' returns the first-clip name on every layer in a single round-trip.",
  inputSchema,
  handler: async (args, ctx) => {
    if (!ctx.osc) return errorResult("OSC config missing — server not initialized with OSC support.");
    try {
      assertSupportedOscPattern(args.address);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
    const messages = await queryOsc(
      ctx.osc.host,
      ctx.osc.inPort,
      ctx.osc.outPort,
      args.address,
      args.timeoutMs
    );
    return jsonResult({
      address: args.address,
      count: messages.length,
      messages: messages.map((m) => ({ address: m.address, args: m.args })),
    });
  },
};
