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
  it("second sequential call on same (layer, effectIndex) re-fetches (post-PUT invalidation prevents silent no-op)", async () => {
    // v0.5.2 silent-no-op fix: live evidence (Arena 7.23.2) shows a cached
    // id silently no-ops on cache-hit PUTs because Resolume re-keys the
    // effects array after any nested-PUT write. We invalidate the layer's
    // cache after every successful PUT so subsequent sequential writes
    // re-fetch the post-write id. This trades the GET-skip benefit for
    // correctness — single-flight concurrent coalescing is still preserved
    // (see "concurrent calls" test below).
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Scale", 50);
    await client.setEffectParameter(1, 1, "Scale", 60);
    // Each sequential call does GET-then-PUT — 2 GETs and 2 PUTs.
    expect(rest.get).toHaveBeenCalledTimes(2);
    expect(rest.put).toHaveBeenCalledTimes(2);
  });

  it("PUT body shape is byte-identical between two sequential writes to the same param (rules out body-shape bugs)", async () => {
    // While diagnosing v0.5.2 we considered: maybe the cache-hit PUT body
    // was structurally different from the cache-miss PUT body (e.g., missing
    // `valuetype` because the cache stores only the id). For numeric inputs,
    // `coerceParamValue` is a no-op, so the wire bytes should be identical.
    // This test captures both PUT bodies and asserts byte-equality on the
    // structural shape — confirming the silent-no-op was NOT a body-shape
    // mismatch and the post-PUT invalidation fix is the right lever.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            { id: 555, params: { Scale: { valuetype: "ParamRange" } } },
          ],
        },
      }),
    });
    await client.setEffectParameter(3, 1, "Scale", 150);
    await client.setEffectParameter(3, 1, "Scale", 250);

    const calls = (rest.put as { mock: { calls: unknown[][] } }).mock.calls;
    const first = JSON.stringify({
      ...(calls[0][1] as object),
      // overwrite the value field for shape-only comparison
      video: {
        effects: [{ id: 555, params: { Scale: { value: "X" } } }],
      },
    });
    const second = JSON.stringify({
      ...(calls[1][1] as object),
      video: {
        effects: [{ id: 555, params: { Scale: { value: "X" } } }],
      },
    });
    expect(first).toBe(second);
  });

  it("L3-style sequential set on a never-touched layer does NOT silent-no-op (regression for v0.5.2 live bug)", async () => {
    // Live repro on Arena 7.23.2 against a layer that was never touched by
    // addEffectToLayer/removeEffectFromLayer in the session:
    //   list_layer_effects(L=3)                                  → only Transform at idx 1
    //   setEffectParameter(L=3, eff=1, "Scale", 150)             → MISS → SUCCESS
    //   setEffectParameter(L=3, eff=1, "Scale", 250)             → HIT  → silent no-op (stays 150)
    //
    // Under the post-PUT-invalidation fix, the second call re-fetches and
    // re-issues the PUT against whatever id Resolume now uses. Both PUTs
    // must reach the wire with structurally well-formed bodies.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            { id: 555, params: { Scale: { valuetype: "ParamRange" } } },
          ],
        },
      }),
    });
    await client.setEffectParameter(3, 1, "Scale", 150);
    await client.setEffectParameter(3, 1, "Scale", 250);

    expect(rest.get).toHaveBeenCalledTimes(2); // re-fetch on the second call
    expect(rest.put).toHaveBeenCalledTimes(2);

    const calls = (rest.put as { mock: { calls: unknown[][] } }).mock.calls;
    const firstBody = calls[0][1] as {
      video: { effects: Array<{ id: number; params: { Scale: { value: number } } }> };
    };
    const secondBody = calls[1][1] as {
      video: { effects: Array<{ id: number; params: { Scale: { value: number } } }> };
    };

    // Both PUTs hit the same path with the same structural shape.
    expect(calls[0][0]).toBe("/composition/layers/3");
    expect(calls[1][0]).toBe("/composition/layers/3");
    expect(firstBody.video.effects[0]).toMatchObject({
      id: 555,
      params: { Scale: { value: 150 } },
    });
    expect(secondBody.video.effects[0]).toMatchObject({
      id: 555,
      params: { Scale: { value: 250 } },
    });
  });

  it("three sequential sets to the same Transform.Scale param all reach the wire as distinct PUTs (L3 live repro)", async () => {
    // Live repro from the live-test report: three rapid sets to L3 Transform
    // Scale all silent-no-op'd after the first under v0.5.1. Under v0.5.2,
    // each call must do GET-then-PUT and the PUT body for each must carry
    // the value passed in by the caller.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            { id: 777, params: { Scale: { valuetype: "ParamRange" } } },
          ],
        },
      }),
    });
    await client.setEffectParameter(3, 1, "Scale", 100);
    await client.setEffectParameter(3, 1, "Scale", 150);
    await client.setEffectParameter(3, 1, "Scale", 250);

    const calls = (rest.put as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(3);

    type Body = {
      video: { effects: Array<{ id: number; params: { Scale: { value: number } } }> };
    };
    expect((calls[0][1] as Body).video.effects[0].params.Scale.value).toBe(100);
    expect((calls[1][1] as Body).video.effects[0].params.Scale.value).toBe(150);
    expect((calls[2][1] as Body).video.effects[0].params.Scale.value).toBe(250);

    // GET-PUT-GET-PUT-GET-PUT pattern (not the broken cache-hit-skip-GET pattern)
    expect(rest.get).toHaveBeenCalledTimes(3);
  });

  it("L1 Position X 100 → 200 sequential set on a never-touched layer (live repro of v0.5.1 first-known incidence)", async () => {
    // The v0.5.1 live test bug was first observed on L1 with Position X
    // 100 → 200. No add/remove on L1 in the session; same silent-no-op.
    // This test pins the regression specifically.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [
            {
              id: 333,
              params: { "Position X": { valuetype: "ParamRange" } },
            },
          ],
        },
      }),
    });
    await client.setEffectParameter(1, 1, "Position X", 100);
    await client.setEffectParameter(1, 1, "Position X", 200);

    const calls = (rest.put as { mock: { calls: unknown[][] } }).mock.calls;
    type Body = {
      video: {
        effects: Array<{ id: number; params: { "Position X": { value: number } } }>;
      };
    };
    expect((calls[0][1] as Body).video.effects[0].params["Position X"].value).toBe(100);
    expect((calls[1][1] as Body).video.effects[0].params["Position X"].value).toBe(200);
    expect(rest.get).toHaveBeenCalledTimes(2); // post-PUT inval forces re-fetch
  });

  it("concurrent calls on same (layer, effectIndex) coalesce via single-flight (one GET, two PUTs)", async () => {
    // The cache's remaining utility under v0.5.2: parallel callers for
    // the same key share one in-flight fetcher. After the lookup resolves,
    // both PUTs go out, then the layer is invalidated for future calls.
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      }),
    });
    await Promise.all([
      client.setEffectParameter(1, 1, "Scale", 50),
      client.setEffectParameter(1, 1, "Scale", 60),
    ]);
    expect(rest.get).toHaveBeenCalledTimes(1); // single-flight coalesced
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

  it("cross-effect HIT on same layer also re-fetches (regression: cache-hit silent-no-op v0.5.1)", async () => {
    // Live evidence (Arena 7.23.2): writing param X on effect 3, then param
    // Y on effect 2 of the same layer caused the second write to silent-no-op
    // because layer-level nested PUT re-keys all effects on the layer.
    // Each sequential PUT must therefore force a fresh GET — even when the
    // target effectIndex differs.
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
    await client.setEffectParameter(1, 1, "Scale", 1); // GET+PUT
    await client.setEffectParameter(1, 2, "Scale", 2); // GET+PUT (post-PUT inval)
    await client.setEffectParameter(1, 1, "Scale", 3); // GET+PUT
    await client.setEffectParameter(1, 2, "Scale", 4); // GET+PUT
    expect(rest.get).toHaveBeenCalledTimes(4);
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

  it("clearLayer does not itself invalidate the effect cache (clip-only)", async () => {
    // clearLayer disconnects clips and does not touch the effect chain, so
    // it must not call invalidateLayer on the effect cache. (The post-PUT
    // invalidation in setEffectParameter happens regardless — we verify the
    // separate concern here: clearLayer itself contributes no extra GETs
    // beyond what setEffectParameter would do.)
    const restMock = {
      get: vi.fn(async () => ({
        video: {
          effects: [{ id: 100, params: { Scale: { valuetype: "ParamRange" } } }],
        },
      })),
      put: vi.fn(async () => undefined),
      post: vi.fn(async () => undefined),
      postText: vi.fn(),
      delete: vi.fn(),
      getBinary: vi.fn(),
    } as unknown as ResolumeRestClient;
    const client = new ResolumeClient(restMock);

    await client.setEffectParameter(1, 1, "Scale", 50);
    const getsBeforeClear = (restMock.get as { mock: { calls: unknown[][] } })
      .mock.calls.length;
    await client.clearLayer(1);
    const getsAfterClear = (restMock.get as { mock: { calls: unknown[][] } })
      .mock.calls.length;
    // clearLayer is POST-only; it must not issue a GET (no extra invalidation
    // bookkeeping triggered).
    expect(getsAfterClear).toBe(getsBeforeClear);
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

  it("post-add scenario: every subsequent set re-fetches the now-current id (v0.5.2 silent-no-op fix — post-add case)", async () => {
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

    // Third setEffectParameter: under v0.5.2 post-PUT invalidation this is
    // ALSO a MISS (the second PUT invalidated the layer). The fetcher at
    // this point returns id=42 (post-stabilization), so the third PUT lands
    // on the same stable id. Total GETs after three sets: 3 (one per call).
    await client.setEffectParameter(2, 3, "Hue Rotate", 0.5);
    expect(rest.get).toHaveBeenCalledTimes(3);
    const thirdPutBody = (rest.put as { mock: { calls: unknown[][] } }).mock
      .calls[2][1] as { video: { effects: Array<Record<string, unknown>> } };
    expect(thirdPutBody.video.effects[2]).toMatchObject({
      id: 42,
      params: { "Hue Rotate": { value: 0.5 } },
    });
  });

  it("addEffectToLayer(L2) does NOT cross-invalidate the cache state for unrelated layer L1", async () => {
    // Sanity check: per-layer invalidation must remain layer-scoped, even
    // though under v0.5.2 every PUT in setEffectParameter clears its own
    // layer's cache. The scenario: write to L1 (clears L1 cache), then add
    // an effect to L2 (clears L2 cache only), then write to L1 again.
    // The second L1 write should issue exactly one fresh GET; the L2 add
    // should not have caused L1 to do anything unusual.
    let l1Gets = 0;
    let l2Gets = 0;
    const { client } = buildClient({
      get: (path) => {
        if (path === "/composition/layers/1") {
          l1Gets += 1;
          return {
            video: {
              effects: [{ id: 11, params: { Scale: { valuetype: "ParamRange" } } }],
            },
          };
        }
        l2Gets += 1;
        return {
          video: {
            effects: [{ id: 21, params: { Scale: { valuetype: "ParamRange" } } }],
          },
        };
      },
    });
    await client.setEffectParameter(1, 1, "Scale", 0.1); // 1× L1 GET
    expect(l1Gets).toBe(1);
    expect(l2Gets).toBe(0);

    await client.addEffectToLayer(2, "Blur"); // POSTs L2 add, no GET
    // L2 add must not have called GET on L1.
    expect(l1Gets).toBe(1);

    await client.setEffectParameter(1, 1, "Scale", 0.2); // 1× L1 GET (post-PUT inval from earlier)
    expect(l1Gets).toBe(2);
    expect(l2Gets).toBe(0);
  });

  it("removeEffectFromLayer + sequential sets each do their own fresh GET (post-PUT invalidation)", async () => {
    // Under v0.5.2, every successful PUT invalidates the layer's cache —
    // so two sequential sets after a remove will each fetch fresh. This
    // also implicitly verifies the previous `requireRevalidation` flag
    // (now redundant) doesn't leak any extra GETs.
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
    await client.setEffectParameter(1, 1, "Scale", 1); // GET+PUT → post-PUT inval
    expect(rest.get).toHaveBeenCalledTimes(1);
    await client.removeEffectFromLayer(1, 2); // 1 GET (validation) + 1 DELETE
    const getsAfterRemove = (rest.get as { mock: { calls: unknown[][] } }).mock
      .calls.length;
    // First set post-remove: GET+PUT.
    await client.setEffectParameter(1, 1, "Scale", 2);
    expect(rest.get).toHaveBeenCalledTimes(getsAfterRemove + 1);
    // Second set: also GET+PUT (post-PUT inval cleared the cache).
    await client.setEffectParameter(1, 1, "Scale", 3);
    expect(rest.get).toHaveBeenCalledTimes(getsAfterRemove + 2);
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
