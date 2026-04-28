import { z } from "zod";
import { jsonResult, errorResult, type ToolDefinition } from "../types.js";
import { subscribeOsc, type ReceivedOscMessage } from "../../resolume/osc-client.js";
import type { OscScalar } from "../../resolume/osc-codec.js";

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
  dedupe: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, collapse consecutive duplicate messages per address (same address+args as the previous accepted message for that address). Resolume Arena 7.23.x is observed (live, 2026-04-28) to broadcast some continuous parameters — notably /composition/layers/*/position — twice per refresh frame at sub-ms spacing, both copies sharing the same Date.now() timestamp. Setting dedupe=true gives one entry per unique value transition. Default off — raw stream preserved for jitter / timing analysis."
    ),
} as const;

/**
 * Collapse consecutive same-(address, args) messages per address. State is
 * scoped per-address so legitimate alternation between two layers (e.g.
 * layer 1 then layer 2 then layer 1 again) is preserved.
 *
 * Used to soften Resolume Arena's known wire-level double-broadcast on
 * UI-bound continuous params (verified live against 7.23.2.51094).
 */
function dedupeConsecutive(
  msgs: ReadonlyArray<ReceivedOscMessage>
): ReceivedOscMessage[] {
  const lastByAddress = new Map<string, ReadonlyArray<OscScalar>>();
  const out: ReceivedOscMessage[] = [];
  for (const m of msgs) {
    const prev = lastByAddress.get(m.address);
    if (prev && argsEqual(prev, m.args)) continue;
    lastByAddress.set(m.address, m.args);
    out.push(m);
  }
  return out;
}

function argsEqual(
  a: ReadonlyArray<OscScalar>,
  b: ReadonlyArray<OscScalar>
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const oscSubscribeTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_osc_subscribe",
  title: "Subscribe to OSC stream briefly",
  description:
    "Listens on Resolume's OSC OUT port for the given duration and collects messages whose address matches the glob pattern. Key use: real-time playhead tracking via '/composition/layers/*/clips/*/transport/position' — REST only gives a snapshot, OSC pushes every frame at ~325 msg/s (live verified). When RESOLUME_CACHE is enabled the CompositionStore already owns the OSC OUT socket; this tool then transparently multiplexes through the store via store.collect() — no port contention, no EADDRINUSE. When the cache is disabled (default), the tool binds the OSC OUT port directly for the duration of the call (legacy behavior). Note: Resolume Arena 7.23.x emits some UI-bound parameters (notably /composition/layers/*/position) twice per frame; pass dedupe=true to collapse them into one entry per value transition.",
  inputSchema,
  handler: async (args, ctx) => {
    if (!ctx.osc) return errorResult("OSC config missing — server not initialized with OSC support.");
    const collected = ctx.store
      ? await ctx.store.collect(args.addressPattern, args.durationMs, args.maxMessages)
      : await subscribeOsc(
          ctx.osc.outPort,
          args.addressPattern,
          args.durationMs,
          args.maxMessages
        );
    const messages = args.dedupe ? dedupeConsecutive(collected) : collected;
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
