import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types.js";

const inputSchema = {
  layer: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based layer index."),
  clip: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .describe("1-based clip (column) index within the layer."),
} as const;

export const getClipThumbnailTool: ToolDefinition<typeof inputSchema> = {
  name: "resolume_get_clip_thumbnail",
  title: "Get clip thumbnail",
  description:
    "Returns the clip's thumbnail as an inline image. Use this to visually identify clips when their names are ambiguous or you need to pick the right visual for a moment.",
  inputSchema,
  handler: async ({ layer, clip }, ctx): Promise<ToolResult> => {
    const { base64, mediaType } = await ctx.client.getClipThumbnail(layer, clip);
    return {
      content: [
        { type: "text", text: `Thumbnail for layer=${layer} clip=${clip}` },
        { type: "image", data: base64, mimeType: mediaType },
      ],
    };
  },
};
