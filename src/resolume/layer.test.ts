import { describe, it, expect, vi } from "vitest";
import { ResolumeClient } from "./client.js";
import { ResolumeRestClient } from "./rest.js";

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

describe("ResolumeClient.clearLayer", () => {
  it("posts to /clear", async () => {
    const { client, rest } = buildClient();
    await client.clearLayer(4);
    expect(rest.post).toHaveBeenCalledWith("/composition/layers/4/clear");
  });

  it("rejects invalid layer index", async () => {
    const { client } = buildClient();
    await expect(client.clearLayer(0)).rejects.toMatchObject({
      detail: { kind: "InvalidIndex", what: "layer" },
    });
  });
});

describe("ResolumeClient.setLayerOpacity", () => {
  it("PUTs the opacity wrapper to the layer endpoint with nested body", async () => {
    const { client, rest } = buildClient();
    await client.setLayerOpacity(3, 0.75);
    expect(rest.put).toHaveBeenCalledWith(
      "/composition/layers/3",
      { video: { opacity: { value: 0.75 } } }
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

describe("ResolumeClient.setLayerTransitionDuration", () => {
  it("PUTs nested transition.duration", async () => {
    const { client, rest } = buildClient();
    await client.setLayerTransitionDuration(2, 1.5);
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/2", {
      transition: { duration: { value: 1.5 } },
    });
  });

  it("rejects out-of-range duration", async () => {
    const { client } = buildClient();
    await expect(client.setLayerTransitionDuration(1, -1)).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "durationSeconds" },
    });
    await expect(client.setLayerTransitionDuration(1, 100)).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("ResolumeClient.setLayerTransitionBlendMode", () => {
  it("PUTs after pre-validating against the available options", async () => {
    const { client, rest } = buildClient({
      get: () => ({
        transition: {
          blend_mode: { options: ["Alpha", "Wipe Ellipse", "Push Up"] },
        },
      }),
    });
    await client.setLayerTransitionBlendMode(1, "Wipe Ellipse");
    expect(rest.put).toHaveBeenCalledWith("/composition/layers/1", {
      transition: { blend_mode: { value: "Wipe Ellipse" } },
    });
  });

  it("rejects unknown blend modes", async () => {
    const { client } = buildClient({
      get: () => ({
        transition: { blend_mode: { options: ["Alpha"] } },
      }),
    });
    await expect(
      client.setLayerTransitionBlendMode(1, "BogusMode")
    ).rejects.toMatchObject({
      detail: { kind: "InvalidValue", field: "blendMode" },
    });
  });

  it("rejects empty mode string", async () => {
    const { client } = buildClient();
    await expect(client.setLayerTransitionBlendMode(1, "")).rejects.toMatchObject({
      detail: { kind: "InvalidValue" },
    });
  });
});

describe("ResolumeClient.getLayerTransitionBlendModes", () => {
  it("returns the options when present", async () => {
    const { client } = buildClient({
      get: () => ({
        transition: { blend_mode: { options: ["Alpha", "Cube"] } },
      }),
    });
    expect(await client.getLayerTransitionBlendModes(1)).toEqual(["Alpha", "Cube"]);
  });

  it("returns empty array when missing", async () => {
    const { client } = buildClient({ get: () => ({}) });
    expect(await client.getLayerTransitionBlendModes(1)).toEqual([]);
  });
});
