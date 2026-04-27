import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TTL_MS, ageMs, isFresh, sourceTimestamp } from "./ttl.js";
import type { Source } from "./types.js";

describe("DEFAULT_TTL_MS", () => {
  it("matches the values from the design table", () => {
    expect(DEFAULT_TTL_MS.transportPosition).toBe(250);
    expect(DEFAULT_TTL_MS.opacity).toBe(5_000);
    expect(DEFAULT_TTL_MS.bypassed).toBe(5_000);
    expect(DEFAULT_TTL_MS.solo).toBe(5_000);
    expect(DEFAULT_TTL_MS.bpm).toBe(2_000);
    expect(DEFAULT_TTL_MS.crossfaderPhase).toBe(2_000);
    expect(DEFAULT_TTL_MS.structural).toBe(30_000);
  });

  it("is frozen so callers cannot mutate the table", () => {
    expect(Object.isFrozen(DEFAULT_TTL_MS)).toBe(true);
  });
});

describe("sourceTimestamp", () => {
  it("returns OSC receivedAt", () => {
    expect(sourceTimestamp({ kind: "osc", receivedAt: 1234 })).toBe(1234);
  });

  it("returns REST fetchedAt", () => {
    expect(sourceTimestamp({ kind: "rest", fetchedAt: 9876 })).toBe(9876);
  });

  it("returns null for unknown source", () => {
    expect(sourceTimestamp({ kind: "unknown" })).toBeNull();
  });
});

describe("isFresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true at age 0", () => {
    const source: Source = { kind: "osc", receivedAt: Date.now() };
    expect(isFresh(source, "transportPosition")).toBe(true);
  });

  it("flips false strictly after the TTL boundary for transportPosition (250 ms)", () => {
    const t0 = Date.now();
    const source: Source = { kind: "osc", receivedAt: t0 };
    // At exactly 250 ms, still fresh.
    vi.setSystemTime(t0 + 250);
    expect(isFresh(source, "transportPosition")).toBe(true);
    // 1 ms past the threshold, stale.
    vi.setSystemTime(t0 + 251);
    expect(isFresh(source, "transportPosition")).toBe(false);
  });

  it("flips false strictly after the TTL boundary for opacity (5000 ms)", () => {
    const t0 = Date.now();
    const source: Source = { kind: "osc", receivedAt: t0 };
    vi.setSystemTime(t0 + 5_000);
    expect(isFresh(source, "opacity")).toBe(true);
    vi.setSystemTime(t0 + 5_001);
    expect(isFresh(source, "opacity")).toBe(false);
  });

  it("flips false strictly after the TTL boundary for bpm (2000 ms)", () => {
    const t0 = Date.now();
    const source: Source = { kind: "rest", fetchedAt: t0 };
    vi.setSystemTime(t0 + 2_000);
    expect(isFresh(source, "bpm")).toBe(true);
    vi.setSystemTime(t0 + 2_001);
    expect(isFresh(source, "bpm")).toBe(false);
  });

  it("flips false strictly after the TTL boundary for structural (30000 ms)", () => {
    const t0 = Date.now();
    const source: Source = { kind: "rest", fetchedAt: t0 };
    vi.setSystemTime(t0 + 30_000);
    expect(isFresh(source, "structural")).toBe(true);
    vi.setSystemTime(t0 + 30_001);
    expect(isFresh(source, "structural")).toBe(false);
  });

  it("treats unknown source as stale", () => {
    expect(isFresh({ kind: "unknown" }, "transportPosition")).toBe(false);
  });

  it("respects the 'now' parameter override", () => {
    const source: Source = { kind: "osc", receivedAt: 1_000 };
    expect(isFresh(source, "bpm", 1_500)).toBe(true);
    expect(isFresh(source, "bpm", 4_000)).toBe(false);
  });

  it("treats REST and OSC sources symmetrically (both timestamp-based)", () => {
    const t0 = Date.now();
    const restSrc: Source = { kind: "rest", fetchedAt: t0 };
    const oscSrc: Source = { kind: "osc", receivedAt: t0 };
    vi.setSystemTime(t0 + 100);
    expect(isFresh(restSrc, "transportPosition")).toBe(true);
    expect(isFresh(oscSrc, "transportPosition")).toBe(true);
    vi.setSystemTime(t0 + 1_000);
    expect(isFresh(restSrc, "transportPosition")).toBe(false);
    expect(isFresh(oscSrc, "transportPosition")).toBe(false);
  });
});

describe("ageMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns elapsed time since OSC packet", () => {
    const t0 = Date.now();
    const source: Source = { kind: "osc", receivedAt: t0 };
    vi.setSystemTime(t0 + 1234);
    expect(ageMs(source)).toBe(1234);
  });

  it("returns null for unknown sources", () => {
    expect(ageMs({ kind: "unknown" })).toBeNull();
  });

  it("never returns negative ages even if clock skews", () => {
    const source: Source = { kind: "osc", receivedAt: Date.now() + 5_000 };
    expect(ageMs(source)).toBe(0);
  });
});
