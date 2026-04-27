import { describe, it, expect, vi } from "vitest";
import { ResolumeClient } from "./client.js";
import { ResolumeRestClient } from "./rest.js";

function buildClient(handlers: Partial<{
  get: (path: string) => unknown;
  put: (path: string, body: unknown) => unknown;
}> = {}) {
  const rest = {
    get: vi.fn(async (path: string) => handlers.get?.(path) ?? {}),
    put: vi.fn(async (path: string, body: unknown) => handlers.put?.(path, body) ?? undefined),
    post: vi.fn(),
    delete: vi.fn(),
    getBinary: vi.fn(),
  } as unknown as ResolumeRestClient;
  return { client: new ResolumeClient(rest), rest };
}

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
