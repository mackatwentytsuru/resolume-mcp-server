import { eraseTool, type AnyTool } from "./registry.js";
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
import { oscSendTool } from "./osc/send.js";
import { oscQueryTool } from "./osc/query.js";
import { oscSubscribeTool } from "./osc/subscribe.js";
import { oscStatusTool } from "./osc/status.js";

// Re-export AnyTool so existing consumers (server/registerTools.ts) that import
// from this module keep working without changes.
export type { AnyTool };

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
  // OSC (v0.4)
  eraseTool(oscSendTool),
  eraseTool(oscQueryTool),
  eraseTool(oscSubscribeTool),
  eraseTool(oscStatusTool),
];
