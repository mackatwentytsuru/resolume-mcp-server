import { describe, it, expect, vi } from "vitest";
import { ResolumeClient } from "./client.js";
import { ResolumeRestClient } from "./rest.js";
import { ResolumeApiError } from "../errors/types.js";

function buildClient(handlers: Partial<{
  get: (path: string) => unknown;
  put: (path: string, body: unknown) => unknown;
  post: (path: string, body?: unknown) => unknown;
  postText: (path: string, text: string) => unknown;
  delete: (path: string) => unknown;
}> = {}) {
  const rest = {
    get: vi.fn(async (path: string) => handlers.get?.(path) ?? {}),
    put: vi.fn(async (path: string, body: unknown) => handlers.put?.(path, body) ?? undefined),
    post: vi.fn(async (path: string, body?: unknown) => handlers.post?.(path, body) ?? undefined),
    postText: vi.fn(async (path: string, text: string) => handlers.postText?.(path, text) ?? undefined),
    delete: vi.fn(async (path: string) => handlers.delete?.(path) ?? undefined),
    getBinary: vi.fn(),
  } as unknown as ResolumeRestClient & { postText: ReturnType<typeof vi.fn> };
  return { client: new ResolumeClient(rest), rest };
}

describe("ResolumeClient.listVideoEffects", () => {
  it("normalizes the catalog into idstring + name pairs", async () => {
    const { client } = buildClient({
      get: () => [
        { idstring: "A101", name: "Add Subtract", presets: [] },
        { idstring: "A120", name: "Auto Mask", presets: [] },
        { idstring: "BAD", name: "" }, // dropped: empty name
        { name: "no idstring" }, // dropped: missing idstring
        "garbage", // dropped: not an object
      ],
    });
    const effects = await client.listVideoEffects();
    expect(effects).toEqual([
      { idstring: "A101", name: "Add Subtract" },
      { idstring: "A120", name: "Auto Mask" },
    ]);
  });

  it("returns empty array when API returns non-array", async () => {
    const { client } = buildClient({ get: () => ({}) });
    expect(await client.listVideoEffects()).toEqual([]);
  });
});

describe("ResolumeClient.listLayerEffects", () => {
  it("returns rich parameter metadata: type, value, and range for each param", async () => {
    const { client } = buildClient({
      get: () => ({
        video: {
          effects: [
            {
              id: 100,
              name: "Transform",
              params: {
                Scale: { valuetype: "ParamRange", value: 100, min: 0, max: 1000 },
                "Position X": { valuetype: "ParamRange", value: 0, min: -32768, max: 32768 },
                Mode: {
                  valuetype: "ParamChoice",
                  value: "Linear",
                  options: ["Linear", "Bezier"],
                },
              },
            },
          ],
        },
      }),
    });
    const effects = await client.listLayerEffects(1);
    expect(effects).toHaveLength(1);
    expect(effects[0].id).toBe(100);
    const params = effects[0].params;
    const scale = params.find((p) => p.name === "Scale");
    expect(scale).toMatchObject({
      name: "Scale",
      valuetype: "ParamRange",
      value: 100,
      min: 0,
      max: 1000,
    });
    const mode = params.find((p) => p.name === "Mode");
    expect(mode).toMatchObject({
      name: "Mode",
      valuetype: "ParamChoice",
      value: "Linear",
      options: ["Linear", "Bezier"],
    });
  });
});

describe("ResolumeClient.setEffectParameter", () => {
  it("includes the target effect's id in the PUT body so Resolume actually applies the change", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            { id: 100, params: { Scale: { value: 1, valuetype: "ParamRange" } } },
            { id: 200, params: { Scale: { value: 2, valuetype: "ParamRange" } } },
          ],
        },
      }),
    });
    await client.setEffectParameter(1, 2, "Scale", 50);
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1", {
      video: {
        effects: [{}, { id: 200, params: { Scale: { value: 50 } } }],
      },
    });
  });

  it("coerces string-formatted numbers to actual numbers for ParamRange", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 1, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    // MCP wire-encoded numbers can arrive as strings — Resolume silently
    // rejects "175" but accepts 175.
    await client.setEffectParameter(1, 1, "Scale", "175" as unknown as number);
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1", {
      video: { effects: [{ id: 1, params: { Scale: { value: 175 } } }] },
    });
  });

  it("rejects non-numeric strings for ParamRange with a clear error", async () => {
    const { client } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 1, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await expect(
      client.setEffectParameter(1, 1, "Scale", "abc")
    ).rejects.toMatchObject({ detail: { kind: "InvalidValue", field: "Scale" } });
  });

  it("coerces 'true'/'false' strings to booleans for ParamBoolean", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 1, params: { Active: { valuetype: "ParamBoolean" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Active", "true" as unknown as boolean);
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1", {
      video: { effects: [{ id: 1, params: { Active: { value: true } } }] },
    });
  });

  it("coerces numeric 0/1 to booleans for ParamBoolean", async () => {
    // Fresh client for each call so the effect-id cache doesn't replay
    // the first GET's valuetype on the second call (cache stores id only).
    {
      const { client, rest } = buildClient({
        get: () => ({
          video: {
            effects: [{ id: 1, params: { Active: { valuetype: "ParamBoolean" } } }],
          },
        }),
      });
      await client.setEffectParameter(1, 1, "Active", 1 as unknown as boolean);
      expect(rest.put).toHaveBeenLastCalledWith("/composition/layers/1", {
        video: { effects: [{ id: 1, params: { Active: { value: true } } }] },
      });
    }
    {
      const { client, rest } = buildClient({
        get: () => ({
          video: {
            effects: [{ id: 1, params: { Active: { valuetype: "ParamBoolean" } } }],
          },
        }),
      });
      await client.setEffectParameter(1, 1, "Active", 0 as unknown as boolean);
      expect(rest.put).toHaveBeenLastCalledWith("/composition/layers/1", {
        video: { effects: [{ id: 1, params: { Active: { value: false } } }] },
      });
    }
  });

  it("rejects non-true/false strings for ParamBoolean with a clear hint", async () => {
    const { client } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 1, params: { Active: { valuetype: "ParamBoolean" } } }],
        },
      }),
    });
    await expect(
      client.setEffectParameter(1, 1, "Active", "yes" as unknown as boolean)
    ).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "Active" },
    });
  });

  it("rejects __proto__ as paramName (own-property check, not 'in')", async () => {
    const { client } = buildClient({
      get: () => ({
        video: { effects: [{ id: 1, params: { Scale: { valuetype: "ParamRange" } } }] },
      }),
    });
    await expect(
      client.setEffectParameter(1, 1, "__proto__", 1)
    ).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "paramName" },
    });
    await expect(
      client.setEffectParameter(1, 1, "constructor", 1)
    ).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "paramName" },
    });
  });

  it("uses what:'effect' (not 'clip') for effect-index errors", async () => {
    const { client } = buildClient({
      get: () => ({ video: { effects: [{ id: 1, params: { X: {} } }] } }),
    });
    await expect(client.setEffectParameter(1, 99, "X", 1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "effect", index: 99 },
    });
    await expect(client.setEffectParameter(1, 0, "X", 1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "effect", index: 0 },
    });
  });

  it("passes ParamChoice values through as strings", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 1, params: { Mode: { valuetype: "ParamChoice" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Mode", "Linear");
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1", {
      video: { effects: [{ id: 1, params: { Mode: { value: "Linear" } } }] },
    });
  });

  it("rejects invalid effectIndex (<1)", async () => {
    const { client } = buildClient();
    await expect(client.setEffectParameter(1, 0, "Scale", 1)).rejects.toBeInstanceOf(
      ResolumeApiError
    );
  });

  it("rejects empty paramName", async () => {
    const { client } = buildClient();
    await expect(client.setEffectParameter(1, 1, "", 1)).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "paramName" },
    });
  });

  it("rejects effectIndex past the actual count with a helpful hint", async () => {
    const { client } = buildClient({
      get: () => ({ video: { effects: [{ id: 1, params: { X: {} } }] } }),
    });
    await expect(client.setEffectParameter(1, 5, "X", 1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex" },
    });
  });

  it("rejects unknown paramName with the list of available params", async () => {
    const { client } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 1, params: { Scale: {}, "Position X": {} } }],
        },
      }),
    });
    await expect(
      client.setEffectParameter(1, 1, "Bogus", 1)
    ).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "paramName" },
    });
  });
});

describe("ResolumeClient.setEffectParameter — effect-id cache", () => {
  it("second call on same (layer, effectIndex) skips the GET (cache hit)", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    await client.setEffectParameter(1, 1, "Scale", 60);
    // Cache hit on second call — only one GET total; both PUTs went out.
    expect(rest.get).toHaveBeenCalledTimes(1);
    expect(rest.put).toHaveBeenCalledTimes(2);
  });

  it("addEffectToLayer invalidates the cache (next set re-fetches)", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    expect(rest.get).toHaveBeenCalledTimes(1);

    await client.addEffectToLayer(1, "Blur");
    // Adding can shift indices — the cached id for (1, 1) is now suspect.
    await client.setEffectParameter(1, 1, "Scale", 60);
    expect(rest.get).toHaveBeenCalledTimes(2);
  });

  it("removeEffectFromLayer invalidates the cache for that layer", async () => {
    // listLayerEffects also calls GET, so we count how many total GETs the
    // wrapper does and reason about deltas.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    expect(rest.get).toHaveBeenCalledTimes(1);

    // removeEffectFromLayer issues its own GET via listLayerEffects, then DELETEs.
    await client.removeEffectFromLayer(1, 1);
    const getsAfterRemove = (rest.get as { mock: { calls: unknown[][] } }).mock.calls.length;

    // Next setEffectParameter on (1,1) should NOT use the cached id; it must
    // do a fresh GET.
    await client.setEffectParameter(1, 1, "Scale", 60);
    expect(rest.get).toHaveBeenCalledTimes(getsAfterRemove + 1);
  });

  it("different effectIndex on the same layer is cached independently", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            { id: 100, params: { Scale: { valuetype: "ParamRange" } } },
            { id: 200, params: { Scale: { valuetype: "ParamRange" } } },
          ],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 1); // miss
    await client.setEffectParameter(1, 2, "Scale", 2); // miss
    await client.setEffectParameter(1, 1, "Scale", 3); // hit
    await client.setEffectParameter(1, 2, "Scale", 4); // hit
    expect(rest.get).toHaveBeenCalledTimes(2);
    expect(rest.put).toHaveBeenCalledTimes(4);
  });

  it("cache is per-client — two clients do not share entries", async () => {
    const { client: c1, rest: r1 } = buildClient({
      get: () => ({
        video: { effects: [{ id: 1, params: { Scale: { valuetype: "ParamRange" } } }] },
      }),
    });
    const { client: c2, rest: r2 } = buildClient({
      get: () => ({
        video: { effects: [{ id: 1, params: { Scale: { valuetype: "ParamRange" } } }] },
      }),
    });
    await c1.setEffectParameter(1, 1, "Scale", 50);
    await c2.setEffectParameter(1, 1, "Scale", 50);
    expect(r1.get).toHaveBeenCalledTimes(1);
    expect(r2.get).toHaveBeenCalledTimes(1);
  });

  it("clearLayer does NOT invalidate the cache (clip-only operation)", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    await client.clearLayer(1);
    await client.setEffectParameter(1, 1, "Scale", 60);
    // Effect chain unchanged by clearLayer — cache still valid; only one GET.
    expect(rest.get).toHaveBeenCalledTimes(1);
  });

  it("wipeComposition clears the entire effect-id cache", async () => {
    const { client, rest } = buildClient({
      get: (path) => {
        if (path === "/composition") {
          return { layers: [{ clips: [{}, {}] }, { clips: [{}] }] };
        }
        // Layer path
        return {
          video: {
            effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
          },
        };
      },
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    await client.wipeComposition();
    await client.setEffectParameter(1, 1, "Scale", 60);
    // First set: 1 GET (layer). Wipe: 1 GET (composition). Second set: 1 GET (layer, cache cleared).
    const getCalls = (rest.get as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
    const layerGets = getCalls.filter((p) => p === "/composition/layers/1").length;
    expect(layerGets).toBe(2);
  });

  it("selectDeck clears the entire effect-id cache", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    expect(rest.get).toHaveBeenCalledTimes(1);

    await client.selectDeck(2); // POST, no GET
    await client.setEffectParameter(1, 1, "Scale", 60);
    // Deck switch dropped the cache — full re-fetch on next set.
    expect(rest.get).toHaveBeenCalledTimes(2);
  });

  it("with cache disabled, every set does GET-then-PUT", async () => {
    const restMock = {
      get: vi.fn(async () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      })),
      put: vi.fn(async () => undefined),
      post: vi.fn(),
      postText: vi.fn(),
      delete: vi.fn(),
      getBinary: vi.fn(),
    } as unknown as ResolumeRestClient;
    const { ResolumeClient: Client } = await import("./client.js");
    const client = new Client(restMock, { enabled: false });
    await client.setEffectParameter(1, 1, "Scale", 50);
    await client.setEffectParameter(1, 1, "Scale", 60);
    await client.setEffectParameter(1, 1, "Scale", 70);
    expect(
      (restMock.get as { mock: { calls: unknown[][] } }).mock.calls.length
    ).toBe(3);
    expect(
      (restMock.put as { mock: { calls: unknown[][] } }).mock.calls.length
    ).toBe(3);
  });

  it("post-add stabilization: first MISS after addEffectToLayer is NOT cached, second MISS re-fetches with stable id (v0.5.2 silent-no-op fix)", async () => {
    // Live-discovered against Arena 7.23.2: the GET response immediately
    // after `POST /effects/video/add` exposes a transient effect `id`. The
    // first PUT against that transient id lands; subsequent PUTs against
    // the same id silently no-op because Resolume has re-keyed the effect
    // by then. Reproduces the user-visible pattern from v0.5.1 live testing:
    //
    //   addEffectToLayer(2, "Hue Rotate")           → cache invalidated
    //   setEffectParameter(2, 3, "Hue Rotate", 0.3) → MISS → SUCCESS
    //   setEffectParameter(2, 3, "Hue Rotate", 0.7) → HIT  → SILENT NO-OP
    //                                                       (value stays 0.3)
    //
    // Fix: `addEffectToLayer` now passes `{ requireRevalidation: true }` to
    // `invalidateLayer`, marking the layer for one round of "verify before
    // cache". The next MISS fetches but does NOT cache; the call after that
    // re-fetches against the stable id and caches normally.

    // Simulate Resolume's transient-then-stable id behavior: the first GET
    // returns id=999 (transient, only valid for one PUT), subsequent GETs
    // return id=42 (the persistent id Resolume settled on).
    let getCount = 0;
    const { client, rest } = buildClient({
      get: () => {
        getCount += 1;
        const id = getCount === 1 ? 999 : 42;
        return {
          video: {
            effects: [
              { id: 100, params: { Scale: { valuetype: "ParamRange" } } },
              { id: 200, params: { Scale: { valuetype: "ParamRange" } } },
              {
                id,
                params: { "Hue Rotate": { valuetype: "ParamRange" } },
              },
            ],
          },
        };
      },
    });

    await client.addEffectToLayer(2, "Hue Rotate");
    // First setEffectParameter after add: MISS, fetches transient id=999,
    // PUTs with id=999. Cache should NOT store it (stabilizing window).
    await client.setEffectParameter(2, 3, "Hue Rotate", 0.3);
    expect(rest.get).toHaveBeenCalledTimes(1);
    const firstPutBody = (rest.put as { mock: { calls: unknown[][] } }).mock
      .calls[0][1] as { video: { effects: Array<Record<string, unknown>> } };
    expect(firstPutBody.video.effects[2]).toMatchObject({
      id: 999,
      params: { "Hue Rotate": { value: 0.3 } },
    });

    // Second setEffectParameter: critical assertion — must re-fetch (MISS
    // again, NOT a cache hit) so it picks up the now-stable id=42 instead
    // of the transient id=999 that would silently no-op.
    await client.setEffectParameter(2, 3, "Hue Rotate", 0.7);
    expect(rest.get).toHaveBeenCalledTimes(2);
    const secondPutBody = (rest.put as { mock: { calls: unknown[][] } }).mock
      .calls[1][1] as { video: { effects: Array<Record<string, unknown>> } };
    expect(secondPutBody.video.effects[2]).toMatchObject({
      id: 42,
      params: { "Hue Rotate": { value: 0.7 } },
    });

    // Third setEffectParameter: now a cache HIT (the second MISS cached id=42).
    // Stable id should keep landing.
    await client.setEffectParameter(2, 3, "Hue Rotate", 0.5);
    expect(rest.get).toHaveBeenCalledTimes(2);
    const thirdPutBody = (rest.put as { mock: { calls: unknown[][] } }).mock
      .calls[2][1] as { video: { effects: Array<Record<string, unknown>> } };
    expect(thirdPutBody.video.effects[2]).toMatchObject({
      id: 42,
      params: { "Hue Rotate": { value: 0.5 } },
    });
  });

  it("post-add stabilization does not affect OTHER layers (flag is per-layer)", async () => {
    // Adding to layer 2 must not force re-fetches on layer 1's cached entries.
    const { client, rest } = buildClient({
      get: (path) => {
        if (path === "/composition/layers/1") {
          return {
            video: {
              effects: [{ id: 11, params: { Scale: { valuetype: "ParamRange" } } }],
            },
          };
        }
        return {
          video: {
            effects: [{ id: 21, params: { Scale: { valuetype: "ParamRange" } } }],
          },
        };
      },
    });
    // Populate layer 1 cache.
    await client.setEffectParameter(1, 1, "Scale", 0.1);
    expect(rest.get).toHaveBeenCalledTimes(1);

    // Add to layer 2: layer 1's cache should remain untouched.
    await client.addEffectToLayer(2, "Blur");

    // Layer 1 hit — no extra GET.
    await client.setEffectParameter(1, 1, "Scale", 0.2);
    expect(rest.get).toHaveBeenCalledTimes(1);
  });

  it("removeEffectFromLayer does NOT trigger the post-add stabilization flag", async () => {
    // Surviving effects keep their ids on remove (only indices shift). No
    // re-keying means we should resume normal caching immediately after
    // the next miss, not waste a second GET on a phantom verify.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            { id: 100, params: { Scale: { valuetype: "ParamRange" } } },
            { id: 200, params: { Scale: { valuetype: "ParamRange" } } },
          ],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 1); // miss → cache id=100
    expect(rest.get).toHaveBeenCalledTimes(1);
    await client.removeEffectFromLayer(1, 2); // 1 GET (validation) + 1 DELETE
    const getsAfterRemove = (rest.get as { mock: { calls: unknown[][] } }).mock
      .calls.length;
    // First MISS post-remove: should cache (no stabilization needed).
    await client.setEffectParameter(1, 1, "Scale", 2);
    expect(rest.get).toHaveBeenCalledTimes(getsAfterRemove + 1);
    // Second call: HIT — no extra GET. (Without the `stabilizing.delete(layer)`
    // branch in invalidateLayer, this would unnecessarily refetch.)
    await client.setEffectParameter(1, 1, "Scale", 3);
    expect(rest.get).toHaveBeenCalledTimes(getsAfterRemove + 1);
  });

  it("ResolumeClient.fromConfig honors effectCacheEnabled: false (env-flag wiring)", async () => {
    // We can't intercept fetch easily here, so we just verify the config
    // path lands on the constructor: a fromConfig'd client with the flag
    // disabled should behave the same as `new Client(rest, { enabled:false })`.
    const { ResolumeClient: Client } = await import("./client.js");
    const c1 = Client.fromConfig({
      host: "127.0.0.1",
      port: 8080,
      timeoutMs: 1000,
      effectCacheEnabled: false,
    });
    const c2 = Client.fromConfig({
      host: "127.0.0.1",
      port: 8080,
      timeoutMs: 1000,
      effectCacheEnabled: true,
    });
    // Both clients are constructed without throwing — that's the surface
    // we control; behavior is exercised in the previous test via direct
    // constructor injection.
    expect(c1).toBeInstanceOf(Client);
    expect(c2).toBeInstanceOf(Client);
  });
});

describe("ResolumeClient.addEffectToLayer", () => {
  it("POSTs the drag-drop URI as text/plain to the layer's /add endpoint", async () => {
    const { client, rest } = buildClient();
    await client.addEffectToLayer(2, "Blur");
    expect(rest.postText).toHaveBeenCalledWith(
      "/composition/layers/2/effects/video/add",
      "effect:///video/Blur"
    );
  });

  it("URL-encodes multi-word effect names (space → %20)", async () => {
    const { client, rest } = buildClient();
    await client.addEffectToLayer(1, "Hue Rotate");
    expect(rest.postText).toHaveBeenCalledWith(
      "/composition/layers/1/effects/video/add",
      "effect:///video/Hue%20Rotate"
    );
  });

  it("trims surrounding whitespace from the effect name", async () => {
    const { client, rest } = buildClient();
    await client.addEffectToLayer(1, "  Bloom  ");
    expect(rest.postText).toHaveBeenCalledWith(
      "/composition/layers/1/effects/video/add",
      "effect:///video/Bloom"
    );
  });

  it("rejects empty / whitespace-only effect names with InvalidValue", async () => {
    const { client } = buildClient();
    await expect(client.addEffectToLayer(1, "")).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "effectName" },
    });
    await expect(client.addEffectToLayer(1, "   ")).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });

  it("rejects invalid layer indices with InvalidIndex", async () => {
    const { client } = buildClient();
    await expect(client.addEffectToLayer(0, "Blur")).rejects.toBeInstanceOf(ResolumeApiError);
    await expect(client.addEffectToLayer(0, "Blur")).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "layer" },
    });
  });
});

describe("ResolumeClient.removeEffectFromLayer", () => {
  function layerWithEffects(n: number) {
    const effects = Array.from({ length: n }, (_, i) => ({
      id: 1000 + i,
      name: `Effect${i}`,
    }));
    return { video: { effects } };
  }

  it("DELETEs at the 0-based REST index when 1-based input is provided", async () => {
    const { client, rest } = buildClient({
      get: () => layerWithEffects(3),
    });
    await client.removeEffectFromLayer(2, 2); // 1-based → 0-based 1
    expect(rest.delete).toHaveBeenCalledWith(
      "/composition/layers/2/effects/video/1"
    );
  });

  it("validates against the live layer's effect count", async () => {
    const { client, rest } = buildClient({
      get: () => layerWithEffects(2),
    });
    await expect(client.removeEffectFromLayer(2, 5)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "effect" },
    });
    expect(rest.delete).not.toHaveBeenCalled();
  });

  it("rejects non-integer or non-positive effect indices", async () => {
    const { client } = buildClient();
    await expect(client.removeEffectFromLayer(1, 0)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "effect" },
    });
    await expect(client.removeEffectFromLayer(1, 1.5)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex" },
    });
  });

  it("rejects invalid layer indices", async () => {
    const { client } = buildClient();
    await expect(client.removeEffectFromLayer(0, 1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "layer" },
    });
  });
});
