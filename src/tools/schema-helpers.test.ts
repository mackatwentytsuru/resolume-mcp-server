import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  clipIndexSchema,
  confirmSchema,
  effectIndexSchema,
  layerIndexSchema,
} from "./schema-helpers.js";

/**
 * v0.5.3 regression: some MCP transports stringify primitives, including booleans
 * (live-discovered against Resolume Arena 7.23.2 via `resolume_remove_effect_from_layer`).
 * These tests assert the helper schemas tolerate string-typed wire encodings while
 * preserving safety guarantees on `confirm`.
 */

describe("layerIndexSchema (v0.5.3 wire coercion)", () => {
  it("accepts a JS number", () => {
    expect(layerIndexSchema.parse(3)).toBe(3);
  });
  it("accepts a numeric string and coerces to number", () => {
    expect(layerIndexSchema.parse("3")).toBe(3);
  });
  it("rejects 0", () => {
    expect(() => layerIndexSchema.parse(0)).toThrow();
    expect(() => layerIndexSchema.parse("0")).toThrow();
  });
  it("rejects out-of-range", () => {
    expect(() => layerIndexSchema.parse(10000)).toThrow();
    expect(() => layerIndexSchema.parse("10000")).toThrow();
  });
  it("rejects non-numeric strings", () => {
    expect(() => layerIndexSchema.parse("abc")).toThrow();
    expect(() => layerIndexSchema.parse("")).toThrow();
  });
  it("rejects non-integers", () => {
    expect(() => layerIndexSchema.parse(1.5)).toThrow();
    expect(() => layerIndexSchema.parse("1.5")).toThrow();
  });
});

describe("clipIndexSchema (v0.5.3 wire coercion)", () => {
  it("accepts a JS number", () => {
    expect(clipIndexSchema.parse(2)).toBe(2);
  });
  it("accepts a numeric string", () => {
    expect(clipIndexSchema.parse("2")).toBe(2);
  });
});

describe("effectIndexSchema (v0.5.3 wire coercion)", () => {
  it("accepts a JS number", () => {
    expect(effectIndexSchema.parse(5)).toBe(5);
  });
  it("accepts a numeric string", () => {
    expect(effectIndexSchema.parse("5")).toBe(5);
  });
  it("caps at 99 (effects array max)", () => {
    expect(() => effectIndexSchema.parse(100)).toThrow();
    expect(() => effectIndexSchema.parse("100")).toThrow();
  });
});

describe("confirmSchema (v0.5.3 wire coercion + safety)", () => {
  it("accepts boolean true and returns true", () => {
    expect(confirmSchema.parse(true)).toBe(true);
  });
  it("accepts boolean false and returns false", () => {
    expect(confirmSchema.parse(false)).toBe(false);
  });
  it("accepts string \"true\" and returns true (wire-stringified)", () => {
    expect(confirmSchema.parse("true")).toBe(true);
  });
  it("accepts string \"false\" and returns false (wire-stringified)", () => {
    expect(confirmSchema.parse("false")).toBe(false);
  });
  it("REJECTS string \"yes\" — only the literal strings true/false are accepted", () => {
    expect(() => confirmSchema.parse("yes")).toThrow();
  });
  it("REJECTS string \"1\" — JavaScript Boolean() coercion is intentionally NOT used", () => {
    // Critical safety property: `Boolean("false")` is true in JS. If we used
    // z.coerce.boolean() here, then a destructive op called with confirm:"false"
    // would silently authorise. The explicit union prevents this.
    expect(() => confirmSchema.parse("1")).toThrow();
    expect(() => confirmSchema.parse("0")).toThrow();
  });
  it("REJECTS numeric values", () => {
    expect(() => confirmSchema.parse(1)).toThrow();
    expect(() => confirmSchema.parse(0)).toThrow();
  });
  it("REJECTS null/undefined", () => {
    expect(() => confirmSchema.parse(null)).toThrow();
    expect(() => confirmSchema.parse(undefined)).toThrow();
  });
});

describe("composed destructive-op schema (v0.5.3 end-to-end)", () => {
  // Mimics the exact shape of `removeEffectFromLayer`'s inputSchema after the
  // v0.5.3 fix: layer + effectIndex (numerics) + confirm. All three are
  // simultaneously what the live-repro had as strings.
  const composed = z
    .object({
      layer: layerIndexSchema,
      effectIndex: effectIndexSchema,
      confirm: confirmSchema,
    })
    .strict();

  it("accepts the v0.5.3 live-repro stringified payload", () => {
    // This is the EXACT shape the wire delivered when the bug fired:
    //   { layer: "1", effectIndex: "2", confirm: "true" }
    const out = composed.parse({ layer: "1", effectIndex: "2", confirm: "true" });
    expect(out).toEqual({ layer: 1, effectIndex: 2, confirm: true });
  });

  it("accepts canonical (number, number, boolean) payload", () => {
    const out = composed.parse({ layer: 1, effectIndex: 2, confirm: true });
    expect(out).toEqual({ layer: 1, effectIndex: 2, confirm: true });
  });

  it("accepts mixed-type payload", () => {
    const out = composed.parse({ layer: 1, effectIndex: "2", confirm: "true" });
    expect(out).toEqual({ layer: 1, effectIndex: 2, confirm: true });
  });

  it("still refuses confirm=false (safety: handler will see false and refuse)", () => {
    const out = composed.parse({ layer: 1, effectIndex: 2, confirm: false });
    expect(out.confirm).toBe(false);
  });

  it("rejects confirm=\"FALSE\" (case-sensitive — only exact \"true\"/\"false\")", () => {
    expect(() =>
      composed.parse({ layer: 1, effectIndex: 2, confirm: "FALSE" })
    ).toThrow();
  });
});
