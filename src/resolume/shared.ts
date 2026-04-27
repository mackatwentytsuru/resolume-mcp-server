/**
 * Cross-domain helpers shared by per-domain modules under src/resolume/.
 *
 * `assertIndex` was previously duplicated in `client.ts` and `effects.ts`.
 * Consolidating here eliminates drift and gives the new domain modules
 * (composition.ts, clip.ts, layer.ts, tempo.ts) a single source of truth for
 * 1-based index validation and Resolume parameter envelope extraction.
 */

import { ResolumeApiError } from "../errors/types.js";

export type IndexKind = "layer" | "column" | "clip" | "deck" | "effect";

/**
 * Asserts that `n` is a 1-based positive integer. Throws a structured
 * `ResolumeApiError` with kind "InvalidIndex" otherwise. The hint matches the
 * pre-refactor message so existing tests continue to pass without edits.
 */
export function assertIndex(what: IndexKind, n: number): void {
  if (!Number.isInteger(n) || n < 1) {
    throw new ResolumeApiError({
      kind: "InvalidIndex",
      what,
      index: n,
      hint: `${what} indices are 1-based positive integers. Call resolume_get_composition to list valid ranges.`,
    });
  }
}

/**
 * Pulls a non-empty string out of a Resolume parameter envelope (`{value: ...}`).
 * Returns null when the envelope is missing or the value is not a usable string.
 */
export function extractName(p: { value?: unknown } | undefined): string | null {
  if (!p) return null;
  const v = p.value;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Returns the raw `value` of a Resolume parameter envelope, or undefined. */
export function extractValue(p: { value?: unknown } | undefined): unknown {
  return p?.value;
}

/**
 * Filters an unknown `options` array (from a Resolume `ParamChoice` envelope)
 * down to the string entries Resolume expects clients to choose from.
 */
export function filterStringOptions(opts: unknown): string[] {
  if (!Array.isArray(opts)) return [];
  return opts.filter((o): o is string => typeof o === "string");
}
