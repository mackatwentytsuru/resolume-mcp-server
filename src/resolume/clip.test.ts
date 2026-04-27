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

describe("ResolumeClient.selectClip", () => {
  it("posts to /select", async () => {
    const { client, rest } = buildClient();
    await client.selectClip(2, 7);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/2/clips/7/select");
  });
});

describe("ResolumeClient.clearClip", () => {
  it("POSTs to the clip clear endpoint", async () => {
    const { client, rest } = buildClient();
    await client.clearClip(2, 5);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/2/clips/5/clear");
  });

  it("rejects invalid indices", async () => {
    const { client } = buildClient();
    await expect(client.clearClip(0, 1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "layer" },
    });
    await expect(client.clearClip(1, -1)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "clip" },
    });
  });
});

describe("ResolumeClient.wipeComposition", () => {
  it("clears every clip slot on every layer and reports the count", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        layers: [
          { clips: [{}, {}, {}] },
          { clips: [{}, {}] },
          { clips: [{}, {}, {}, {}] },
        ],
      }),
    });
    const result = await client.wipeComposition();
    expect(result).toEqual({ layers: 3, slotsCleared: 9 });
    expect(rest.post).toHaveBeenCalledTimes(9);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/1/clips/1/clear");
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/3/clips/4/clear");
  });

  it("handles a composition with no layers", async () => {
    const { client, rest } = buildClient({ get: () => ({}) });
    const result = await client.wipeComposition();
    expect(result).toEqual({ layers: 0, slotsCleared: 0 });
    expect(rest.post).not.toHaveBeenCalled();
  });
});

describe("ResolumeClient.setClipPlayDirection", () => {
  it("PUTs nested transport body for forward play", async () => {
    const { client, rest } = buildClient();
    await client.setClipPlayDirection(2, 3, ">");
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/2/clips/3", {
      transport: { controls: { playdirection: { value: ">" } } },
    });
  });

  it("rejects invalid direction values", async () => {
    const { client } = buildClient();
    await expect(
      client.setClipPlayDirection(1, 1, "play" as unknown as ">")
    ).rejects.toMatchObject({ detail: { kind: "InvalidValue" } });
  });
});

describe("ResolumeClient.setClipPlayMode", () => {
  it("PUTs nested transport body with the mode string when allowed", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        transport: {
          controls: { playmode: { options: ["Loop", "Bounce", "Random"] } },
        },
      }),
    });
    await client.setClipPlayMode(1, 1, "Bounce");
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1/clips/1", {
      transport: { controls: { playmode: { value: "Bounce" } } },
    });
  });

  it("rejects empty mode string", async () => {
    const { client } = buildClient();
    await expect(client.setClipPlayMode(1, 1, "")).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "mode" },
    });
  });

  it("rejects unknown play mode against the live options", async () => {
    const { client } = buildClient({
      get: () => ({
        transport: {
          controls: { playmode: { options: ["Loop", "Bounce"] } },
        },
      }),
    });
    await expect(client.setClipPlayMode(1, 1, "WeirdMode")).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "mode" },
    });
  });

  it("falls through (no validation) when options aren't exposed", async () => {
    const { client, rest } = buildClient({ get: () => ({}) });
    await client.setClipPlayMode(1, 1, "Anything");
    expect(rest.put).toHaveBeenCalled();
  });
});

describe("ResolumeClient.setClipPosition", () => {
  it("PUTs nested transport.position", async () => {
    const { client, rest } = buildClient();
    await client.setClipPosition(1, 1, 12.5);
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1/clips/1", {
      transport: { position: { value: 12.5 } },
    });
  });

  it("rejects negative or non-finite positions", async () => {
    const { client } = buildClient();
    await expect(client.setClipPosition(1, 1, -1)).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "position" },
    });
    await expect(client.setClipPosition(1, 1, NaN)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("ResolumeClient.getClipThumbnail", () => {
  it("appends a cache-busting timestamp as a query parameter", async () => {
    const { client, rest } = buildClient();
    await client.getClipThumbnail(1, 2);
    const call = (rest.getBinary as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(call).toMatch(/^\/composition\/layers\/1\/clips\/2\/thumbnail\?t=\d+$/);
  });
});
