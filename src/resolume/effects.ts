/**
 * Effect-related operations extracted from ResolumeClient to keep client.ts
 * under 600 lines. Re-exported by client.ts so the public API is unchanged.
 */

import { ResolumeRestClient } from "./rest.js";
import type { EffectCatalogEntry } from "./types.js";
import { ResolumeApiError } from "../errors/types.js";
import { assertIndex } from "./shared.js";

// Module-level parameter type Sets (avoid per-call allocation in coerceParamValue).
export const NUMERIC_TYPES = new Set(["ParamRange", "ParamNumber", "ParamFloat", "ParamInt"]);
export const BOOLEAN_TYPES = new Set(["ParamBoolean"]);
export const STRING_TYPES = new Set(["ParamChoice", "ParamString", "ParamText"]);

export function coerceParamValue(
  value: number | string | boolean,
  valuetype: string | undefined,
  paramName: string
): number | string | boolean {
  if (!valuetype) return value;

  if (NUMERIC_TYPES.has(valuetype)) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
      throw new ResolumeApiError({
        kind: "InvalidValue",
        field: paramName,
        value,
        hint: `Parameter "${paramName}" is ${valuetype} (numeric); value must be a number, got "${value}".`,
      });
    }
    if (typeof value === "boolean") return value ? 1 : 0;
  }

  if (BOOLEAN_TYPES.has(valuetype)) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: paramName,
      value,
      hint: `Parameter "${paramName}" is ${valuetype}; value must be true, false, 0, 1, "true", or "false". Got ${typeof value === "string" ? `"${value}"` : String(value)}.`,
    });
  }

  if (STRING_TYPES.has(valuetype)) {
    return String(value);
  }

  // Unknown type — pass through unchanged.
  return value;
}

/** Resolume's full video effect catalog (~100 entries). */
export async function listVideoEffects(rest: ResolumeRestClient): Promise<EffectCatalogEntry[]> {
  const raw = (await rest.get("/effects/video")) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is { idstring?: string; name?: string } => typeof e === "object" && e !== null)
    .map((e) => ({
      idstring: typeof e.idstring === "string" ? e.idstring : "",
      name: typeof e.name === "string" ? e.name : "",
    }))
    .filter((e) => e.idstring && e.name);
}

export async function listLayerEffects(
  rest: ResolumeRestClient,
  layer: number
): Promise<
  Array<{
    id: number;
    name: string;
    /** Detailed parameter info: name, type, current value, range when applicable. */
    params: Array<{
      name: string;
      valuetype: string | null;
      value: number | string | boolean | null;
      min?: number;
      max?: number;
      options?: string[];
    }>;
  }>
> {
  assertIndex("layer", layer);
  const raw = (await rest.get(`/composition/layers/${layer}`)) as {
    video?: {
      effects?: Array<{
        id?: number;
        name?: string;
        params?: Record<
          string,
          {
            valuetype?: string;
            value?: unknown;
            min?: number;
            max?: number;
            options?: unknown[];
          }
        >;
      }>;
    };
  };
  const effects = raw?.video?.effects ?? [];
  return effects.map((e) => ({
    id: typeof e.id === "number" ? e.id : 0,
    name: typeof e.name === "string" ? e.name : "",
    params: e.params
      ? Object.entries(e.params).map(([name, p]) => {
          const v = p?.value;
          const valueOut: number | string | boolean | null =
            typeof v === "number" || typeof v === "string" || typeof v === "boolean"
              ? v
              : null;
          const out: {
            name: string;
            valuetype: string | null;
            value: number | string | boolean | null;
            min?: number;
            max?: number;
            options?: string[];
          } = {
            name,
            valuetype: p?.valuetype ?? null,
            value: valueOut,
          };
          if (typeof p?.min === "number") out.min = p.min;
          if (typeof p?.max === "number") out.max = p.max;
          if (Array.isArray(p?.options)) {
            out.options = p.options.filter((o): o is string => typeof o === "string");
          }
          return out;
        })
      : [],
  }));
}

/**
 * Set a parameter on an existing effect attached to a layer.
 * `effectIndex` is 1-based across `layer.video.effects`.
 * `paramName` is the human-readable parameter name (e.g. "Scale", "Position X").
 *
 * Resolume's nested-PUT requires the target effect's `id` to identify which
 * entry in the array to mutate; without it, Resolume silently no-ops.
 * We fetch the layer, locate the effect by 1-based index, and include the id.
 */
export async function setEffectParameter(
  rest: ResolumeRestClient,
  layer: number,
  effectIndex: number,
  paramName: string,
  value: number | string | boolean
): Promise<void> {
  assertIndex("layer", layer);
  if (!Number.isInteger(effectIndex) || effectIndex < 1) {
    throw new ResolumeApiError({
      kind: "InvalidIndex",
      what: "effect",
      index: effectIndex,
      hint: "effectIndex is the 1-based position of the effect on the layer. List the layer's effects to enumerate.",
    });
  }
  if (typeof paramName !== "string" || paramName.length === 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "paramName",
      value: paramName,
      hint: "paramName must match the effect's parameter name exactly (e.g. 'Scale').",
    });
  }

  const rawLayer = (await rest.get(`/composition/layers/${layer}`)) as {
    video?: {
      effects?: Array<{
        id?: number;
        params?: Record<string, { valuetype?: string } | undefined>;
      }>;
    };
  };
  const effects = rawLayer?.video?.effects ?? [];
  const target = effects[effectIndex - 1];
  if (!target) {
    throw new ResolumeApiError({
      kind: "InvalidIndex",
      what: "effect",
      index: effectIndex,
      hint: `Layer ${layer} has only ${effects.length} effect(s). List the layer's effects first.`,
    });
  }
  if (typeof target.id !== "number") {
    throw new ResolumeApiError({
      kind: "Unknown",
      message: `Effect at index ${effectIndex} on layer ${layer} has no id.`,
      hint: "This is unexpected — try a different effect or reload the composition.",
    });
  }
  // Use own-property lookup so inherited names like "__proto__" or "constructor"
  // are not falsely accepted via the prototype chain (silent no-op on Resolume).
  if (
    !target.params ||
    !Object.prototype.hasOwnProperty.call(target.params, paramName)
  ) {
    const known = target.params ? Object.keys(target.params) : [];
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "paramName",
      value: paramName,
      hint: `Effect has no parameter named "${paramName}". Available: ${known.join(", ") || "(none)"}.`,
    });
  }

  // Resolume silently rejects type-mismatched values (e.g. string "175" for a
  // ParamRange) — the API returns 204 but ignores the change. Coerce based on
  // the parameter's declared valuetype so the LLM doesn't have to care about
  // exact JSON types when passing values through MCP wire encoding.
  const valuetype = target.params[paramName]?.valuetype;
  const coerced = coerceParamValue(value, valuetype, paramName);

  const body: Array<Record<string, unknown>> = [];
  for (let i = 0; i < effectIndex - 1; i += 1) body.push({});
  body.push({ id: target.id, params: { [paramName]: { value: coerced } } });
  await rest.put(`/composition/layers/${layer}`, {
    video: { effects: body },
  });
}

/**
 * Adds a video effect to a layer. The body Resolume expects is a *drag-drop
 * URI string* of the form `effect:///video/{EffectName}` — not JSON, not the
 * effect's `idstring`. The endpoint is `POST /composition/layers/{N}/effects/video/add`
 * with `Content-Type: text/plain`. Resolume returns 204 on success.
 *
 * `effectName` is the human-readable name (e.g. `"Blur"`, `"Hue Rotate"`) as
 * reported by the `/effects/video` catalog. Spaces are URL-safe in the URI
 * Resolume parses, so we leave them as-is.
 */
export async function addEffectToLayer(rest: ResolumeRestClient, layer: number, effectName: string): Promise<void> {
  assertIndex("layer", layer);
  if (typeof effectName !== "string" || effectName.trim().length === 0) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "effectName",
      value: effectName,
      hint: 'effectName must be a non-empty string like "Blur" or "Hue Rotate". Use resolume_list_video_effects to enumerate.',
    });
  }
  const trimmed = effectName.trim();
  // URL-encode the effect name so names with special characters (e.g. spaces,
  // parentheses) are transmitted correctly. Live-verified: Resolume's drag-drop
  // URI parser accepts percent-encoded names produced by encodeURIComponent.
  await rest.postText(
    `/composition/layers/${layer}/effects/video/add`,
    `effect:///video/${encodeURIComponent(trimmed)}`
  );
}

/**
 * Removes a video effect from a layer by its 1-based position. Resolume's
 * REST DELETE endpoint uses 0-based array indices, but we keep the public
 * API 1-based to stay consistent with the rest of the tool surface.
 *
 * Note: removing the built-in `Transform` effect (always at index 1) is
 * generally a bad idea — Resolume usually pre-installs it. We surface the
 * user's choice to them rather than blocking it.
 */
export async function removeEffectFromLayer(rest: ResolumeRestClient, layer: number, effectIndex: number): Promise<void> {
  assertIndex("layer", layer);
  if (!Number.isInteger(effectIndex) || effectIndex < 1) {
    throw new ResolumeApiError({
      kind: "InvalidIndex",
      what: "effect",
      index: effectIndex,
      hint: "effectIndex is the 1-based position of the effect on the layer. Call resolume_list_layer_effects first.",
    });
  }
  // Verify the index exists so we return a structured error instead of a 404.
  const existing = await listLayerEffects(rest, layer);
  if (effectIndex > existing.length) {
    throw new ResolumeApiError({
      kind: "InvalidIndex",
      what: "effect",
      index: effectIndex,
      hint: `Layer ${layer} has only ${existing.length} effect(s). Call resolume_list_layer_effects to enumerate.`,
    });
  }
  const zeroBased = effectIndex - 1;
  await rest.delete(
    `/composition/layers/${layer}/effects/video/${zeroBased}`
  );
}

