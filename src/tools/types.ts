import { z } from "zod";
import type { ResolumeClient } from "../resolume/client.js";
import type { CompositionStore } from "../resolume/composition-store/store.js";
import type { OscConfig } from "../config.js";

/**
 * MCP tool result content. Uses an open shape so it composes with the SDK's
 * structural return type (which has an index signature).
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  [k: string]: unknown;
}

export interface ToolContext {
  client: ResolumeClient;
  /** OSC host/ports (added in v0.4 for OSC tools). */
  osc?: OscConfig;
  /**
   * In-memory composition cache (v0.5). Present only when `RESOLUME_CACHE`
   * is enabled. Tools that want the fast-path read can opt in via
   * `ctx.store?.readSnapshot()` etc.; absent the flag this is undefined and
   * tools fall through to REST exactly as in v0.4. The wired-in cache-fast
   * tool integrations land in v0.5.1 (Sprint C / Phase 5).
   */
  store?: CompositionStore;
}

/**
 * A tool definition uses a Zod *raw shape* (the inner object, not z.object(...)).
 * That matches the @modelcontextprotocol/sdk `server.tool()` signature directly,
 * avoiding any wrapping/unwrapping at registration time.
 */
export interface ToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: TShape;
  destructive?: boolean;
  handler: (
    args: z.objectOutputType<TShape, z.ZodTypeAny>,
    ctx: ToolContext
  ) => Promise<ToolResult>;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
