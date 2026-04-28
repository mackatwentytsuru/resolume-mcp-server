import { describe, it, expect } from "vitest";
import { cacheStatusTool } from "./cache-status.js";
import { buildCtx } from "../test-helpers.js";
import type { CompositionStore } from "../../resolume/composition-store/store.js";
import type { ToolContext } from "../types.js";

interface FakeStats {
  revision: number;
  hydrated: boolean;
  oscLive: boolean;
  lastOscAt: number | null;
  lastSeedAt: number | null;
  msgsReceived: number;
  rehydrationsTriggered: number;
  mode: "owner" | "shared" | "off";
}

function fakeStore(stats: FakeStats): CompositionStore {
  return { stats: () => stats } as unknown as CompositionStore;
}

describe("resolume_cache_status", () => {
  it("declares stable stability and an empty input schema", () => {
    expect(cacheStatusTool.stability).toBe("stable");
    expect(Object.keys(cacheStatusTool.inputSchema)).toHaveLength(0);
    expect(cacheStatusTool.name).toBe("resolume_cache_status");
  });

  it("returns enabled=false and mode=off when store is absent", async () => {
    const { ctx } = buildCtx();
    const result = await cacheStatusTool.handler({}, ctx);
    expect(result.isError).toBeFalsy();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json).toEqual({ enabled: false, mode: "off" });
  });

  it("surfaces all store.stats() fields when store is present and populated", async () => {
    const stats: FakeStats = {
      revision: 42,
      hydrated: true,
      oscLive: true,
      lastOscAt: 1700000000000,
      lastSeedAt: 1700000000500,
      msgsReceived: 12345,
      rehydrationsTriggered: 3,
      mode: "owner",
    };
    const { ctx: baseCtx } = buildCtx();
    const ctx: ToolContext = { ...baseCtx, store: fakeStore(stats) };
    const result = await cacheStatusTool.handler({}, ctx);
    expect(result.isError).toBeFalsy();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json).toEqual({ enabled: true, ...stats });
  });

  it("returns enabled=true with mode=shared when running in shared mode", async () => {
    const stats: FakeStats = {
      revision: 0,
      hydrated: false,
      oscLive: false,
      lastOscAt: null,
      lastSeedAt: null,
      msgsReceived: 0,
      rehydrationsTriggered: 0,
      mode: "shared",
    };
    const { ctx: baseCtx } = buildCtx();
    const ctx: ToolContext = { ...baseCtx, store: fakeStore(stats) };
    const result = await cacheStatusTool.handler({}, ctx);
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.enabled).toBe(true);
    expect(json.mode).toBe("shared");
    expect(json.hydrated).toBe(false);
  });
});
