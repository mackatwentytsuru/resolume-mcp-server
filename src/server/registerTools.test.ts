import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { registerTools } from "./registerTools.js";
import { ResolumeApiError } from "../errors/types.js";
import type { ToolContext } from "../tools/types.js";

interface RegisteredCall {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

function makeFakeServer() {
  const calls: RegisteredCall[] = [];
  const server = {
    tool: vi.fn(
      (name: string, description: string, shape: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) => {
        calls.push({ name, description, shape, handler });
      }
    ),
  };
  return { server, calls };
}

function makeCtx(overrides: Partial<{ getCompositionSummary: () => Promise<unknown>; triggerClip: (l: number, c: number) => Promise<void>; setLayerOpacity: (l: number, v: number) => Promise<void> }> = {}): ToolContext {
  return {
    client: {
      getCompositionSummary: vi.fn(async () => ({
        productVersion: null,
        layerCount: 0,
        columnCount: 0,
        deckCount: 0,
        layers: [],
        columns: [],
        decks: [],
      })),
      triggerClip: vi.fn(async () => undefined),
      selectClip: vi.fn(async () => undefined),
      clearLayer: vi.fn(async () => undefined),
      setLayerOpacity: vi.fn(async () => undefined),
      getClipThumbnail: vi.fn(async () => ({ base64: "", mediaType: "image/png" })),
      ...overrides,
    } as unknown as ToolContext["client"],
  };
}

describe("registerTools", () => {
  it("registers every tool with the SDK server", () => {
    const { server, calls } = makeFakeServer();
    registerTools(server as never, makeCtx());
    expect(calls.map((c) => c.name)).toContain("resolume_trigger_clip");
    expect(calls.length).toBeGreaterThanOrEqual(6);
  });

  it("validates arguments via the tool's zod schema", async () => {
    const { server, calls } = makeFakeServer();
    registerTools(server as never, makeCtx());
    const trigger = calls.find((c) => c.name === "resolume_trigger_clip");
    if (!trigger) throw new Error("not registered");
    const result = (await trigger.handler({ layer: 0, clip: 1 })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text) as { error: string; issues?: unknown[] };
    expect(env.error).toBe("InvalidArguments");
    expect(env.issues?.length).toBeGreaterThan(0);
  });

  it("formats ResolumeApiError into structured tool error", async () => {
    const { server, calls } = makeFakeServer();
    const ctx = makeCtx({
      triggerClip: vi.fn(async () => {
        throw new ResolumeApiError({
          kind: "ResolumeNotRunning",
          hint: "launch arena",
        });
      }),
    });
    registerTools(server as never, ctx);
    const trigger = calls.find((c) => c.name === "resolume_trigger_clip");
    if (!trigger) throw new Error("not registered");
    const result = (await trigger.handler({ layer: 1, clip: 1 })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as { error: string };
    expect(parsed.error).toBe("ResolumeNotRunning");
  });

  it("formats unexpected errors with a helpful message", async () => {
    const { server, calls } = makeFakeServer();
    const ctx = makeCtx({
      getCompositionSummary: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    registerTools(server as never, ctx);
    const get = calls.find((c) => c.name === "resolume_get_composition");
    if (!get) throw new Error("not registered");
    const result = (await get.handler({})) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text) as { error: string; message: string };
    expect(env.error).toBe("Unexpected");
    expect(env.message).toContain("boom");
  });

  it("handles non-Error thrown values", async () => {
    const { server, calls } = makeFakeServer();
    const ctx = makeCtx({
      getCompositionSummary: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw string error";
      }),
    });
    registerTools(server as never, ctx);
    const get = calls.find((c) => c.name === "resolume_get_composition");
    if (!get) throw new Error("not registered");
    const result = (await get.handler({})) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text) as { error: string; message: string };
    expect(env.error).toBe("Unexpected");
    expect(env.message).toBe("raw string error");
  });

  it("rejects unknown extra keys via strict mode", async () => {
    const { server, calls } = makeFakeServer();
    registerTools(server as never, makeCtx());
    const trigger = calls.find((c) => c.name === "resolume_trigger_clip");
    if (!trigger) throw new Error("not registered");
    const result = (await trigger.handler({ layer: 1, clip: 1, extra: "nope" })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0].text) as { error: string };
    expect(env.error).toBe("InvalidArguments");
  });

  it("passes valid args to handler and returns success result", async () => {
    const { server, calls } = makeFakeServer();
    const triggerClip = vi.fn(async () => undefined);
    const ctx = makeCtx({ triggerClip });
    registerTools(server as never, ctx);
    const trigger = calls.find((c) => c.name === "resolume_trigger_clip");
    if (!trigger) throw new Error("not registered");
    const result = (await trigger.handler({ layer: 1, clip: 2 })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBeFalsy();
    expect(triggerClip).toHaveBeenCalledWith(1, 2);
  });
});

describe("schema shape extraction", () => {
  it("extracts the inner shape from a ZodObject-based tool schema", () => {
    const schema = z.object({ foo: z.number(), bar: z.string() }).strict();
    expect(Object.keys(schema.shape)).toEqual(["foo", "bar"]);
  });
});
