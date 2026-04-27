import { z } from "zod";
import type { ResolumeClient } from "../resolume/client.js";
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
}

/**
 * Stability tier for a tool. Defaults to `"stable"` when absent.
 *
 *   `stable` — production-grade, covered by tests, behavior frozen.
 *   `beta`   — works on Resolume but expect rough edges or wording changes.
 *   `alpha`  — experimental; may change or disappear without a major bump.
 *
 * Used by `decorateDescription()` to prefix descriptions with `[BETA]` /
 * `[ALPHA]` markers and by `filterByStability()` to honour the
 * `RESOLUME_TOOLS_STABILITY` env var. See docs/v0.5/03-tool-registry.md.
 */
export type Stability = "stable" | "beta" | "alpha";

/**
 * Structured deprecation marker. Presence on a tool implies the tool is
 * deprecated and triggers a one-time stderr warning at first invocation.
 *
 *   `since`       — semver string for the release that introduced the
 *                   deprecation marker (e.g. "0.5.0").
 *   `replaceWith` — name of the replacement tool, if any.
 *   `removeIn`    — semver string for the release that will delete the tool.
 *   `reason`      — short rationale shown to the LLM and logged.
 */
export interface DeprecationInfo {
  since: string;
  replaceWith?: string;
  removeIn?: string;
  reason?: string;
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
  /** Defaults to "stable" when absent. */
  stability?: Stability;
  /** Presence marks the tool as deprecated; metadata describes the replacement. */
  deprecated?: DeprecationInfo;
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
