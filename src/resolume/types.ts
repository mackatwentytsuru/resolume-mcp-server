import { z } from "zod";

/**
 * Resolume parameters are wrapped objects: { id, value, valuetype, ... }.
 * We model the most common shapes with permissive schemas — the API differs
 * between Arena 7.x minor versions, so we keep unknown keys.
 */
export const ParameterSchema = z
  .object({
    id: z.number().optional(),
    value: z.unknown().optional(),
    valuetype: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const ClipSchema = z
  .object({
    id: z.number().optional(),
    name: ParameterSchema.optional(),
    connected: ParameterSchema.optional(),
    selected: ParameterSchema.optional(),
    video: z.unknown().optional(),
    audio: z.unknown().optional(),
    transport: z.unknown().optional(),
  })
  .passthrough();

export const LayerSchema = z
  .object({
    id: z.number().optional(),
    name: ParameterSchema.optional(),
    clips: z.array(ClipSchema).optional(),
    video: z.unknown().optional(),
    audio: z.unknown().optional(),
    bypassed: ParameterSchema.optional(),
    solo: ParameterSchema.optional(),
  })
  .passthrough();

export const ColumnSchema = z
  .object({
    id: z.number().optional(),
    name: ParameterSchema.optional(),
  })
  .passthrough();

export const DeckSchema = z
  .object({
    id: z.number().optional(),
    name: ParameterSchema.optional(),
    selected: ParameterSchema.optional(),
  })
  .passthrough();

export const CompositionSchema = z
  .object({
    name: ParameterSchema.optional(),
    layers: z.array(LayerSchema).optional(),
    columns: z.array(ColumnSchema).optional(),
    decks: z.array(DeckSchema).optional(),
    tempocontroller: z.unknown().optional(),
  })
  .passthrough();

export const ProductInfoSchema = z
  .object({
    name: z.string().optional(),
    major: z.number().optional(),
    minor: z.number().optional(),
    micro: z.number().optional(),
    revision: z.number().optional(),
  })
  .passthrough();

export type Composition = z.infer<typeof CompositionSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type ProductInfo = z.infer<typeof ProductInfoSchema>;

/** Minimal projection of composition state for LLM consumption. */
export interface CompositionSummary {
  productVersion: string | null;
  layerCount: number;
  columnCount: number;
  deckCount: number;
  layers: Array<{ index: number; name: string; clipCount: number; connectedClip: number | null }>;
  columns: Array<{ index: number; name: string }>;
  decks: Array<{ index: number; name: string; selected: boolean }>;
}
