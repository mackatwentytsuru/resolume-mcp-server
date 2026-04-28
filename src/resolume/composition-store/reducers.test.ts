import { describe, expect, it, vi } from "vitest";
import type { ReceivedOscMessage } from "../osc-client.js";
import {
  applyBeatSnap,
  applyBypass,
  applyConnect,
  applyCrossfader,
  applyFullSeed,
  applyLayerPosition,
  applyOpacity,
  applyOscMessage,
  applySelect,
  applySelectedDeck,
  applySolo,
  applyTempo,
  applyTransportPosition,
  createEmptySnapshot,
} from "./reducers.js";
import type { CachedComposition, Source } from "./types.js";

const noop = () => {};
const ROUTE = { onUnknownAddress: noop, onDriftDetected: noop };

function osc(address: string, args: ReadonlyArray<unknown>, ts = 1_000): ReceivedOscMessage {
  return { address, args: args as never, timestamp: ts };
}

function seedFixture(layerCount = 3, clipCount = 4): CachedComposition {
  const tree = {
    layers: Array.from({ length: layerCount }, (_, i) => ({
      name: { value: `Layer ${i + 1}` },
      bypassed: { value: false },
      solo: { value: false },
      position: { value: 0 },
      video: {
        opacity: { value: 1 },
        mixer: { "Blend Mode": { value: "Add" } },
      },
      clips: Array.from({ length: clipCount }, (_, j) => ({
        name: { value: `clip-${i + 1}-${j + 1}` },
        connected: { value: false },
        selected: { value: false },
        transport: { position: { value: 0 } },
        video: { source: "fixture://x" },
      })),
    })),
    columns: [{ name: { value: "Col1" } }, { name: { value: "Col2" } }],
    decks: [
      { name: { value: "DeckA" }, selected: { value: true } },
      { name: { value: "DeckB" }, selected: { value: false } },
    ],
    tempocontroller: { tempo: { value: 128, min: 60, max: 240 } },
    crossfader: { phase: { value: 0 } },
    clipbeatsnap: { value: "1 Bar", options: ["1/16", "1/4", "1 Bar"] },
  };
  return applyFullSeed(createEmptySnapshot(), tree, 5_000);
}

const NOW = 10_000;
const OSC_SRC: Source = { kind: "osc", receivedAt: NOW };

describe("createEmptySnapshot", () => {
  it("returns a hydrated=false snapshot with zero counts", () => {
    const s = createEmptySnapshot();
    expect(s.revision).toBe(0);
    expect(s.hydrated).toBe(false);
    expect(s.oscLive).toBe(false);
    expect(s.layerCount).toBe(0);
    expect(s.layers).toEqual([]);
    expect(s.beatSnapOptions).toEqual([]);
  });
});

describe("applyFullSeed", () => {
  it("hydrates structural shape from a fixture REST tree", () => {
    const seeded = seedFixture(2, 3);
    expect(seeded.hydrated).toBe(true);
    expect(seeded.lastSeedAt).toBe(5_000);
    expect(seeded.revision).toBe(1);
    expect(seeded.layerCount).toBe(2);
    expect(seeded.layers[0]!.layerIndex).toBe(1);
    expect(seeded.layers[0]!.opacity.value).toBe(1);
    expect(seeded.layers[0]!.blendMode.value).toBe("Add");
    expect(seeded.layers[0]!.clips).toHaveLength(3);
    expect(seeded.layers[0]!.clips[0]!.name.value).toBe("clip-1-1");
    expect(seeded.columnCount).toBe(2);
    expect(seeded.deckCount).toBe(2);
    expect(seeded.deckNames[0]).toBe("DeckA");
    expect(seeded.selectedDeck.value).toBe(1);
    expect(seeded.tempo.bpm.value).toBe(128);
    expect(seeded.tempo.min.value).toBe(60);
    expect(seeded.tempo.max.value).toBe(240);
    expect(seeded.beatSnap.value).toBe("1 Bar");
    expect(seeded.beatSnapOptions).toEqual(["1/16", "1/4", "1 Bar"]);
    expect(seeded.crossfaderPhase.value).toBe(0);
  });

  it("preserves OSC-only bpmNormalized across re-seed", () => {
    let s = seedFixture(1, 1);
    s = applyTempo(s, 0.5, OSC_SRC);
    expect(s.tempo.bpmNormalized.value).toBe(0.5);
    const re = applyFullSeed(s, {
      layers: [],
      tempocontroller: { tempo: { value: 128, min: 60, max: 240 } },
    });
    expect(re.tempo.bpmNormalized.value).toBe(0.5);
  });

  it("treats missing tempo gracefully", () => {
    const s = applyFullSeed(createEmptySnapshot(), { layers: [] });
    expect(s.tempo.bpm.value).toBeNull();
    expect(s.layerCount).toBe(0);
  });

  it("recognizes string-based 'Connected' for clip connected flag", () => {
    const s = applyFullSeed(createEmptySnapshot(), {
      layers: [
        {
          clips: [{ connected: { value: "Connected" } }, { connected: { value: "Disconnected" } }],
        },
      ],
    });
    expect(s.layers[0]!.clips[0]!.connected.value).toBe(true);
    expect(s.layers[0]!.clips[1]!.connected.value).toBe(false);
  });

  it("filters non-string options out of beatSnapOptions", () => {
    const s = applyFullSeed(createEmptySnapshot(), {
      clipbeatsnap: { value: "x", options: ["a", 5, true, "b"] },
    });
    expect(s.beatSnapOptions).toEqual(["a", "b"]);
  });

  it("rejects malformed REST trees that fail Zod parsing", () => {
    expect(() => applyFullSeed(createEmptySnapshot(), { layers: "not-an-array" })).toThrow();
  });

  it("derives hasMedia from the presence of clip.video", () => {
    const s = applyFullSeed(createEmptySnapshot(), {
      layers: [{ clips: [{ video: {} }, {}] }],
    });
    expect(s.layers[0]!.clips[0]!.hasMedia.value).toBe(true);
    expect(s.layers[0]!.clips[1]!.hasMedia.value).toBe(false);
  });
});

describe("applyOpacity", () => {
  it("updates opacity for a valid layer and bumps revision", () => {
    const prev = seedFixture(3, 2);
    const next = applyOpacity(prev, 2, 0.5, OSC_SRC, "/x", ROUTE);
    expect(next).not.toBe(prev);
    expect(next.layers[1]!.opacity.value).toBe(0.5);
    expect(next.revision).toBe(prev.revision + 1);
    // Untouched layers keep identity (structural sharing).
    expect(next.layers[0]).toBe(prev.layers[0]);
    expect(next.layers[2]).toBe(prev.layers[2]);
  });

  it("returns prev unchanged for out-of-range layer and reports drift", () => {
    const prev = seedFixture(3, 2);
    const drift = vi.fn();
    const next = applyOpacity(prev, 9, 0.5, OSC_SRC, "/composition/layers/9/video/opacity", {
      onDriftDetected: drift,
    });
    expect(next).toBe(prev);
    expect(drift).toHaveBeenCalledOnce();
    expect(drift).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 9, address: expect.stringContaining("layers/9") })
    );
  });

  it("returns prev unchanged when value is null", () => {
    const prev = seedFixture(1, 1);
    expect(applyOpacity(prev, 1, null, OSC_SRC, "/x", ROUTE)).toBe(prev);
  });
});

describe("applyTransportPosition (clip-level address)", () => {
  it("honors /composition/layers/N/clips/M/transport/position", () => {
    const prev = seedFixture(2, 3);
    const next = applyOscMessage(
      prev,
      osc("/composition/layers/2/clips/2/transport/position", [0.42], NOW),
      ROUTE
    );
    expect(next.layers[1]!.clips[1]!.transportPosition.value).toBe(0.42);
    expect(next.oscLive).toBe(true);
    expect(next.lastOscAt).toBe(NOW);
  });

  it("does not bump revision when value is identical (high-freq update)", () => {
    let prev = seedFixture(1, 1);
    prev = applyTransportPosition(prev, 1, 1, 0.42, OSC_SRC, "/x", ROUTE);
    const beforeRev = prev.revision;
    const next = applyTransportPosition(prev, 1, 1, 0.42, OSC_SRC, "/x", ROUTE);
    expect(next.revision).toBe(beforeRev);
    // Source object should still be replaced so freshness gate stays accurate.
    expect(next.layers[0]!.clips[0]!.transportPosition.source).toBe(OSC_SRC);
  });

  it("reports drift for out-of-range clip", () => {
    const prev = seedFixture(2, 2);
    const drift = vi.fn();
    const next = applyTransportPosition(
      prev,
      1,
      99,
      0.5,
      OSC_SRC,
      "/composition/layers/1/clips/99/transport/position",
      { onDriftDetected: drift }
    );
    expect(next).toBe(prev);
    expect(drift).toHaveBeenCalledWith(
      expect.objectContaining({ layer: 1, clip: 99 })
    );
  });
});

describe("applyOscMessage routing", () => {
  it("routes opacity correctly", () => {
    const prev = seedFixture(2, 1);
    const next = applyOscMessage(
      prev,
      osc("/composition/layers/1/video/opacity", [0.7], NOW),
      ROUTE
    );
    expect(next.layers[0]!.opacity.value).toBe(0.7);
  });

  it("routes bypass and solo", () => {
    const prev = seedFixture(2, 1);
    const next1 = applyOscMessage(prev, osc("/composition/layers/1/bypassed", [true], NOW), ROUTE);
    expect(next1.layers[0]!.bypassed.value).toBe(true);
    const next2 = applyOscMessage(next1, osc("/composition/layers/1/solo", [true], NOW), ROUTE);
    expect(next2.layers[0]!.solo.value).toBe(true);
  });

  it("routes layer position", () => {
    const prev = seedFixture(2, 1);
    const next = applyOscMessage(
      prev,
      osc("/composition/layers/2/position", [0.33], NOW),
      ROUTE
    );
    expect(next.layers[1]!.position.value).toBe(0.33);
  });

  it("routes clip connect/select", () => {
    const prev = seedFixture(2, 2);
    const next1 = applyOscMessage(
      prev,
      osc("/composition/layers/1/clips/1/connect", [true], NOW),
      ROUTE
    );
    expect(next1.layers[0]!.clips[0]!.connected.value).toBe(true);
    const next2 = applyOscMessage(
      next1,
      osc("/composition/layers/1/clips/1/select", [true], NOW),
      ROUTE
    );
    expect(next2.layers[0]!.clips[0]!.selected.value).toBe(true);
  });

  it("routes tempo, crossfader, beat snap, and selected deck", () => {
    let s = seedFixture(1, 1);
    s = applyOscMessage(s, osc("/composition/tempocontroller/tempo", [0.4], NOW), ROUTE);
    expect(s.tempo.bpmNormalized.value).toBe(0.4);
    s = applyOscMessage(s, osc("/composition/crossfader/phase", [-0.5], NOW), ROUTE);
    expect(s.crossfaderPhase.value).toBe(-0.5);
    s = applyOscMessage(s, osc("/composition/clipbeatsnap", ["1/8"], NOW), ROUTE);
    expect(s.beatSnap.value).toBe("1/8");
    s = applyOscMessage(s, osc("/composition/decks/2/select", [true], NOW), ROUTE);
    expect(s.selectedDeck.value).toBe(2);
  });

  it("routes unknown addresses to onUnknownAddress callback", () => {
    const prev = seedFixture(1, 1);
    const unknown = vi.fn();
    const next = applyOscMessage(
      prev,
      osc("/composition/something/unmapped", [1], NOW),
      { onUnknownAddress: unknown }
    );
    // First unknown packet bumps oscLive (anything Resolume emits is a sign of life).
    expect(next.oscLive).toBe(true);
    expect(next.lastOscAt).toBe(NOW);
    expect(unknown).toHaveBeenCalledOnce();
    expect(unknown).toHaveBeenCalledWith("/composition/something/unmapped");
  });

  it("debounces lastOscAt updates on unknown-address storm (~50 ms window)", () => {
    const seed = seedFixture(1, 1);
    const unknown = vi.fn();
    // First packet promotes oscLive and stamps lastOscAt.
    const s1 = applyOscMessage(
      seed,
      osc("/composition/something/unmapped", [1], NOW),
      { onUnknownAddress: unknown }
    );
    expect(s1.oscLive).toBe(true);
    expect(s1.lastOscAt).toBe(NOW);

    // Subsequent unknown packets within 50 ms return the previous snapshot
    // unchanged — same identity, no fresh allocation. Callback still fires.
    const s2 = applyOscMessage(
      s1,
      osc("/composition/something/else", [2], NOW + 10),
      { onUnknownAddress: unknown }
    );
    expect(s2).toBe(s1);
    const s3 = applyOscMessage(
      s2,
      osc("/composition/yet/another", [3], NOW + 49),
      { onUnknownAddress: unknown }
    );
    expect(s3).toBe(s1);

    // After the debounce window elapses, lastOscAt updates again.
    const s4 = applyOscMessage(
      s3,
      osc("/composition/and/another", [4], NOW + 50),
      { onUnknownAddress: unknown }
    );
    expect(s4).not.toBe(s1);
    expect(s4.lastOscAt).toBe(NOW + 50);

    // Callback fires every time, regardless of debounce.
    expect(unknown).toHaveBeenCalledTimes(4);
  });

  it("clipbeatsnap with non-string arg is ignored but oscLive still updates", () => {
    const prev = seedFixture(1, 1);
    const next = applyOscMessage(prev, osc("/composition/clipbeatsnap", [42], NOW), ROUTE);
    expect(next.beatSnap.value).toBe(prev.beatSnap.value);
    expect(next.oscLive).toBe(true);
  });

  it("decks/N/select with selected=false leaves selectedDeck unchanged", () => {
    let s = seedFixture(1, 1);
    s = applyOscMessage(s, osc("/composition/decks/2/select", [true], NOW), ROUTE);
    expect(s.selectedDeck.value).toBe(2);
    s = applyOscMessage(s, osc("/composition/decks/2/select", [false], NOW), ROUTE);
    expect(s.selectedDeck.value).toBe(2);
  });

  it("interprets numeric and string truthy values for booleans", () => {
    const prev = seedFixture(1, 1);
    const next1 = applyOscMessage(
      prev,
      osc("/composition/layers/1/clips/1/connect", [1], NOW),
      ROUTE
    );
    expect(next1.layers[0]!.clips[0]!.connected.value).toBe(true);
    const next2 = applyOscMessage(
      prev,
      osc("/composition/layers/1/clips/1/connect", ["Connected"], NOW),
      ROUTE
    );
    expect(next2.layers[0]!.clips[0]!.connected.value).toBe(true);
  });
});

describe("immutability / structural sharing", () => {
  it("changing one clip leaves siblings untouched (===)", () => {
    const prev = seedFixture(2, 3);
    const next = applyOscMessage(
      prev,
      osc("/composition/layers/1/clips/2/transport/position", [0.5], NOW),
      ROUTE
    );
    expect(next).not.toBe(prev);
    expect(next.layers[1]).toBe(prev.layers[1]); // untouched layer
    const targetLayer = next.layers[0]!;
    expect(targetLayer.clips[0]).toBe(prev.layers[0]!.clips[0]);
    expect(targetLayer.clips[2]).toBe(prev.layers[0]!.clips[2]);
    expect(targetLayer.clips[1]).not.toBe(prev.layers[0]!.clips[1]);
  });

  it("does not bump revision for no-op writes (same value)", () => {
    let s = seedFixture(1, 1);
    s = applyOpacity(s, 1, 0.5, OSC_SRC, "/x", ROUTE);
    const r1 = s.revision;
    s = applyOpacity(s, 1, 0.5, OSC_SRC, "/x", ROUTE);
    expect(s.revision).toBe(r1);
  });
});

describe("simple sub-reducer ergonomics", () => {
  it("applyBypass / applySolo no-op on identical values", () => {
    const prev = seedFixture(1, 1);
    expect(applyBypass(prev, 1, false, OSC_SRC, "/x", ROUTE)).toBe(prev);
    expect(applySolo(prev, 1, false, OSC_SRC, "/x", ROUTE)).toBe(prev);
  });

  it("applyConnect / applySelect no-op on identical values", () => {
    const prev = seedFixture(1, 1);
    expect(applyConnect(prev, 1, 1, false, OSC_SRC, "/x", ROUTE)).toBe(prev);
    expect(applySelect(prev, 1, 1, false, OSC_SRC, "/x", ROUTE)).toBe(prev);
  });

  it("applyTempo with null is no-op", () => {
    const prev = seedFixture(1, 1);
    expect(applyTempo(prev, null, OSC_SRC)).toBe(prev);
  });

  it("applyTempo same value returns prev unchanged (structural share)", () => {
    let s = seedFixture(1, 1);
    s = applyTempo(s, 0.5, OSC_SRC);
    const after = applyTempo(s, 0.5, OSC_SRC);
    // Identity-equal — no allocation when value matches the previous observation.
    expect(after).toBe(s);
    expect(after.tempo.bpmNormalized.value).toBe(0.5);
  });

  it("applyCrossfader same value refreshes source without revision bump", () => {
    let s = seedFixture(1, 1);
    s = applyCrossfader(s, 0.3, OSC_SRC);
    const r1 = s.revision;
    s = applyCrossfader(s, 0.3, OSC_SRC);
    expect(s.revision).toBe(r1);
  });

  it("applyBeatSnap no-op when same", () => {
    const prev = seedFixture(1, 1);
    expect(applyBeatSnap(prev, prev.beatSnap.value!, OSC_SRC)).toBe(prev);
  });

  it("applySelectedDeck reselect=false ignored", () => {
    const prev = seedFixture(1, 1);
    expect(applySelectedDeck(prev, 1, false, OSC_SRC)).toBe(prev);
  });

  it("applyLayerPosition out-of-range layer triggers drift", () => {
    const prev = seedFixture(1, 1);
    const drift = vi.fn();
    const next = applyLayerPosition(prev, 5, 0.4, OSC_SRC, "/x", { onDriftDetected: drift });
    expect(next).toBe(prev);
    expect(drift).toHaveBeenCalledOnce();
  });

  it("applyLayerPosition same value still updates source freshness without revision bump", () => {
    let s = seedFixture(1, 1);
    s = applyLayerPosition(s, 1, 0.5, OSC_SRC, "/x", ROUTE);
    const r1 = s.revision;
    s = applyLayerPosition(s, 1, 0.5, OSC_SRC, "/x", ROUTE);
    expect(s.revision).toBe(r1);
  });
});
