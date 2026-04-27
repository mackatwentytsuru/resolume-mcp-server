import type { z } from "zod";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import { getCompositionTool } from "./composition/get-composition.js";
import { getBeatSnapTool, setBeatSnapTool } from "./composition/beat-snap.js";
import {
  getCrossfaderTool,
  setCrossfaderTool,
} from "./composition/crossfader.js";
import {
  setLayerTransitionDurationTool,
  setLayerTransitionBlendModeTool,
  listLayerTransitionBlendModesTool,
} from "./layer/transition.js";
import {
  setClipPlayDirectionTool,
  setClipPlayModeTool,
  setClipPositionTool,
} from "./clip/transport.js";
import { clearClipTool, wipeCompositionTool } from "./clip/clear-clip.js";
import { triggerClipTool } from "./clip/trigger-clip.js";
import { selectClipTool } from "./clip/select-clip.js";
import { getClipThumbnailTool } from "./clip/get-thumbnail.js";
import { setLayerOpacityTool } from "./layer/set-opacity.js";
import { clearLayerTool } from "./layer/clear-layer.js";
import { setLayerBypassTool } from "./layer/set-bypass.js";
import {
  setLayerBlendModeTool,
  listLayerBlendModesTool,
} from "./layer/set-blend-mode.js";
import { triggerColumnTool } from "./column/trigger-column.js";
import { selectDeckTool } from "./deck/select-deck.js";
import { setBpmTool } from "./tempo/set-bpm.js";
import { tapTempoTool } from "./tempo/tap-tempo.js";
import { getTempoTool } from "./tempo/get-tempo.js";
import { resyncTempoTool } from "./tempo/resync-tempo.js";
import {
  listVideoEffectsTool,
  listLayerEffectsTool,
} from "./effect/list-effects.js";
import { setEffectParameterTool } from "./effect/set-effect-param.js";
import { addEffectToLayerTool } from "./effect/add-effect.js";
import { removeEffectFromLayerTool } from "./effect/remove-effect.js";

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
  // Composition / state
  eraseTool(getCompositionTool),
  eraseTool(getBeatSnapTool),
  eraseTool(setBeatSnapTool),
  eraseTool(getCrossfaderTool),
  eraseTool(setCrossfaderTool),
  // Clip operations
  eraseTool(triggerClipTool),
  eraseTool(selectClipTool),
  eraseTool(getClipThumbnailTool),
  eraseTool(setClipPlayDirectionTool),
  eraseTool(setClipPlayModeTool),
  eraseTool(setClipPositionTool),
  eraseTool(clearClipTool),
  eraseTool(wipeCompositionTool),
  // Layer operations
  eraseTool(setLayerOpacityTool),
  eraseTool(setLayerBypassTool),
  eraseTool(setLayerBlendModeTool),
  eraseTool(listLayerBlendModesTool),
  eraseTool(setLayerTransitionDurationTool),
  eraseTool(setLayerTransitionBlendModeTool),
  eraseTool(listLayerTransitionBlendModesTool),
  eraseTool(clearLayerTool),
  // Column / deck
  eraseTool(triggerColumnTool),
  eraseTool(selectDeckTool),
  // Tempo
  eraseTool(getTempoTool),
  eraseTool(setBpmTool),
  eraseTool(tapTempoTool),
  eraseTool(resyncTempoTool),
  // Effects
  eraseTool(listVideoEffectsTool),
  eraseTool(listLayerEffectsTool),
  eraseTool(setEffectParameterTool),
  eraseTool(addEffectToLayerTool),
  eraseTool(removeEffectFromLayerTool),
];
