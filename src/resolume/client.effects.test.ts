import { describe, it, expect, vi } from "vitest";
import { ResolumeClient } from "./client.js";
import { ResolumeRestClient } from "./rest.js";
import { ResolumeApiError } from "../errors/types.js";

function buildClient(handlers: Partial<{
  get: (path: string) => unknown;
  postText: (path: string, text: string) => unknown;
  delete: (path: string) => unknown;
}> = {}) {
  const rest = {
    get: vi.fn(async (path: string) => handlers.get?.(path) ?? {}),
    put: vi.fn(),
    post: vi.fn(),
    postText: vi.fn(async (path: string, text: string) => handlers.postText?.(path, text) ?? undefined),
    delete: vi.fn(async (path: string) => handlers.delete?.(path) ?? undefined),
    getBinary: vi.fn(),
  } as unknown as ResolumeRestClient & { postText: ReturnType<typeof vi.fn> };
  return { client: new ResolumeClient(rest), rest };
}

describe("ResolumeClient.addEffectToLayer", () => {
  it("POSTs the drag-drop URI as text/plain to the layer's /add endpoint", async () => {
    const { client, rest } = buildClient();
    await client.addEffectToLayer(2, "Blur");
    expect(rest.postText).toHaveBeenCalledWith(
      "/composition/layers/2/effects/video/add",
      "effect:///video/Blur"
    );
  });

  it("preserves spaces in multi-word effect names", async () => {
    const { client, rest } = buildClient();
    await client.addEffectToLayer(1, "Hue Rotate");
    expect(rest.postText).toHaveBeenCalledWith(
      "/composition/layers/1/effects/video/add",
      "effect:///video/Hue Rotate"
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
