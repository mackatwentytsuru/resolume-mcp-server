import { describe, it, expect, vi, beforeEach } from "vitest";
import { oscSubscribeTool } from "./subscribe.js";
import type { ResolumeClient } from "../../resolume/client.js";
import type { CompositionStore } from "../../resolume/composition-store/store.js";
import type { ReceivedOscMessage } from "../../resolume/osc-client.js";
import type { ToolContext } from "../types.js";

// Mock the OSC client so the tool's legacy code path runs without touching UDP.
vi.mock("../../resolume/osc-client.js", () => ({
  subscribeOsc: vi.fn(async () => [
    { address: "/legacy/path", args: [1], timestamp: 1700000000000 },
  ]),
}));

const baseOsc = { host: "127.0.0.1", inPort: 7000, outPort: 7001 } as const;
const dummyClient = {} as unknown as ResolumeClient;

function fakeStore(collect: (pattern: string, durationMs: number, maxMessages: number) => Promise<ReceivedOscMessage[]>): CompositionStore {
  return { collect } as unknown as CompositionStore;
}

describe("resolume_osc_subscribe multiplexing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses store.collect() when ctx.store is present and does NOT call subscribeOsc", async () => {
    const { subscribeOsc } = await import("../../resolume/osc-client.js");
    const collect = vi.fn(async () => [
      { address: "/composition/layers/1/clips/1/transport/position", args: [0.5], timestamp: 1700000000111 },
      { address: "/composition/layers/1/clips/2/transport/position", args: [0.25], timestamp: 1700000000222 },
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/clips/*/transport/position",
        durationMs: 500,
        maxMessages: 100,
      },
      ctx
    );
    expect(result.isError).toBeFalsy();
    expect(collect).toHaveBeenCalledWith(
      "/composition/layers/*/clips/*/transport/position",
      500,
      100
    );
    expect(subscribeOsc).not.toHaveBeenCalled();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(2);
    expect(json.messages[0].address).toBe(
      "/composition/layers/1/clips/1/transport/position"
    );
  });

  it("falls back to legacy subscribeOsc() when ctx.store is undefined", async () => {
    const { subscribeOsc } = await import("../../resolume/osc-client.js");
    const ctx: ToolContext = { client: dummyClient, osc: baseOsc };
    const result = await oscSubscribeTool.handler(
      { addressPattern: "/legacy/*", durationMs: 200, maxMessages: 50 },
      ctx
    );
    expect(result.isError).toBeFalsy();
    expect(subscribeOsc).toHaveBeenCalledWith(7001, "/legacy/*", 200, 50);
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(1);
    expect(json.messages[0].address).toBe("/legacy/path");
  });

  it("returns isError when ctx.osc is missing regardless of store presence", async () => {
    const collect = vi.fn(async () => []);
    const ctx: ToolContext = { client: dummyClient, store: fakeStore(collect) };
    const result = await oscSubscribeTool.handler(
      { addressPattern: "/foo/*", durationMs: 100, maxMessages: 10 },
      ctx
    );
    expect(result.isError).toBe(true);
    expect(collect).not.toHaveBeenCalled();
  });

  it("description advertises the multiplex behavior", () => {
    expect(oscSubscribeTool.description.toLowerCase()).toContain("multiplex");
    expect(oscSubscribeTool.description).toContain("RESOLUME_CACHE");
  });
});

describe("resolume_osc_subscribe dedupe option (v0.5.4 wire-doubling soft fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the raw stream by default (dedupe omitted)", async () => {
    const collect = vi.fn(async () => [
      { address: "/composition/layers/1/position", args: [0.1366], timestamp: 1_000 },
      { address: "/composition/layers/1/position", args: [0.1366], timestamp: 1_000 },
      { address: "/composition/layers/1/position", args: [0.1367], timestamp: 1_005 },
      { address: "/composition/layers/1/position", args: [0.1367], timestamp: 1_005 },
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/position",
        durationMs: 200,
        maxMessages: 100,
        dedupe: false,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(4);
  });

  it("collapses consecutive same-(address,args) pairs when dedupe=true", async () => {
    const collect = vi.fn(async () => [
      { address: "/composition/layers/1/position", args: [0.1366], timestamp: 1_000 },
      { address: "/composition/layers/1/position", args: [0.1366], timestamp: 1_000 },
      { address: "/composition/layers/1/position", args: [0.1367], timestamp: 1_005 },
      { address: "/composition/layers/1/position", args: [0.1367], timestamp: 1_005 },
      { address: "/composition/layers/2/position", args: [0.5], timestamp: 1_005 },
      { address: "/composition/layers/1/position", args: [0.1366], timestamp: 1_010 },
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/position",
        durationMs: 200,
        maxMessages: 100,
        dedupe: true,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    // 6 raw → 4 deduped: drop the 2 consecutive duplicates per address.
    // The L=2 message is kept (different address). The reverting L=1 0.1366
    // value at ts=1010 is also kept because it's no longer consecutive on
    // that address (the last accepted L=1 was 0.1367).
    expect(json.count).toBe(4);
    expect(json.messages.map((m: { args: number[] }) => m.args[0])).toEqual([
      0.1366, 0.1367, 0.5, 0.1366,
    ]);
  });

  it("dedupe per-address state: L2's first 0.5 is kept even though L1's last value was also 0.5", async () => {
    // Demonstrates that the lastByAddress Map keeps state PER ADDRESS, so
    // a value that was just suppressed on layer 1 does not also suppress
    // layer 2's first occurrence of the same value.
    const collect = vi.fn(async () => [
      { address: "/composition/layers/1/position", args: [0.5], timestamp: 1_000 },
      { address: "/composition/layers/1/position", args: [0.5], timestamp: 1_000 }, // L1 dup → drop
      { address: "/composition/layers/2/position", args: [0.5], timestamp: 1_001 }, // L2 first → keep
      { address: "/composition/layers/2/position", args: [0.5], timestamp: 1_001 }, // L2 dup → drop
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = {
      client: dummyClient,
      osc: baseOsc,
      store: fakeStore(collect),
    };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/composition/layers/*/position",
        durationMs: 200,
        maxMessages: 100,
        dedupe: true,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(2);
    expect(json.messages.map((m: { address: string }) => m.address)).toEqual([
      "/composition/layers/1/position",
      "/composition/layers/2/position",
    ]);
  });

  it("dedupe also works on the legacy (non-store) path", async () => {
    const { subscribeOsc } = await import("../../resolume/osc-client.js");
    (subscribeOsc as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce([
      { address: "/legacy/path", args: [1], timestamp: 1_000 },
      { address: "/legacy/path", args: [1], timestamp: 1_000 },
      { address: "/legacy/path", args: [2], timestamp: 1_001 },
    ] satisfies ReceivedOscMessage[]);
    const ctx: ToolContext = { client: dummyClient, osc: baseOsc };
    const result = await oscSubscribeTool.handler(
      {
        addressPattern: "/legacy/*",
        durationMs: 200,
        maxMessages: 100,
        dedupe: true,
      },
      ctx
    );
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json.count).toBe(2);
  });
});
