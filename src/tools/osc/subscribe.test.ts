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
