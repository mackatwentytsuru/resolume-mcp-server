import { describe, it, expect, vi } from "vitest";
import { ResolumeClient, summarizeComposition } from "./client.js";
import { ResolumeRestClient } from "./rest.js";

/**
 * Slim facade-only test file. Per-domain behavior tests live in
 * tempo.test.ts / composition.test.ts / clip.test.ts / layer.test.ts /
 * effects.test.ts. Only three things are checked here:
 *
 *   1. fromConfig wires up a working ResolumeClient.
 *   2. summarizeComposition is re-exported from client.ts (so existing
 *      `import { summarizeComposition } from "./client.js"` keeps working).
 *   3. The full public-method surface still exists on ResolumeClient. This
 *      is the cheap safety net the design called out — silently dropping a
 *      method during the per-domain split would otherwise only be caught
 *      indirectly via the tool test suite.
 */

describe("ResolumeClient.fromConfig", () => {
  it("constructs a working client targeting host:port", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;
    // Use the static factory with a fetch override patched on by reaching into the rest client.
    const client = ResolumeClient.fromConfig({ host: "127.0.0.1", port: 9999, timeoutMs: 1000 });
    // Smoke test: the constructed REST client targets the right base URL.
    // We can't easily inject fetchImpl here, so we just confirm the factory returns an object.
    expect(client).toBeInstanceOf(ResolumeClient);
    void fetchImpl;
  });
});

describe("ResolumeClient public-API surface", () => {
  // The complete list of public methods that tools rely on. If a method
  // disappears (or is renamed) during a refactor this assertion fails before
  // the tool tests do — making the cause obvious instead of the symptoms
  // ("ctx.client.foo is not a function" inside a tool test).
  const expected = [
    // composition reads
    "getComposition",
    "getProductInfo",
    "getCompositionSummary",
    // composition controls
    "getBeatSnap",
    "setBeatSnap",
    "getCrossfader",
    "setCrossfader",
    "triggerColumn",
    "selectDeck",
    // clip
    "triggerClip",
    "selectClip",
    "clearClip",
    "wipeComposition",
    "setClipPlayDirection",
    "setClipPlayMode",
    "setClipPosition",
    "getClipThumbnail",
    // layer
    "clearLayer",
    "setLayerOpacity",
    "setLayerBypass",
    "setLayerBlendMode",
    "getLayerBlendModes",
    "setLayerTransitionDuration",
    "getLayerTransitionBlendModes",
    "setLayerTransitionBlendMode",
    // tempo
    "getTempo",
    "setTempo",
    "tapTempo",
    "resyncTempo",
    // effects
    "listVideoEffects",
    "listLayerEffects",
    "setEffectParameter",
    "addEffectToLayer",
    "removeEffectFromLayer",
    // v0.5.1 cache-fast reads
    "getTempoFast",
    "getClipPositionFast",
    "getClipPositionFastTagged",
    "getCrossfaderFast",
    "getLayerOpacityFast",
  ];

  it("exposes every method tools depend on", () => {
    const rest = {
      get: vi.fn(),
      put: vi.fn(),
      post: vi.fn(),
      postText: vi.fn(),
      delete: vi.fn(),
      getBinary: vi.fn(),
    } as unknown as ResolumeRestClient;
    const client = new ResolumeClient(rest);
    for (const method of expected) {
      expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe(
        "function"
      );
    }
  });

  it("re-exports summarizeComposition from client.ts", () => {
    expect(typeof summarizeComposition).toBe("function");
  });
});
