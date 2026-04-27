/**
 * Tempo controller operations extracted from ResolumeClient.
 *
 * Module-level helpers take a `ResolumeRestClient` as the first argument
 * (matching the precedent set by effects.ts). The thin facade methods on
 * `ResolumeClient` re-surface these so tools continue to call
 * `ctx.client.setTempo(...)` without change.
 *
 * Resolume's REST API exposes the tempo controller as a nested object on
 * `/composition`. PUTs target `/composition` with a `{tempocontroller: {...}}`
 * body envelope; GETs read from the same place.
 */

import { ResolumeRestClient } from "./rest.js";
import type { TempoState } from "./types.js";
import { ResolumeApiError } from "../errors/types.js";

/** Reads the current BPM and accepted range from /composition. */
export async function getTempo(rest: ResolumeRestClient): Promise<TempoState> {
  const composition = (await rest.get("/composition")) as {
    tempocontroller?: { tempo?: { value?: unknown; min?: number; max?: number } };
  };
  const tc = composition?.tempocontroller;
  const value = tc?.tempo?.value;
  return {
    bpm: typeof value === "number" ? value : null,
    min: typeof tc?.tempo?.min === "number" ? tc.tempo.min : null,
    max: typeof tc?.tempo?.max === "number" ? tc.tempo.max : null,
  };
}

/** Sets the global BPM. Range validation matches Resolume's accepted bounds. */
export async function setTempo(rest: ResolumeRestClient, bpm: number): Promise<void> {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 500) {
    throw new ResolumeApiError({
      kind: "InvalidValue",
      field: "bpm",
      value: bpm,
      hint: "BPM must be between 20 and 500 (Resolume's accepted range).",
    });
  }
  await rest.put("/composition", {
    tempocontroller: { tempo: { value: bpm } },
  });
}

/**
 * Sends a single tap to the tap-tempo controller. Multiple taps in succession
 * recalibrate Resolume's BPM.
 */
export async function tapTempo(rest: ResolumeRestClient): Promise<void> {
  await rest.put("/composition", {
    tempocontroller: { tempo_tap: { value: true } },
  });
}

/** Resyncs the beat phase relative to the current BPM. */
export async function resyncTempo(rest: ResolumeRestClient): Promise<void> {
  await rest.put("/composition", {
    tempocontroller: { resync: { value: true } },
  });
}
