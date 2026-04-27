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
