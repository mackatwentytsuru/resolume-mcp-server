/**
 * Reusable Zod schemas for tool inputs.
 *
 * These exist because some MCP clients / SDK versions stringify primitives
 * (especially when an arg object contains a boolean — discovered in v0.5.3
 * live testing where `resolume_remove_effect_from_layer` rejected calls with
 * all three args reported as `received: "string"`). Plain `z.number()` and
 * `z.boolean()` reject stringified inputs; the helpers below coerce safely
 * while preserving the safety guarantees (e.g. `confirm` still must be the
 * truthy literal `true`/`"true"` to authorize destructive ops).
 *
 * Use these for every numeric index arg and every `confirm` arg.
 */
import { z } from "zod";

/** 1-based layer index. Accepts number or numeric string. Range 1..9999. */
export const layerIndexSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(9999)
  .describe("1-based layer index. Use resolume_get_composition to list valid indices.");

/** 1-based clip (column) index. Accepts number or numeric string. Range 1..9999. */
export const clipIndexSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(9999)
  .describe("1-based clip (column) index within the layer.");

/** 1-based effect index. Accepts number or numeric string. Range 1..99. */
export const effectIndexSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(99)
  .describe(
    "1-based effect position on the layer. Call resolume_list_layer_effects to enumerate."
  );

/**
 * Confirmation flag for destructive operations. Accepts either:
 *   - boolean `true` / `false`, or
 *   - string `"true"` / `"false"` (some MCP transports stringify booleans).
 * Anything else fails Zod validation. The transform always returns a real
 * boolean so handlers can safely write `if (!confirm)`.
 *
 * Note: we don't use `z.coerce.boolean()` because `Boolean("false") === true`
 * in JavaScript — that would silently authorize destructive ops on a string
 * `"false"`, which is the opposite of safe. The explicit union is correct.
 */
export const confirmSchema = z
  .union([z.boolean(), z.literal("true"), z.literal("false")])
  .transform((v) => v === true || v === "true");
