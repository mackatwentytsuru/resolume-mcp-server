import { describe, it, expect, vi } from "vitest";
import { ResolumeClient } from "./client.js";
import { ResolumeRestClient } from "./rest.js";
import { ResolumeApiError } from "../errors/types.js";

function buildClient(handlers: Partial<{
  get: (path: string) => unknown;
  put: (path: string, body: unknown) => unknown;
  post: (path: string, body?: unknown) => unknown;
}> = {}) {
  const rest = {
    get: vi.fn(async (path: string) => handlers.get?.(path) ?? {}),
    put: vi.fn(async (path: string, body: unknown) => handlers.put?.(path, body) ?? undefined),
    post: vi.fn(async (path: string, body?: unknown) => handlers.post?.(path, body) ?? undefined),
    delete: vi.fn(),
    getBinary: vi.fn(),
  } as unknown as ResolumeRestClient;
  return { client: new ResolumeClient(rest), rest };
}

describe("ResolumeClient.triggerColumn", () => {
  it("POSTs to the column connect endpoint", async () => {
    const { client, rest } = buildClient();
    await client.triggerColumn(3);
    expect(rest.post).toHaveBeenCalledWith("/composition/columns/3/connect");
  });

  it("rejects invalid index", async () => {
    const { client } = buildClient();
    await expect(client.triggerColumn(0)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "column" },
    });
  });
});

describe("ResolumeClient.selectDeck", () => {
  it("POSTs to the deck select endpoint", async () => {
    const { client, rest } = buildClient();
    await client.selectDeck(2);
    expect(rest.post).toHaveBeenCalledWith("/composition/decks/2/select");
  });

  it("rejects invalid index", async () => {
    const { client } = buildClient();
    await expect(client.selectDeck(-1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "deck" },
    });
  });
});

describe("ResolumeClient.setLayerBypass", () => {
  it("PUTs nested bypassed body", async () => {
    const { client, rest } = buildClient();
    await client.setLayerBypass(2, true);
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/2", {
      bypassed: { value: true },
    });
  });
});

describe("ResolumeClient.setLayerBlendMode", () => {
  it("PUTs nested mixer body with the exact 'Blend Mode' key (capital B, M)", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        video: {
          mixer: {
            "Blend Mode": { options: ["Add", "Multiply", "Screen"] },
          },
        },
      }),
    });
    await client.setLayerBlendMode(1, "Multiply");
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1", {
      video: { mixer: { "Blend Mode": { value: "Multiply" } } },
    });
  });

  it("rejects empty blend mode string", async () => {
    const { client } = buildClient();
    await expect(client.setLayerBlendMode(1, "")).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });

  it("rejects unknown blend mode and includes available list in the hint", async () => {
    const { client } = buildClient({
      get: () => ({
        video: {
          mixer: {
            "Blend Mode": { options: ["Add", "Multiply", "Screen"] },
          },
        },
      }),
    });
    await expect(client.setLayerBlendMode(1, "Bogus")).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "blendMode" },
    });
  });

  it("falls through (no validation) when the layer doesn't expose options", async () => {
    const { client, rest } = buildClient({
      get: () => ({}),
    });
    await client.setLayerBlendMode(1, "Anything");
    expect(rest.put).toHaveBeenCalled();
  });
});

describe("ResolumeClient.getLayerBlendModes", () => {
  it("returns the options array from the layer's mixer", async () => {
    const { client } = buildClient({
      get: () => ({
        video: {
          mixer: {
            "Blend Mode": {
              options: ["Add", "Multiply", "Screen"],
            },
          },
        },
      }),
    });
    const modes = await client.getLayerBlendModes(1);
    expect(modes).toEqual(["Add", "Multiply", "Screen"]);
  });

  it("returns empty array when options are missing", async () => {
    const { client } = buildClient({ get: () => ({}) });
    expect(await client.getLayerBlendModes(1)).toEqual([]);
  });
});

describe("ResolumeClient.setTempo", () => {
  it("PUTs to /composition with nested tempocontroller body", async () => {
    const { client, rest } = buildClient();
    await client.setTempo(140);
    expect(rest.put).toHaveBeenCalledWith("/composition", {
      tempocontroller: { tempo: { value: 140 } },
    });
  });

  it("rejects values out of Resolume's range", async () => {
    const { client } = buildClient();
    await expect(client.setTempo(0)).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "bpm" },
    });
    await expect(client.setTempo(1000)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
    await expect(client.setTempo(NaN)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("ResolumeClient.tapTempo", () => {
  it("PUTs tempo_tap with value=true (event parameter trigger)", async () => {
    const { client, rest } = buildClient();
    await client.tapTempo();
    expect(rest.put).toHaveBeenCalledWith("/composition", {
      tempocontroller: { tempo_tap: { value: true } },
    });
  });
});

describe("ResolumeClient.resyncTempo", () => {
  it("PUTs resync trigger", async () => {
    const { client, rest } = buildClient();
    await client.resyncTempo();
    expect(rest.put).toHaveBeenCalledWith("/composition", {
      tempocontroller: { resync: { value: true } },
    });
  });
});

describe("ResolumeClient.getTempo", () => {
  it("extracts BPM and range from composition", async () => {
    const { client } = buildClient({
      get: () => ({
        tempocontroller: { tempo: { value: 132, min: 20, max: 500 } },
      }),
    });
    expect(await client.getTempo()).toEqual({ bpm: 132, min: 20, max: 500 });
  });

  it("returns nulls when tempocontroller missing", async () => {
    const { client } = buildClient({ get: () => ({}) });
    expect(await client.getTempo()).toEqual({ bpm: null, min: null, max: null });
  });
});

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
    await client.setEffectParameter(1, 1, "Active", 0 as unknown as boolean);
    expect(rest.put).toHaveBeenLastCalledWith("/composition/layers/1", {
      video: { effects: [{ id: 1, params: { Active: { value: false } } }] },
    });
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
