import { z } from "zod";
import { jsonResult, errorResult, type ToolDefinition } from "../types.js";
import { subscribeOsc } from "../../resolume/osc-client.js";

const inputSchema = {
  addressPattern: z
    .string()
    .min(1)
    .startsWith("/", { message: "OSC address pattern must begin with '/'." })
    .describe(
      "Glob pattern with '*' wildcards. '*' is SEGMENT-BOUND (OSC 1.0): matches one path segment, not '/'. Examples: '/composition/layers/*/clips/*/transport/position' (all clip playheads — note 'clips/*' is required because Resolume's actual broadcast includes clip index), '/composition/layers/*/position' (layer-level positions), '/composition/tempocontroller/*'. Resolume actually broadcasts: layers/N/position, layers/N/clips/M/transport/position, selectedclip/transport/position. ⚠️ Playhead value is NORMALIZED 0..1, not milliseconds."
    ),
  durationMs: z
    .number()
    .int()
    .min(50)
    .max(30_000)
    .describe("Listen duration in milliseconds. Capped at 30s to keep the MCP channel responsive."),
  maxMessages: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .default(200)
    .describe("Stop early once this many messages match. Default 200."),
} as const;

export const oscSubscribeTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_osc_subscribe",
  title: "Subscribe to OSC stream briefly",
  description:
    "Listens on Resolume's OSC OUT port for the given duration and collects messages whose address matches the glob pattern. Key use: real-time playhead tracking via '/composition/layers/*/clips/*/transport/position' — REST only gives a snapshot, OSC pushes every frame at ~325 msg/s (live verified). NOTE: binds the configured OSC OUT port; will fail with EADDRINUSE if another process is already listening (e.g. a probe script).",
  inputSchema,
  handler: async (args, ctx) => {
    if (!ctx.osc) return errorResult("OSC config missing — server not initialized with OSC support.");
    const messages = await subscribeOsc(
      ctx.osc.outPort,
      args.addressPattern,
      args.durationMs,
      args.maxMessages
    );
    return jsonResult({
      pattern: args.addressPattern,
      durationMs: args.durationMs,
      count: messages.length,
      messages: messages.map((m) => ({
        address: m.address,
        args: m.args,
        timestamp: m.timestamp,
      })),
    });
  },
};
