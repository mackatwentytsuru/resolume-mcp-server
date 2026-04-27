import { jsonResult, errorResult, type ToolDefinition } from "../types.js";
import { probeOscStatus } from "../../resolume/osc-client.js";

const inputSchema = {} as const;

export const oscStatusTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_osc_status",
  title: "Probe OSC reachability",
  description:
    "Reports whether Resolume's OSC OUT stream is reachable on the configured port and lists the OSC host/port configuration. Useful as a first-call sanity check before resolume_osc_subscribe. Listens for ~750ms — if Resolume is sending OSC OUT (and the port isn't already bound by another process), reachable=true.",
  inputSchema,
  handler: async (_args, ctx) => {
    if (!ctx.osc) return errorResult("OSC config missing — server not initialized with OSC support.");
    const probe = await probeOscStatus(ctx.osc.outPort, 750);
    return jsonResult({
      reachable: probe.reachable,
      lastReceived: probe.lastReceived,
      inPort: ctx.osc.inPort,
      outPort: ctx.osc.outPort,
      host: ctx.osc.host,
    });
  },
};
