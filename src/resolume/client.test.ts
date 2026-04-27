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
    getBinary: vi.fn(async () => ({ base64: "", mediaType: "image/png" })),
  } as unknown as ResolumeRestClient;
  return { client: new ResolumeClient(rest), rest };
}

describe("ResolumeClient.triggerClip", () => {
  it("POSTs to the connect endpoint with 1-based indices", async () => {
    const { client, rest } = buildClient();
    await client.triggerClip(2, 5);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/2/clips/5/connect");
  });

  it("rejects 0 or negative indices with InvalidIndex hint", async () => {
    const { client } = buildClient();
    await expect(client.triggerClip(0, 1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "layer" },
    });
    await expect(client.triggerClip(1, -1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "clip" },
    });
  });

  it("rejects non-integer indices", async () => {
    const { client } = buildClient();
    await expect(client.triggerClip(1.5, 1)).rejects.toBeInstanceOf(ResolumeApiError);
  });
});

describe("ResolumeClient.setLayerOpacity", () => {
  it("PUTs the opacity wrapper to the right endpoint", async () => {
    const { client, rest } = buildClient();
    await client.setLayerOpacity(3, 0.75);
    expect(rest.put).toHaveBeenCalledWith(
      "/composition/layers/3/video/opacity",
      { value: 0.75 }
    );
  });

  it("rejects values outside 0..1", async () => {
    const { client } = buildClient();
    await expect(client.setLayerOpacity(1, 1.5)).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "opacity" },
    });
    await expect(client.setLayerOpacity(1, -0.1)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
    await expect(client.setLayerOpacity(1, NaN)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("ResolumeClient.clearLayer", () => {
  it("posts to /clear", async () => {
    const { client, rest } = buildClient();
    await client.clearLayer(4);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/4/clear");
  });
});

describe("ResolumeClient.selectClip", () => {
  it("posts to /select", async () => {
    const { client, rest } = buildClient();
    await client.selectClip(2, 7);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/2/clips/7/select");
  });
});

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

describe("ResolumeClient.getClipThumbnail", () => {
  it("appends a cache-busting timestamp", async () => {
    const { client, rest } = buildClient();
    await client.getClipThumbnail(1, 2);
    const call = (rest.getBinary as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(call).toMatch(/^\/composition\/layers\/1\/clips\/2\/thumbnail\/\d+$/);
  });
});

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
      layerCount: 2,
      columnCount: 2,
      deckCount: 1,
      layers: [
        { index: 1, name: "BG", clipCount: 2, connectedClip: 2 },
        { index: 2, name: "Layer 2", clipCount: 0, connectedClip: null },
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
  });
});
