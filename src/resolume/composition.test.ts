import { describe, it, expect, vi } from "vitest";
import { ResolumeClient, summarizeComposition } from "./client.js";
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

describe("ResolumeClient.getProductInfo", () => {
  it("returns parsed info on success", async () => {
    const { client } = buildClient({
      get: () => ({ name: "Arena", major: 7, minor: 20, micro: 0, revision: 1 }),
    });
    const info = await client.getProductInfo();
    expect(info).toMatchObject({ name: "Arena", major: 7 });
  });

  it("returns null when /product is unavailable on older versions", async () => {
    const { client } = buildClient({
      get: () => {
        throw new ResolumeApiError({
          kind: "NotFound",
          path: "/product",
          hint: "older version",
        });
      },
    });
    const info = await client.getProductInfo();
    expect(info).toBeNull();
  });

  it("propagates non-NotFound errors", async () => {
    const { client } = buildClient({
      get: () => {
        throw new ResolumeApiError({
          kind: "ResolumeNotRunning",
          hint: "launch resolume",
        });
      },
    });
    await expect(client.getProductInfo()).rejects.toMatchObject({
      detail: { kind: "ResolumeNotRunning" },
    });
  });
});

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

describe("ResolumeClient.getBeatSnap", () => {
  it("returns value and options from composition", async () => {
    const { client } = buildClient({
      get: () => ({
        clipbeatsnap: {
          value: "1 Bar",
          options: ["None", "1 Bar", "1/2 Bar"],
        },
      }),
    });
    expect(await client.getBeatSnap()).toEqual({
      value: "1 Bar",
      options: ["None", "1 Bar", "1/2 Bar"],
    });
  });

  it("returns nulls/empty when composition lacks the field", async () => {
    const { client } = buildClient({ get: () => ({}) });
    expect(await client.getBeatSnap()).toEqual({ value: null, options: [] });
  });
});

describe("ResolumeClient.setBeatSnap", () => {
  it("PUTs the value to /composition", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        clipbeatsnap: { options: ["None", "1 Bar", "1/2 Bar"] },
      }),
    });
    await client.setBeatSnap("1/2 Bar");
    expect(rest.put).toHaveBeenCalledWith("/composition", {
      clipbeatsnap: { value: "1/2 Bar" },
    });
  });

  it("rejects unknown values with the available list in the hint", async () => {
    const { client } = buildClient({
      get: () => ({
        clipbeatsnap: { options: ["None", "1 Bar"] },
      }),
    });
    await expect(client.setBeatSnap("Bogus")).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "beatSnap" },
    });
  });

  it("rejects empty string", async () => {
    const { client } = buildClient();
    await expect(client.setBeatSnap("")).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("ResolumeClient.getCrossfader", () => {
  it("extracts phase from composition.crossfader", async () => {
    const { client } = buildClient({
      get: () => ({ crossfader: { phase: { value: -0.5 } } }),
    });
    expect(await client.getCrossfader()).toEqual({ phase: -0.5 });
  });

  it("returns null phase when missing", async () => {
    const { client } = buildClient({ get: () => ({}) });
    expect(await client.getCrossfader()).toEqual({ phase: null });
  });
});

describe("ResolumeClient.setCrossfader", () => {
  it("PUTs nested crossfader.phase", async () => {
    const { client, rest } = buildClient();
    await client.setCrossfader(0.5);
    expect(rest.put).toHaveBeenCalledWith("/composition", {
      crossfader: { phase: { value: 0.5 } },
    });
  });

  it("rejects values outside -1..1", async () => {
    const { client } = buildClient();
    await expect(client.setCrossfader(-1.5)).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "phase" },
    });
    await expect(client.setCrossfader(2)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
    await expect(client.setCrossfader(NaN)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("summarizeComposition", () => {
  it("produces an LLM-friendly projection", () => {
    const summary = summarizeComposition(
      {
        layers: [
          {
            name: { value: "BG" },
            clips: [
              { name: { value: "alpha" }, connected: { value: "Disconnected" } },
              { name: { value: "beta" }, connected: { value: "Connected" } },
            ],
          },
          { clips: [] },
        ],
        columns: [{ name: { value: "Verse" } }, {}],
        decks: [{ name: { value: "Main" }, selected: { value: true } }],
      },
      { major: 7, minor: 18, micro: 0 }
    );

    expect(summary).toEqual({
      productVersion: "7.18.0",
      bpm: null,
      layerCount: 2,
      columnCount: 2,
      deckCount: 1,
      layers: [
        { index: 1, name: "BG", clipCount: 2, connectedClip: 2, bypassed: false },
        { index: 2, name: "Layer 2", clipCount: 0, connectedClip: null, bypassed: false },
      ],
      columns: [
        { index: 1, name: "Verse" },
        { index: 2, name: "Column 2" },
      ],
      decks: [{ index: 1, name: "Main", selected: true }],
    });
  });

  it("handles missing product info", () => {
    const summary = summarizeComposition({ layers: [], columns: [], decks: [] }, null);
    expect(summary.productVersion).toBeNull();
    expect(summary.bpm).toBeNull();
  });

  it("surfaces tempocontroller BPM when present", () => {
    const summary = summarizeComposition(
      {
        layers: [],
        columns: [],
        decks: [],
        tempocontroller: { tempo: { value: 128 } },
      },
      null
    );
    expect(summary.bpm).toBe(128);
  });

  it("reflects layer bypass state", () => {
    const summary = summarizeComposition(
      {
        layers: [{ name: { value: "muted" }, bypassed: { value: true }, clips: [] }],
        columns: [],
        decks: [],
      },
      null
    );
    expect(summary.layers[0].bypassed).toBe(true);
  });
});
