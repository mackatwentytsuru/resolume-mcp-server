/**
 * Effect-related operations extracted from ResolumeClient to keep client.ts
 * under 600 lines. Re-exported by client.ts so the public API is unchanged.
 */

import { ResolumeRestClient } from "./rest.js";
import type { EffectCatalogEntry } from "./types.js";
import { ResolumeApiError } from "../errors/types.js";
import { assertIndex } from "./shared.js";
import type { EffectIdCache } from "./effect-id-cache.js";

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
 * Internal: GETs the layer, locates the effect at `effectIndex`, validates
 * `paramName` against its parameter list, and returns the resolved id +
 * valuetype. This is the slow path (one full layer GET); cache callers
 * should ONLY use this on cache miss.
 *
 * Throws `ResolumeApiError` if effectIndex is out of range, the effect
 * has no id, or paramName doesn't exist on the effect.
 */
async function fetchEffectInfo(
  rest: ResolumeRestClient,
  layer: number,
  effectIndex: number,
  paramName: string
): Promise<{ id: number; valuetype: string | undefined }> {
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
  return { id: target.id, valuetype: target.params[paramName]?.valuetype };
}

/**
 * Set a parameter on an existing effect attached to a layer.
 * `effectIndex` is 1-based across `layer.video.effects`.
 * `paramName` is the human-readable parameter name (e.g. "Scale", "Position X").
 *
 * Resolume's nested-PUT requires the target effect's `id` to identify which
 * entry in the array to mutate; without it, Resolume silently no-ops.
 * We fetch the layer, locate the effect by 1-based index, and include the id.
 *
 * `cache` (optional): when supplied, halves request rate for tight-loop
 * parameter sweeps. Cache stores only the id; on hit we skip the GET and
 * pass `value` through `coerceParamValue` without a fresh `valuetype` —
 * subsequent hits assume the parameter still exists with the same type.
 * If the cache is missing or disabled, behavior is identical to v0.4.x.
 */
export async function setEffectParameter(
  rest: ResolumeRestClient,
  layer: number,
  effectIndex: number,
  paramName: string,
  value: number | string | boolean,
  cache?: EffectIdCache
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

  // The cache stores only the id. On miss we still fetch the full layer and
  // validate the param; on hit we skip the GET and best-effort coerce.
  // `valuetype` is captured during the miss path inside the fetcher closure
  // so the post-`lookup` PUT body uses the freshly-validated type.
  let valuetype: string | undefined;
  let validatedOnMiss = false;
  const id = await (cache
    ? cache.lookup(layer, effectIndex, async () => {
        const info = await fetchEffectInfo(rest, layer, effectIndex, paramName);
        valuetype = info.valuetype;
        validatedOnMiss = true;
        return info.id;
      })
    : (async () => {
        const info = await fetchEffectInfo(rest, layer, effectIndex, paramName);
        valuetype = info.valuetype;
        validatedOnMiss = true;
        return info.id;
      })());

  // On cache hit, `validatedOnMiss` stayed false: we don't have a fresh
  // valuetype, so coerceParamValue passes the value through untyped. This
  // is the documented caveat (param-schema staleness on hits — see spec).
  void validatedOnMiss;

  // Resolume silently rejects type-mismatched values (e.g. string "175" for a
  // ParamRange) — the API returns 204 but ignores the change. Coerce based on
  // the parameter's declared valuetype so the LLM doesn't have to care about
  // exact JSON types when passing values through MCP wire encoding.
  const coerced = coerceParamValue(value, valuetype, paramName);

  const body: Array<Record<string, unknown>> = [];
  for (let i = 0; i < effectIndex - 1; i += 1) body.push({});
  body.push({ id, params: { [paramName]: { value: coerced } } });
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
export async function addEffectToLayer(
  rest: ResolumeRestClient,
  layer: number,
  effectName: string,
  cache?: EffectIdCache
): Promise<void> {
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
  // After add, every (layer, effectIndex) → id mapping on this layer is
  // potentially stale — Resolume can insert at any position. Drop the
  // layer's cache so the next setEffectParameter refetches.
  //
  // v0.5.2: also flag the layer as `requireRevalidation`. Live testing
  // against Arena 7.23.2 showed the GET response immediately after add
  // exposes a *transient* numeric `id` for the new effect. The first PUT
  // against that transient id lands; the second silently no-ops because
  // Resolume has by then re-keyed the effect to its persistent id. With
  // the revalidation flag, the next MISS-fetch runs the fetcher but does
  // not cache; the call after that re-fetches the now-stable id and
  // caches normally. Cost: 1 extra GET per add. Benefit: silent-no-op
  // class eliminated for cache-hit PUTs against just-added effects.
  cache?.invalidateLayer(layer, { requireRevalidation: true });
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
export async function removeEffectFromLayer(
  rest: ResolumeRestClient,
  layer: number,
  effectIndex: number,
  cache?: EffectIdCache
): Promise<void> {
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
  // After remove, indices > the removed slot shift down — drop the entire
  // layer's cache so the next setEffectParameter refetches against the
  // correct array shape.
  cache?.invalidateLayer(layer);
}

