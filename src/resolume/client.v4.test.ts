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
