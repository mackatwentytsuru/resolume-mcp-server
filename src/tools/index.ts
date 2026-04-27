import type { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { getCompositionTool } from "./composition/get-composition.js";
import { triggerClipTool } from "./clip/trigger-clip.js";
import { selectClipTool } from "./clip/select-clip.js";
import { getClipThumbnailTool } from "./clip/get-thumbnail.js";
import { setLayerOpacityTool } from "./layer/set-opacity.js";
import { clearLayerTool } from "./layer/clear-layer.js";

/**
 * Type-erased tool entry used by the registry. We cast individual tools
 * (which have specific argument types) to this shape — TS contravariance
 * forbids assigning a narrower handler to a wider one without an explicit
 * cast, but the registry never invokes the handler with the wrong shape:
 * arguments are re-validated against the tool's inputSchema before dispatch.
 */
export interface AnyTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  destructive?: boolean;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Erase the handler's specific argument type while keeping every other field
 * structurally typed. The cast is isolated to the handler — if `AnyTool` and
 * `ToolDefinition` ever drift on any other field, TypeScript will surface it
 * at this site instead of letting a malformed object slip through.
 */
function eraseTool<TShape extends z.ZodRawShape>(tool: ToolDefinition<TShape>): AnyTool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    destructive: tool.destructive,
    handler: tool.handler as AnyTool["handler"],
  };
}

export const allTools: ReadonlyArray<AnyTool> = [
  eraseTool(getCompositionTool),
  eraseTool(triggerClipTool),
  eraseTool(selectClipTool),
  eraseTool(getClipThumbnailTool),
  eraseTool(setLayerOpacityTool),
  eraseTool(clearLayerTool),
];
