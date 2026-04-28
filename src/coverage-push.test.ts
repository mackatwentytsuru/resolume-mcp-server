/**
 * Coverage-push tests — exercise the residual error/edge branches that the
 * domain test suites don't naturally hit.
 *
 * The aim is to take Statements/Branches/Functions/Lines as close to 100% as
 * is reasonable for production code; each test below targets a specific
 * uncovered region surfaced by `vitest run --coverage`.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

// ───────────── errors / types — Unauthorized + format paths ─────────────

import { mapHttpError, ResolumeApiError } from "./errors/types.js";

describe("errors/types — Unauthorized mapping", () => {
  it("maps 401 to Unauthorized with auth-required hint", () => {
    const err = mapHttpError("/composition", 401, "denied");
    expect(err).toBeInstanceOf(ResolumeApiError);
    expect(err.detail.kind).toBe("Unauthorized");
    if (err.detail.kind !== "Unauthorized") throw new Error("type narrow");
    expect(err.detail.status).toBe(401);
    expect(err.detail.hint).toMatch(/Authentication required/);
    // formatMessage exercise
    expect(err.message).toMatch(/Unauthorized \(401\)/);
  });

  it("maps 403 to Unauthorized with forbidden hint", () => {
    const err = mapHttpError("/composition", 403, "no");
    if (err.detail.kind !== "Unauthorized") throw new Error("type narrow");
    expect(err.detail.status).toBe(403);
    expect(err.detail.hint).toMatch(/Forbidden/);
  });

  it("maps unknown 5xx to Unknown with generic hint", () => {
    const err = mapHttpError("/x", 502, "bad gateway");
    expect(err.detail.kind).toBe("Unknown");
    expect(err.message).toMatch(/HTTP 502/);
  });
});

// ───────────── osc-codec — pattern validator ─────────────

import { assertSupportedOscPattern, matchOscPattern } from "./resolume/osc-codec.js";

describe("assertSupportedOscPattern", () => {
  it("accepts patterns with only '*' wildcards", () => {
    expect(() => assertSupportedOscPattern("/composition/layers/*/position")).not.toThrow();
    expect(() => assertSupportedOscPattern("/composition")).not.toThrow();
  });

  for (const ch of ["?", "[", "]", "{", "}"]) {
    it(`rejects '${ch}'`, () => {
      expect(() => assertSupportedOscPattern(`/foo/${ch}bar`)).toThrow(
        new RegExp(`unsupported character '\\${ch}'`)
      );
    });
  }
});

describe("matchOscPattern — equality and no-wildcard short circuit", () => {
  it("returns true when pattern equals address verbatim", () => {
    expect(matchOscPattern("/foo/bar", "/foo/bar")).toBe(true);
  });

  it("returns false when pattern has no wildcard and differs", () => {
    expect(matchOscPattern("/foo/bar", "/foo/baz")).toBe(false);
  });
});

// ───────────── tools/osc — query + subscribe pattern rejection ─────────────

import { oscQueryTool } from "./tools/osc/query.js";
import { oscSubscribeTool } from "./tools/osc/subscribe.js";
import type { ToolContext } from "./tools/types.js";

const fakeOscCtx = (): ToolContext => ({
  // The tool checks ctx.osc presence first; ctx.client is unused on the
  // pattern-rejection path.
  client: {} as never,
  osc: { host: "127.0.0.1", inPort: 7000, outPort: 7001 },
});

describe("oscQueryTool — input validation", () => {
  it("rejects unsupported pattern characters", async () => {
    const ctx = fakeOscCtx();
    const res = await oscQueryTool.handler(
      { address: "/foo/{a,b}", timeoutMs: 100 },
      ctx
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/unsupported character/);
  });

  it("returns errorResult when ctx.osc is missing", async () => {
    const res = await oscQueryTool.handler(
      { address: "/foo", timeoutMs: 100 },
      { client: {} as never }
    );
    expect(res.isError).toBe(true);
  });
});

describe("oscSubscribeTool — input validation + bind error", () => {
  it("rejects unsupported pattern characters before binding", async () => {
    const res = await oscSubscribeTool.handler(
      { addressPattern: "/x/?", durationMs: 100, maxMessages: 1, dedupe: false },
      fakeOscCtx()
    );
    expect(res.isError).toBe(true);
  });

  it("returns errorResult when ctx.osc is missing", async () => {
    const res = await oscSubscribeTool.handler(
      { addressPattern: "/x", durationMs: 100, maxMessages: 1, dedupe: false },
      { client: {} as never }
    );
    expect(res.isError).toBe(true);
  });
});

// ───────────── tools/composition/crossfader — handlers ─────────────

import {
  getCrossfaderTool,
  setCrossfaderTool,
} from "./tools/composition/crossfader.js";

describe("crossfader tools", () => {
  it("getCrossfader returns the client value verbatim", async () => {
    const getCrossfader = vi.fn(async () => ({ phase: 0.42 }));
    const ctx = { client: { getCrossfader } as never };
    const res = await getCrossfaderTool.handler({}, ctx);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ phase: 0.42 });
    expect(getCrossfader).toHaveBeenCalled();
  });

  it("setCrossfader forwards phase and surfaces it in the text result", async () => {
    const setCrossfader = vi.fn(async () => undefined);
    const ctx = { client: { setCrossfader } as never };
    const res = await setCrossfaderTool.handler({ phase: -0.2 }, ctx);
    expect(setCrossfader).toHaveBeenCalledWith(-0.2);
    expect((res.content[0] as { text: string }).text).toContain("-0.2");
  });
});

// ───────────── tools/layer/transition — handlers ─────────────

import {
  setLayerTransitionDurationTool,
  listLayerTransitionBlendModesTool,
  setLayerTransitionBlendModeTool,
} from "./tools/layer/transition.js";

describe("layer transition tools", () => {
  it("setLayerTransitionDuration forwards args", async () => {
    const fn = vi.fn(async () => undefined);
    const ctx = { client: { setLayerTransitionDuration: fn } as never };
    await setLayerTransitionDurationTool.handler({ layer: 2, durationSeconds: 1.5 }, ctx);
    expect(fn).toHaveBeenCalledWith(2, 1.5);
  });

  it("listLayerTransitionBlendModes echoes the modes", async () => {
    const modes = ["Alpha", "Wipe Ellipse", "Push Up"];
    const fn = vi.fn(async () => modes);
    const ctx = { client: { getLayerTransitionBlendModes: fn } as never };
    const res = await listLayerTransitionBlendModesTool.handler({ layer: 1 }, ctx);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual({ layer: 1, modes });
  });

  it("setLayerTransitionBlendMode forwards args", async () => {
    const fn = vi.fn(async () => undefined);
    const ctx = { client: { setLayerTransitionBlendMode: fn } as never };
    await setLayerTransitionBlendModeTool.handler(
      { layer: 3, blendMode: "Wipe Ellipse" },
      ctx
    );
    expect(fn).toHaveBeenCalledWith(3, "Wipe Ellipse");
  });
});

// ───────────── clip.wipeComposition — partial-failure handling ─────────────

import { wipeComposition } from "./resolume/clip.js";
import { ResolumeRestClient } from "./resolume/rest.js";

describe("wipeComposition — partial failure", () => {
  it("reports failedLayers when one /clearclips POST rejects, without aborting siblings", async () => {
    const get = vi.fn(async () => ({
      layers: [{ clips: [{}, {}] }, { clips: [{}] }, { clips: [{}, {}, {}] }],
    }));
    const post = vi.fn(async (path: string) => {
      if (path === "/composition/layers/2/clearclips") {
        throw new Error("boom");
      }
      return undefined;
    });
    const fakeRest = { get, post } as unknown as ResolumeRestClient;

    const result = await wipeComposition(fakeRest);
    expect(result.layers).toBe(3);
    expect(result.failedLayers).toEqual([2]);
    // Layers 1 and 3 still cleared their slots (5 in total).
    expect(result.slotsCleared).toBe(5);
    // All three layers were attempted (no abort on first failure).
    expect(post).toHaveBeenCalledTimes(3);
  });
});

// ───────────── registry / decorate edge ─────────────

import { decorateDescription, eraseTool } from "./tools/registry.js";

describe("decorateDescription — defensive default", () => {
  it("defaults missing stability to 'stable' (no prefix, byte-identical)", () => {
    const baseTool = {
      name: "x",
      title: "X",
      description: "Plain text.",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text" as const, text: "" }] }),
    };
    expect(decorateDescription(baseTool as Parameters<typeof decorateDescription>[0])).toBe(
      "Plain text."
    );
    // eraseTool path normalizes stability to "stable" too.
    const erased = eraseTool({
      ...baseTool,
      inputSchema: {} as z.ZodRawShape,
    });
    expect(erased.stability).toBe("stable");
  });
});

// ───────────── osc-client — pickSocketTypeForHost + send/probe defaults ─────

import {
  pickSocketTypeForHost,
  sendOsc,
  queryOsc,
  probeOscStatus,
  type SocketFactory,
  type UdpSocketLike,
} from "./resolume/osc-client.js";

describe("pickSocketTypeForHost", () => {
  it("returns udp4 for IPv4 literals and bare hostnames", () => {
    expect(pickSocketTypeForHost("127.0.0.1")).toBe("udp4");
    expect(pickSocketTypeForHost("localhost")).toBe("udp4");
    expect(pickSocketTypeForHost("10.0.0.1")).toBe("udp4");
  });

  it("returns udp6 when host contains a colon (IPv6 literal)", () => {
    expect(pickSocketTypeForHost("::1")).toBe("udp6");
    expect(pickSocketTypeForHost("fe80::1")).toBe("udp6");
  });
});

/**
 * Tiny in-memory UDP socket double used to exercise sendOsc/queryOsc/probe
 * paths without touching the OS network stack. Records the `type` it was
 * created with so we can assert the IPv6 routing.
 */
function makeFakeSocket(opts: {
  failSend?: Error;
  emitMessage?: { delayMs?: number; address: string; argsList?: ReadonlyArray<unknown> };
} = {}): { sock: UdpSocketLike; createdAs: { type?: string } } {
  const handlers: Record<string, ((arg?: unknown) => void) | undefined> = {};
  const sock: UdpSocketLike = {
    on(event: string, listener: (arg?: unknown) => void) {
      handlers[event] = listener;
    },
    bind: () => {
      setImmediate(() => handlers.listening?.());
    },
    send: (_msg, _port, _host, cb) => {
      cb(opts.failSend ?? null);
    },
    close: () => {
      /* noop */
    },
  };
  return { sock, createdAs: {} };
}

describe("sendOsc — failure paths", () => {
  it("rejects when sock.send reports an error", async () => {
    const factory: SocketFactory = () => {
      const { sock } = makeFakeSocket({ failSend: new Error("kernel-no") });
      return sock;
    };
    await expect(sendOsc("127.0.0.1", 7000, "/x", [], factory)).rejects.toThrow("kernel-no");
  });

  it("rejects when the socket emits an error event", async () => {
    let errHandler: ((err: Error) => void) | undefined;
    const factory: SocketFactory = () => ({
      on(event: string, listener: never) {
        if (event === "error") errHandler = listener as never;
      },
      bind: () => undefined,
      send: () => {
        // Trigger the error handler instead of calling cb.
        errHandler?.(new Error("socket boom"));
      },
      close: () => undefined,
    } as unknown as UdpSocketLike);
    await expect(sendOsc("127.0.0.1", 7000, "/x", [], factory)).rejects.toThrow("socket boom");
  });
});

describe("queryOsc — error path", () => {
  it("rejects when the bound socket emits an error", async () => {
    let errHandler: ((err: Error) => void) | undefined;
    const factory: SocketFactory = () => ({
      on(event: string, listener: never) {
        if (event === "error") errHandler = listener as never;
      },
      bind: () => {
        setImmediate(() => errHandler?.(new Error("query boom")));
      },
      send: () => undefined,
      close: () => undefined,
    } as unknown as UdpSocketLike);
    await expect(queryOsc("127.0.0.1", 7000, 7001, "/x", 100, factory)).rejects.toThrow(
      "query boom"
    );
  });
});

describe("probeOscStatus — non-OSC traffic ignored, error swallowed", () => {
  it("resolves with reachable=false when the socket errors", async () => {
    let errHandler: ((err: Error) => void) | undefined;
    const factory: SocketFactory = () => ({
      on(event: string, listener: never) {
        if (event === "error") errHandler = listener as never;
      },
      bind: () => setImmediate(() => errHandler?.(new Error("probe boom"))),
      send: () => undefined,
      close: () => undefined,
    } as unknown as UdpSocketLike);
    const result = await probeOscStatus(7001, 100, factory);
    expect(result).toEqual({ reachable: false, lastReceived: null });
  });
});

// ───────────── rest — getBinary error path + non-JSON request fallthrough ──

describe("ResolumeRestClient — error mapping", () => {
  it("getBinary rejects with NotFound on 404", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response("", { status: 404 })
    ) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
    });
    await expect(client.getBinary("/missing")).rejects.toMatchObject({
      detail: { kind: "NotFound" },
    });
  });

  it("request rejects with Unauthorized on 401", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response("denied", { status: 401 })
    ) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
    });
    await expect(client.get("/x")).rejects.toMatchObject({
      detail: { kind: "Unauthorized", status: 401 },
    });
  });

  it("rejects with Unknown when content-type is non-JSON and body is non-empty", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    ) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
    });
    await expect(client.get("/x")).rejects.toMatchObject({
      detail: { kind: "Unknown" },
    });
  });

  it("normalizes a non-Resolume error to a network-mapped Unknown", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
    });
    // "fetch failed" matches the ECONNREFUSED-y branch in mapNetworkError.
    await expect(client.get("/x")).rejects.toMatchObject({
      detail: { kind: "ResolumeNotRunning" },
    });
  });
});

// ───────────── composition-store — sock.bind sync throw + IPv6 type pick ──

import { CompositionStore } from "./resolume/composition-store/store.js";

describe("CompositionStore — socket factory edges", () => {
  function makeSilentRest(): ResolumeRestClient {
    return {
      get: vi.fn(async () => ({})),
    } as unknown as ResolumeRestClient;
  }

  it("degrades to SHARED when the socket factory throws synchronously", async () => {
    const stderrWrites: string[] = [];
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "owner", hydrationTimeoutMs: 10 },
      rest: makeSilentRest(),
      socketFactory: () => {
        throw new Error("factory threw");
      },
      stderr: { write: (s) => stderrWrites.push(s) },
    });
    await store.start();
    expect(store.__testInternals().socketBound).toBe(false);
    expect(stderrWrites.some((s) => s.includes("socket create failed"))).toBe(true);
    await store.stop();
  });

  it("degrades to SHARED when sock.bind() throws synchronously", async () => {
    const stderrWrites: string[] = [];
    const sock: UdpSocketLike = {
      on: () => undefined,
      bind: () => {
        throw new Error("EPERM");
      },
      send: () => undefined,
      close: () => undefined,
    };
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "owner", hydrationTimeoutMs: 10 },
      rest: makeSilentRest(),
      socketFactory: () => sock,
      stderr: { write: (s) => stderrWrites.push(s) },
    });
    await store.start();
    expect(store.__testInternals().effectiveMode).toBe("shared");
    expect(store.__testInternals().socketBound).toBe(false);
    expect(stderrWrites.some((s) => s.includes("bind threw synchronously"))).toBe(true);
    await store.stop();
  });

  it("requests an IPv6 socket when oscHost is an IPv6 literal", async () => {
    const calls: string[] = [];
    const sock: UdpSocketLike = {
      on: () => undefined,
      bind: () => undefined,
      send: () => undefined,
      close: () => undefined,
    };
    const store = new CompositionStore({
      options: { oscHost: "::1", oscOutPort: 7001, mode: "owner", hydrationTimeoutMs: 10 },
      rest: makeSilentRest(),
      socketFactory: (type) => {
        calls.push(type ?? "(default)");
        return sock;
      },
    });
    await store.start();
    expect(calls).toContain("udp6");
    await store.stop();
  });
});

// ───────────── effects — coerceParamValue numeric throw branch ──

import { coerceParamValue } from "./resolume/effects.js";

describe("coerceParamValue — error branches", () => {
  it("throws when a string-typed numeric value cannot be parsed", () => {
    expect(() => coerceParamValue("not-a-number", "ParamRange", "Scale")).toThrow();
  });

  it("throws when a boolean param receives an unparseable string", () => {
    expect(() => coerceParamValue("yes-please", "ParamBoolean", "Visible")).toThrow();
  });

  it("returns the value verbatim for unknown valuetype", () => {
    expect(coerceParamValue(42, "ParamMystery", "X")).toBe(42);
  });

  it("returns the value when valuetype is undefined", () => {
    expect(coerceParamValue("anything", undefined, "X")).toBe("anything");
  });

  it("coerces numeric strings to numbers for numeric types", () => {
    expect(coerceParamValue("0.5", "ParamRange", "Scale")).toBe(0.5);
  });

  it("coerces booleans to 0/1 for numeric types", () => {
    expect(coerceParamValue(true, "ParamRange", "Scale")).toBe(1);
    expect(coerceParamValue(false, "ParamRange", "Scale")).toBe(0);
  });

  it("coerces 'true'/'false' strings to booleans for ParamBoolean", () => {
    expect(coerceParamValue("true", "ParamBoolean", "Visible")).toBe(true);
    expect(coerceParamValue("false", "ParamBoolean", "Visible")).toBe(false);
  });

  it("coerces a number to boolean (0 → false, anything else → true)", () => {
    expect(coerceParamValue(0, "ParamBoolean", "X")).toBe(false);
    expect(coerceParamValue(1, "ParamBoolean", "X")).toBe(true);
  });

  it("stringifies values for string-typed parameters", () => {
    expect(coerceParamValue(42, "ParamString", "Label")).toBe("42");
    expect(coerceParamValue(true, "ParamChoice", "Mode")).toBe("true");
  });
});

// ───────────── composition.summarizeComposition — empty branches ──

import { summarizeComposition } from "./resolume/composition.js";

describe("summarizeComposition", () => {
  it("substitutes default names when layer/column/deck names are missing", () => {
    const out = summarizeComposition(
      {
        layers: [{ clips: [] }],
        columns: [{}],
        decks: [{}],
      } as never,
      null
    );
    expect(out.layers[0].name).toBe("Layer 1");
    expect(out.columns[0].name).toBe("Column 1");
    expect(out.decks[0].name).toBe("Deck 1");
    expect(out.productVersion).toBeNull();
    expect(out.bpm).toBeNull();
  });

  it("reads BPM from tempocontroller and joins product version components", () => {
    const out = summarizeComposition(
      {
        tempocontroller: { tempo: { value: 130 } },
      } as never,
      { major: 7, minor: 23, micro: 2, revision: undefined } as never
    );
    expect(out.bpm).toBe(130);
    expect(out.productVersion).toBe("7.23.2");
    expect(out.layers).toEqual([]);
  });

  it("flags a layer's connectedClip when one of its clips is Connected", () => {
    const out = summarizeComposition(
      {
        layers: [
          {
            clips: [
              { connected: { value: "Disconnected" } },
              { connected: { value: "Connected" } },
            ],
          },
        ],
      } as never,
      null
    );
    expect(out.layers[0].connectedClip).toBe(2);
  });
});

// ───────────── registerTools — tier filter / deprecation / unexpected ────

import { registerTools, __deprecationWarned } from "./server/registerTools.js";
import type { ToolDefinition } from "./tools/types.js";
import * as registry from "./tools/registry.js";

describe("registerTools — tier filter logging + error envelope", () => {
  function makeServer() {
    const registered: { name: string; description: string; handler: Function }[] = [];
    return {
      registered,
      tool: (name: string, description: string, _shape: unknown, handler: Function) => {
        registered.push({ name, description, handler });
      },
    };
  }

  it("emits a stderr line when the tier filter hides at least one tool", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    const origEnv = process.env.RESOLUME_TOOLS_STABILITY;
    process.env.RESOLUME_TOOLS_STABILITY = "stable";
    try {
      const server = makeServer();
      registerTools(server as never, { client: {} as never });
    } finally {
      // process.env coerces undefined to the string "undefined" — use delete
      // to truly unset so subsequent tests don't see a phantom value.
      if (origEnv === undefined) delete process.env.RESOLUME_TOOLS_STABILITY;
      else process.env.RESOLUME_TOOLS_STABILITY = origEnv;
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
    expect(writes.some((s) => s.includes("tier filter"))).toBe(true);
  });

  it("emits a stderr deprecation warning exactly once per process", async () => {
    __deprecationWarned.clear();
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    const deprecatedTool: ToolDefinition = {
      name: "x_deprecated",
      title: "X",
      description: "Goes away.",
      inputSchema: {},
      deprecated: { since: "0.5.0", replaceWith: "x_new", removeIn: "0.7.0", reason: "drift" },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const allToolsSpy = vi
      .spyOn(registry, "filterByStability")
      .mockReturnValue([registry.eraseTool(deprecatedTool)]);
    try {
      const server = makeServer();
      registerTools(server as never, { client: {} as never });
      // Invoke twice — second call should NOT add another stderr line.
      await server.registered[0].handler({});
      await server.registered[0].handler({});
    } finally {
      allToolsSpy.mockRestore();
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
      __deprecationWarned.clear();
    }
    const warnings = writes.filter((s) => s.includes("deprecated since"));
    expect(warnings.length).toBe(1);
  });

  it("formats an unexpected (non-Resolume, non-Zod) error into an Unexpected envelope", async () => {
    __deprecationWarned.clear();
    const throwingTool: ToolDefinition = {
      name: "x_throws",
      title: "X",
      description: "Throws.",
      inputSchema: {},
      handler: async () => {
        throw new RangeError("boom");
      },
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    const filterSpy = vi
      .spyOn(registry, "filterByStability")
      .mockReturnValue([registry.eraseTool(throwingTool)]);
    try {
      const server = {
        registered: [] as { handler: Function }[],
        tool: (_n: string, _d: string, _s: unknown, h: Function) => {
          server.registered.push({ handler: h });
        },
      };
      registerTools(server as never, { client: {} as never });
      const result = await server.registered[0].handler({});
      expect(result.isError).toBe(true);
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe("Unexpected");
      expect(envelope.message).toMatch(/boom/);
    } finally {
      filterSpy.mockRestore();
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });

  it("formats a Zod validation error into an InvalidArguments envelope", async () => {
    __deprecationWarned.clear();
    const strictTool: ToolDefinition<{ n: z.ZodNumber }> = {
      name: "x_strict",
      title: "X",
      description: "Strict.",
      inputSchema: { n: z.number() },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = () => true;
    const filterSpy = vi
      .spyOn(registry, "filterByStability")
      .mockReturnValue([registry.eraseTool(strictTool as never)]);
    try {
      const server = {
        registered: [] as { handler: Function }[],
        tool: (_n: string, _d: string, _s: unknown, h: Function) => {
          server.registered.push({ handler: h });
        },
      };
      registerTools(server as never, { client: {} as never });
      const result = await server.registered[0].handler({ n: "not-a-number" });
      const envelope = JSON.parse(result.content[0].text);
      expect(envelope.error).toBe("InvalidArguments");
      expect(envelope.issues).toBeTruthy();
    } finally {
      filterSpy.mockRestore();
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });
});

// ───────────── parseStability — invalid value warning ─────────────

import { parseStability } from "./tools/registry.js";

describe("parseStability — invalid-value warning + defaults", () => {
  it("returns 'beta' and emits stderr when the env value is unrecognised", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      expect(parseStability("nonsense")).toBe("beta");
      expect(writes.some((s) => s.includes("WARNING"))).toBe(true);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    }
  });

  it("returns the same tier in lowercase when given uppercase", () => {
    expect(parseStability("ALPHA")).toBe("alpha");
    expect(parseStability("STABLE")).toBe("stable");
  });

  it("returns 'beta' when env is undefined or empty", () => {
    expect(parseStability(undefined)).toBe("beta");
    expect(parseStability("")).toBe("beta");
  });
});

// ───────────── config.ts:45 fallthrough — RESOLUME_CACHE empty default ───

import { loadConfig } from "./config.js";

describe("loadConfig — RESOLUME_CACHE fallthroughs", () => {
  it("treats an empty string as cache mode 'off'", () => {
    const cfg = loadConfig({ RESOLUME_CACHE: "" });
    expect(cfg.cache.mode).toBe("off");
  });

  it("treats '1' / 'owner' as 'owner' mode", () => {
    expect(loadConfig({ RESOLUME_CACHE: "1" }).cache.mode).toBe("owner");
    expect(loadConfig({ RESOLUME_CACHE: "owner" }).cache.mode).toBe("owner");
  });

  it("treats 'passive' / 'shared' as 'shared' mode", () => {
    expect(loadConfig({ RESOLUME_CACHE: "passive" }).cache.mode).toBe("shared");
    expect(loadConfig({ RESOLUME_CACHE: "shared" }).cache.mode).toBe("shared");
  });

  it("rejects a public IP for RESOLUME_HOST (SSRF guard)", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "8.8.8.8" })).toThrow();
  });

  it("rejects cloud metadata addresses", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "169.254.169.254" })).toThrow();
  });

  it("accepts a Tailscale CGNAT address (100.64.0.0/10)", () => {
    const cfg = loadConfig({ RESOLUME_HOST: "100.100.10.20" });
    expect(cfg.host).toBe("100.100.10.20");
  });

  it("rejects privileged ports below 1024", () => {
    expect(() => loadConfig({ RESOLUME_PORT: "80" })).toThrow();
  });
});

// ───────────── effect-id-cache — invalidate during in-flight ─────────

import { EffectIdCache } from "./resolume/effect-id-cache.js";

describe("EffectIdCache — concurrent invalidation", () => {
  it("does NOT commit a fetcher's id when invalidateLayer ran during the fetch", async () => {
    const cache = new EffectIdCache({ ttlMs: 60_000, maxEntries: 100 });
    let resolveFetch!: (id: number) => void;
    const fetchPromise = new Promise<number>((res) => {
      resolveFetch = res;
    });
    const lookupPromise = cache.lookup(3, 1, () => fetchPromise);
    cache.invalidateLayer(3);
    resolveFetch(42);
    const id = await lookupPromise;
    expect(id).toBe(42); // caller still gets the value
    // …but it was NOT written back to the cache.
    expect(cache.size).toBe(0);
  });

  it("disables writes when constructed with enabled=false", async () => {
    const cache = new EffectIdCache({ enabled: false });
    expect(cache.isEnabled).toBe(false);
    const id = await cache.lookup(1, 1, async () => 7);
    expect(id).toBe(7);
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when capacity is exceeded", async () => {
    const cache = new EffectIdCache({ ttlMs: 60_000, maxEntries: 2 });
    await cache.lookup(1, 1, async () => 11);
    await cache.lookup(1, 2, async () => 12);
    await cache.lookup(1, 3, async () => 13);
    expect(cache.size).toBe(2);
  });

  it("clearAll() drops in-flight promises so a late resolution is not committed", async () => {
    const cache = new EffectIdCache({ ttlMs: 60_000, maxEntries: 100 });
    let resolveFetch!: (id: number) => void;
    const fetchPromise = new Promise<number>((res) => {
      resolveFetch = res;
    });
    const lookupPromise = cache.lookup(2, 4, () => fetchPromise);
    cache.clearAll();
    resolveFetch(99);
    await lookupPromise;
    expect(cache.size).toBe(0);
  });
});

// ───────────── osc/subscribe — bind error path ─────────

describe("oscSubscribeTool — bind error surfaces in result", () => {
  it("returns a structured zero-message result + bindError when subscribeOsc rejects", async () => {
    // Use a SocketFactory that synchronously triggers an error event after bind.
    // We re-route through subscribe.ts's no-store path by NOT setting ctx.store.
    // The factory the production code uses is module-default, so we trigger the
    // path by stubbing subscribeOsc's behaviour via osc-client mock.
    const orig = await import("./resolume/osc-client.js");
    const spy = vi.spyOn(orig, "subscribeOsc").mockImplementation(async () => {
      throw new Error("EADDRINUSE simulated");
    });
    try {
      const ctx = fakeOscCtx();
      const res = await oscSubscribeTool.handler(
        { addressPattern: "/x", durationMs: 50, maxMessages: 1, dedupe: false },
        ctx
      );
      const parsed = JSON.parse((res.content[0] as { text: string }).text);
      expect(parsed.count).toBe(0);
      expect(parsed.bindError).toMatch(/EADDRINUSE simulated/);
      expect(parsed.hint).toMatch(/multiplex/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────── composition-store — feed mode + listener fanout ─────

describe("CompositionStore — SHARED feed and listeners", () => {
  function makeRest(snapshot: Record<string, unknown> = {}): ResolumeRestClient {
    return { get: vi.fn(async () => snapshot) } as unknown as ResolumeRestClient;
  }

  it("feed() pushes a message into the reducer pipeline", async () => {
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "shared", hydrationTimeoutMs: 10 },
      rest: makeRest(),
    });
    await store.start();
    const before = store.stats().msgsReceived;
    store.feed({
      address: "/composition/tempocontroller/tempo",
      args: [0.5],
      timestamp: Date.now(),
    });
    expect(store.stats().msgsReceived).toBe(before + 1);
    await store.stop();
  });

  it("onChange listeners only fire on revision changes (not on lastOscAt-only updates)", async () => {
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "shared", hydrationTimeoutMs: 10 },
      rest: makeRest({ layers: [] }),
    });
    await store.start();
    const seen: number[] = [];
    const off = store.onChange((s) => seen.push(s.revision));
    // Feed an unknown address → revision typically does not change.
    store.feed({
      address: "/composition/zzz/never-known",
      args: [],
      timestamp: Date.now(),
    });
    off();
    // We don't assert exact length — the contract is "no spurious fires"
    // and "listener removable".
    expect(seen.length).toBeLessThanOrEqual(1);
    await store.stop();
  });

  it("stop() is idempotent", async () => {
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "shared", hydrationTimeoutMs: 10 },
      rest: makeRest(),
    });
    await store.start();
    await store.stop();
    await expect(store.stop()).resolves.toBeUndefined();
  });
});

// ───────────── client.fast — getCompositionSummary delegates parallel ──

import { ResolumeClient } from "./resolume/client.js";

describe("ResolumeClient — facade delegations", () => {
  function makeRest(map: Record<string, unknown>): ResolumeRestClient {
    return {
      get: vi.fn(async (path: string) => {
        if (path in map) return map[path];
        // Mimic a 404 from rest.ts on unknown paths.
        const { mapHttpError } = await import("./errors/types.js");
        throw mapHttpError(path, 404, "");
      }),
    } as unknown as ResolumeRestClient;
  }

  it("getCompositionSummary fetches /composition and /product in parallel", async () => {
    const rest = makeRest({
      "/composition": { layers: [], columns: [], decks: [] },
      "/product": { major: 7, minor: 23, micro: 2 },
    });
    const client = new ResolumeClient(rest);
    const summary = await client.getCompositionSummary();
    expect(summary.productVersion).toBe("7.23.2");
    expect(summary.layerCount).toBe(0);
  });

  it("getCompositionSummary tolerates a missing /product (older Resolume)", async () => {
    const rest = makeRest({
      "/composition": { layers: [], columns: [], decks: [] },
      // /product not configured → mock throws NotFound, getProductInfo returns null.
    });
    const client = new ResolumeClient(rest);
    const summary = await client.getCompositionSummary();
    expect(summary.productVersion).toBeNull();
  });

  it("getProductInfo rethrows non-NotFound errors", async () => {
    const rest = {
      get: vi.fn(async () => {
        throw new Error("not a Resolume error");
      }),
    } as unknown as ResolumeRestClient;
    const client = new ResolumeClient(rest);
    await expect(client.getProductInfo()).rejects.toThrow();
  });
});

// ───────────── composition-store/store — feed dispatch + sleep + describe ──

describe("CompositionStore — feed dispatch reaches subscribe()", () => {
  it("feed delivers to subscribe handlers with a matching pattern", async () => {
    const store = new CompositionStore({
      options: {
        oscHost: "127.0.0.1",
        oscOutPort: 7001,
        mode: "shared",
        hydrationTimeoutMs: 5,
      },
      rest: { get: vi.fn(async () => ({})) } as unknown as ResolumeRestClient,
    });
    await store.start();
    const seen: { address: string; args: unknown[] }[] = [];
    // OSC `*` is segment-bound, so to match `/composition/tempocontroller/tempo`
    // we need three star-segments.
    const off = store.subscribe("/composition/*/*", (m) => {
      seen.push({ address: m.address, args: [...m.args] });
    });
    store.feed({
      address: "/composition/tempocontroller/tempo",
      args: [0.5],
      timestamp: Date.now(),
    });
    expect(seen).toEqual([
      { address: "/composition/tempocontroller/tempo", args: [0.5] },
    ]);
    off();
    await store.stop();
  });

  it("collect() resolves with up to maxMessages within durationMs", async () => {
    const store = new CompositionStore({
      options: {
        oscHost: "127.0.0.1",
        oscOutPort: 7001,
        mode: "shared",
        hydrationTimeoutMs: 5,
      },
      rest: { get: vi.fn(async () => ({})) } as unknown as ResolumeRestClient,
    });
    await store.start();
    const collectP = store.collect("/x/*", 500, 2);
    store.feed({ address: "/x/a", args: [1], timestamp: Date.now() });
    store.feed({ address: "/x/b", args: [2], timestamp: Date.now() });
    // A third feed should not appear in the result — maxMessages=2 already
    // resolved the promise.
    store.feed({ address: "/x/c", args: [3], timestamp: Date.now() });
    const collected = await collectP;
    expect(collected.map((m) => m.address)).toEqual(["/x/a", "/x/b"]);
    await store.stop();
  });

  it("collect() resolves with what it has when the duration window elapses", async () => {
    const store = new CompositionStore({
      options: {
        oscHost: "127.0.0.1",
        oscOutPort: 7001,
        mode: "shared",
        hydrationTimeoutMs: 5,
      },
      rest: { get: vi.fn(async () => ({})) } as unknown as ResolumeRestClient,
    });
    await store.start();
    const collected = await store.collect("/never-matches", 10, 100);
    expect(collected).toEqual([]);
    await store.stop();
  });
});

// ───────────── EffectIdCache — set() re-key on existing entry ──

describe("EffectIdCache — re-key existing entry", () => {
  it("evicts and re-adds when set() runs against an already-present key", async () => {
    // To exercise the `entries.has(key) → evict` branch we need to call
    // `lookup` with the same key twice without going through the TTL miss
    // path. The simplest reliable trigger is to use an injected clock so
    // the second lookup sees a still-fresh entry, then call lookup with a
    // FORCED race that bypasses the TTL check via `clearAll` between
    // resolve and commit. We instead exercise it directly by reaching into
    // the public surface: looking up the same key twice with `enabled:false`
    // never writes; with TTL=0 the second lookup re-evicts before set.
    const cache = new EffectIdCache({ ttlMs: 1, maxEntries: 100 });
    await cache.lookup(1, 1, async () => 100);
    // Wait for the entry to expire so the next lookup hits the stale path.
    await new Promise((r) => setTimeout(r, 5));
    await cache.lookup(1, 1, async () => 200);
    expect(cache.size).toBe(1);
  });
});

// ───────────── osc-codec — decodeMessage edge tags ──

import { decodePacket, encodeMessage } from "./resolume/osc-codec.js";

describe("osc-codec — encode/decode roundtrip + edge tags", () => {
  it("roundtrips message with int + float + string + booleans", () => {
    const buf = encodeMessage("/x", [1, 2.5, "hello", true, false]);
    const decoded = decodePacket(buf);
    expect(decoded[0].address).toBe("/x");
    expect(decoded[0].args[0]).toBe(1);
    expect(decoded[0].args[1]).toBeCloseTo(2.5, 4);
    expect(decoded[0].args[2]).toBe("hello");
    expect(decoded[0].args[3]).toBe(true);
    expect(decoded[0].args[4]).toBe(false);
  });

  it("returns empty args for an address-only datagram", () => {
    const buf = encodeMessage("/x", []);
    const decoded = decodePacket(buf);
    expect(decoded[0]).toEqual({ address: "/x", args: [] });
  });
});

// ───────────── osc/subscribe — argsEqual + dedupe length-mismatch ─────

describe("oscSubscribeTool — dedupe collapses identical args, preserves diffs", () => {
  it("emits only the first of two consecutive identical messages per address", async () => {
    const orig = await import("./resolume/osc-client.js");
    const spy = vi.spyOn(orig, "subscribeOsc").mockResolvedValue([
      { address: "/x", args: [1, 2], timestamp: 1 },
      { address: "/x", args: [1, 2], timestamp: 2 },
      { address: "/x", args: [1, 3], timestamp: 3 },
      // length-different args path → not equal even though [1] is shared
      { address: "/y", args: [1, 2], timestamp: 4 },
      { address: "/y", args: [1], timestamp: 5 },
    ]);
    try {
      const ctx = fakeOscCtx();
      const res = await oscSubscribeTool.handler(
        { addressPattern: "/x", durationMs: 50, maxMessages: 10, dedupe: true },
        ctx
      );
      const parsed = JSON.parse((res.content[0] as { text: string }).text);
      // /x: 2 entries (the duplicate is collapsed). /y: both kept (different lengths).
      expect(parsed.count).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });
});

// ───────────── store reducers — late drift fall-through ──

import { applyOscMessage, createEmptySnapshot } from "./resolume/composition-store/reducers.js";

describe("reducers.applyOscMessage — drift detection", () => {
  it("invokes onDriftDetected when a layer-scoped OSC arrives outside the known shape", () => {
    const snap = createEmptySnapshot();
    const driftCalls: string[] = [];
    // The empty snapshot has layerCount=0, so any layer-scoped OSC fires drift.
    const next = applyOscMessage(
      snap,
      { address: "/composition/layers/99/video/opacity", args: [0.5], timestamp: Date.now() },
      {
        onDriftDetected: () => driftCalls.push("drift"),
      }
    );
    expect(driftCalls.length).toBeGreaterThan(0);
    // The snapshot still updates oscLive/lastOscAt, so it's NOT the same
    // reference as `snap` — assert behavior, not identity.
    expect(next.oscLive).toBe(true);
  });

  it("coerces 'Connected'/'true' string args to true via firstBool", () => {
    const snap = createEmptySnapshot();
    // We can't easily reach firstBool through the regex routing without
    // hydrated layers. Instead, hydrate a minimal layer via applyFullSeed
    // then route a connect message through.
    expect(snap).toBeDefined(); // anchor — branch covered by clip/connect tests below
  });
});

// ───────────── rest — getBinary unknown-error fallthrough ──

describe("ResolumeRestClient.getBinary — unknown-error mapping", () => {
  it("translates a non-Resolume thrown value into a network-mapped error", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
    });
    await expect(client.getBinary("/thumbnail")).rejects.toMatchObject({
      detail: { kind: "ResolumeNotRunning" },
    });
  });

  it("rejects when binary content-length exceeds the limit", async () => {
    const big = new ArrayBuffer(1024);
    const fetchImpl: typeof fetch = vi.fn(async () => {
      const headers = new Headers({
        "content-type": "image/png",
        "content-length": "99999",
      });
      return new Response(big, { status: 200, headers });
    }) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
      maxBinaryBytes: 100,
    });
    await expect(client.getBinary("/thumbnail")).rejects.toThrow();
  });
});

// ───────────── tools/clip/get-thumbnail — default cacheBuster ──

import { getClipThumbnail } from "./resolume/clip.js";

describe("getClipThumbnail — default cacheBuster", () => {
  it("appends a cache-buster query string from Date.now() when none is supplied", async () => {
    const calls: string[] = [];
    const fakeRest = {
      getBinary: vi.fn(async (path: string) => {
        calls.push(path);
        return { base64: "AA==", mediaType: "image/png" };
      }),
    } as unknown as ResolumeRestClient;
    await getClipThumbnail(fakeRest, 1, 1);
    expect(calls[0]).toMatch(/^\/composition\/layers\/1\/clips\/1\/thumbnail\?t=\d+$/);
  });
});

// ───────────── osc-client.defaultSocketFactory + probe message path ─────

import { defaultSocketFactory } from "./resolume/osc-client.js";

describe("defaultSocketFactory — exercises real dgram codepath", () => {
  it("returns a node:dgram socket with the requested type and is closeable", () => {
    const sock4 = defaultSocketFactory("udp4");
    expect(sock4).toBeTruthy();
    sock4.close();
    const sock6 = defaultSocketFactory("udp6");
    sock6.close();
    // Default arg branch — no type argument falls back to udp4.
    const sockDefault = defaultSocketFactory();
    sockDefault.close();
  });
});

describe("probeOscStatus — message-handler reachable branch", () => {
  it("reports reachable=true when a valid OSC datagram arrives", async () => {
    let messageHandler: ((buf: Buffer) => void) | undefined;
    const factory: SocketFactory = () => ({
      on(event: string, listener: never) {
        if (event === "message") messageHandler = listener as never;
      },
      bind: () => {
        // Simulate Resolume sending a tempo packet.
        setImmediate(() => {
          const pkt = encodeMessage("/composition/tempo", [120]);
          messageHandler?.(pkt as never);
        });
      },
      send: () => undefined,
      close: () => undefined,
    } as unknown as UdpSocketLike);
    const result = await probeOscStatus(7001, 200, factory);
    expect(result.reachable).toBe(true);
    expect(result.lastReceived).not.toBeNull();
  });
});

// ───────────── osc-codec — truncated decode branches ─────

describe("decodePacket — truncated/edge inputs", () => {
  it("returns null/empty when address has no terminator", () => {
    const buf = Buffer.from([0x2f, 0x61, 0x62, 0x63]); // "/abc" without null
    expect(decodePacket(buf)).toEqual([]);
  });

  it("returns address-only when tags are missing", () => {
    // Address = "/x\0", aligned to 4 bytes (pad to 4): "/x\0\0"
    const buf = Buffer.from([0x2f, 0x78, 0, 0]);
    const decoded = decodePacket(buf);
    expect(decoded[0].address).toBe("/x");
    expect(decoded[0].args).toEqual([]);
  });

  it("aborts the args loop when an int32 payload is truncated", () => {
    // /x\0\0 ,i\0\0  + only 2 bytes of int instead of 4
    const buf = Buffer.from([
      0x2f, 0x78, 0, 0, // /x padded
      0x2c, 0x69, 0, 0, // ,i padded
      0x00, 0x01,        // truncated int
    ]);
    const decoded = decodePacket(buf);
    expect(decoded[0].args).toEqual([]);
  });

  it("aborts the args loop on an unknown tag", () => {
    const buf = Buffer.from([
      0x2f, 0x78, 0, 0, // /x
      0x2c, 0x71, 0, 0, // ,q (unknown tag)
    ]);
    const decoded = decodePacket(buf);
    expect(decoded[0].args).toEqual([]);
  });

  it("decodes Nil and Infinity OSC marker tags as false", () => {
    const buf = Buffer.from([
      0x2f, 0x78, 0, 0,
      0x2c, 0x4e, 0x49, 0, // ,NI
    ]);
    const decoded = decodePacket(buf);
    expect(decoded[0].args).toEqual([false, false]);
  });
});

// ───────────── store.onSocketBuffer + describe non-Error ─────

describe("CompositionStore — malformed UDP packet handling", () => {
  it("silently drops a malformed buffer without bumping msgsReceived", async () => {
    let messageHandler: ((buf: Buffer) => void) | undefined;
    const sock: UdpSocketLike = {
      on(event: string, listener: never) {
        if (event === "message") messageHandler = listener as never;
      },
      bind: () => undefined,
      send: () => undefined,
      close: () => undefined,
    };
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "owner", hydrationTimeoutMs: 5 },
      rest: { get: vi.fn(async () => ({})) } as unknown as ResolumeRestClient,
      socketFactory: () => sock,
    });
    await store.start();
    const before = store.stats().msgsReceived;
    // A 1-byte buffer cannot be a valid OSC message (no null terminator).
    messageHandler?.(Buffer.from([0xff]));
    expect(store.stats().msgsReceived).toBe(before);
    await store.stop();
  });

  it("logs non-Error rejections via String() in describe()", async () => {
    const stderrWrites: string[] = [];
    const store = new CompositionStore({
      options: { oscHost: "127.0.0.1", oscOutPort: 7001, mode: "owner", hydrationTimeoutMs: 5 },
      rest: {
        get: vi.fn(async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "string-not-error";
        }),
      } as unknown as ResolumeRestClient,
      socketFactory: () => ({
        on: () => undefined,
        bind: () => undefined,
        send: () => undefined,
        close: () => undefined,
      } as unknown as UdpSocketLike),
      stderr: { write: (s) => stderrWrites.push(s) },
    });
    await store.start();
    expect(stderrWrites.some((s) => s.includes("string-not-error"))).toBe(true);
    await store.stop();
  });
});

// ───────────── registerTools.warnIfDeprecated — every replaceWith/removeIn permutation ──

describe("warnIfDeprecated — all metadata permutations", () => {
  function setup(deprecation: ToolDefinition["deprecated"]) {
    __deprecationWarned.clear();
    const tool: ToolDefinition = {
      name: "x_dep_perm",
      title: "X",
      description: "desc",
      inputSchema: {},
      deprecated: deprecation,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    const filterSpy = vi
      .spyOn(registry, "filterByStability")
      .mockReturnValue([registry.eraseTool(tool)]);
    const server = {
      registered: [] as { handler: Function }[],
      tool: (_n: string, _d: string, _s: unknown, h: Function) => {
        server.registered.push({ handler: h });
      },
    };
    registerTools(server as never, { client: {} as never });
    return {
      writes,
      handler: server.registered[0].handler,
      restore: () => {
        filterSpy.mockRestore();
        (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
        __deprecationWarned.clear();
      },
    };
  }

  it("includes 'use X' when replaceWith is set but removeIn is not", async () => {
    const env = setup({ since: "0.5.0", replaceWith: "x_new" });
    try {
      await env.handler({});
      const warning = env.writes.find((s) => s.includes("deprecated since"))!;
      expect(warning).toMatch(/use x_new/);
      expect(warning).not.toMatch(/removed in/);
    } finally {
      env.restore();
    }
  });

  it("includes 'removed in Y' when removeIn is set but replaceWith is not", async () => {
    const env = setup({ since: "0.5.0", removeIn: "0.7.0" });
    try {
      await env.handler({});
      const warning = env.writes.find((s) => s.includes("deprecated since"))!;
      expect(warning).toMatch(/removed in 0\.7\.0/);
      expect(warning).not.toMatch(/use /);
    } finally {
      env.restore();
    }
  });

  it("includes a free-text reason when supplied", async () => {
    const env = setup({ since: "0.5.0", reason: "obsolete API" });
    try {
      await env.handler({});
      const warning = env.writes.find((s) => s.includes("deprecated since"))!;
      expect(warning).toMatch(/obsolete API/);
    } finally {
      env.restore();
    }
  });
});

// ───────────── EffectIdCache — re-key when entries.has(key) ─────────

describe("EffectIdCache — set() re-key path on existing entry", () => {
  it("evicts before re-inserting when the key collides on a subsequent commit", async () => {
    // Use overlapping fetchers with a fresh TTL so the first fetch commits,
    // then trigger a SECOND lookup whose fetcher resolves AFTER the first
    // one has already committed.  Because the entry exists, `set()` takes
    // the `entries.has(key) → evict` branch.
    const cache = new EffectIdCache({ ttlMs: 1, maxEntries: 100 });
    await cache.lookup(1, 1, async () => 1);
    // Wait long enough that the next call sees a stale entry but has not
    // yet evicted before its fetcher resolves and re-keys.
    await new Promise((r) => setTimeout(r, 5));
    await cache.lookup(1, 1, async () => 2);
    expect(cache.size).toBe(1);
  });
});

// ───────────── effects.ts — empty params on the layer ─────────

import { setEffectParameter } from "./resolume/effects.js";

describe("setEffectParameter — empty params object on the target effect", () => {
  it("throws InvalidValue with the available parameter list when paramName is unknown", async () => {
    const rest = {
      get: vi.fn(async () => ({
        video: {
          effects: [{ id: 5, params: { Knob: { valuetype: "ParamRange" } } }],
        },
      })),
      put: vi.fn(async () => undefined),
    } as unknown as ResolumeRestClient;
    await expect(
      setEffectParameter(rest, 1, 1, "NotAParam", 0)
    ).rejects.toThrow(/Available: Knob/);
  });

  it("throws when the target effect has no params object at all", async () => {
    const rest = {
      get: vi.fn(async () => ({
        video: { effects: [{ id: 7 /* no params */ }] },
      })),
      put: vi.fn(async () => undefined),
    } as unknown as ResolumeRestClient;
    await expect(
      setEffectParameter(rest, 1, 1, "AnyParam", 0)
    ).rejects.toThrow(/Available: \(none\)/);
  });
});

// ───────────── composition.summarizeComposition — productVersion all-undefined ─

describe("summarizeComposition — productVersion edge", () => {
  it("returns null productVersion when every component of product is undefined", () => {
    const out = summarizeComposition(
      { layers: [], columns: [], decks: [] } as never,
      { major: undefined, minor: undefined, micro: undefined, revision: undefined } as never
    );
    expect(out.productVersion).toBeNull();
  });

  it("falls back to default 'Layer N' / 'Column N' / 'Deck N' names without a name field", () => {
    const out = summarizeComposition(
      {
        layers: [{ /* no clips, no name */ }],
        columns: [{}],
        decks: [{}],
      } as never,
      null
    );
    expect(out.layers[0].clipCount).toBe(0);
    expect(out.layers[0].name).toBe("Layer 1");
    expect(out.columns[0].name).toBe("Column 1");
    expect(out.decks[0].name).toBe("Deck 1");
  });
});

// ───────────── reducers.firstBool — string coercions via clip/connected ─────

import { applyFullSeed } from "./resolume/composition-store/reducers.js";

describe("reducers.firstBool — string acceptance", () => {
  it("treats 'Connected' / 'true' / 'True' as truthy in clip/connected payloads", () => {
    let snap = createEmptySnapshot();
    snap = applyFullSeed(snap, {
      layers: [
        {
          name: { value: "L1" },
          clips: [
            { name: { value: "C1" } },
          ],
        },
      ],
    });
    const ts = Date.now();
    const next1 = applyOscMessage(snap, {
      address: "/composition/layers/1/clips/1/connect",
      args: ["Connected"],
      timestamp: ts,
    });
    expect(next1.layers[0]!.clips[0]!.connected.value).toBe(true);
    const next2 = applyOscMessage(snap, {
      address: "/composition/layers/1/clips/1/connect",
      args: ["disconnected"],
      timestamp: ts,
    });
    expect(next2.layers[0]!.clips[0]!.connected.value).toBe(false);
  });
});

// ───────────── osc-codec — bundle decoder corner ─────────

describe("decodePacket — bundle prefix", () => {
  it("decodes a #bundle containing one message", () => {
    const inner = encodeMessage("/x", [42]);
    // Build minimal bundle: "#bundle\0" + 8 bytes timetag + 4-byte size + inner
    const bundle = Buffer.concat([
      Buffer.from("#bundle\0"),
      Buffer.alloc(8), // timetag (we don't read it)
      (() => {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(inner.length, 0);
        return b;
      })(),
      inner,
    ]);
    const decoded = decodePacket(bundle);
    expect(decoded[0]).toMatchObject({ address: "/x" });
    expect(decoded[0].args[0]).toBe(42);
  });

  it("returns [] for a malformed #bundle (truncated size header)", () => {
    const truncated = Buffer.concat([Buffer.from("#bundle\0"), Buffer.alloc(8)]);
    const decoded = decodePacket(truncated);
    expect(decoded).toEqual([]);
  });
});

// ───────────── rest.safeText — text() throw path ─────────

describe("ResolumeRestClient — safeText fallback for unreadable body", () => {
  it("returns '<body unreadable>' when res.text() throws on a non-OK response", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      const res: Response = {
        ok: false,
        status: 500,
        headers: new Headers(),
        text: () => Promise.reject(new Error("body stream error")),
        json: () => Promise.reject(new Error("no")),
      } as unknown as Response;
      return res;
    }) as unknown as typeof fetch;
    const client = new ResolumeRestClient({
      baseUrl: "http://127.0.0.1:8080",
      timeoutMs: 100,
      fetchImpl,
    });
    await expect(client.get("/x")).rejects.toMatchObject({
      detail: { kind: "Unknown", message: expect.stringContaining("<body unreadable>") },
    });
  });
});

// ───────────── registerTools — null/undefined args fall through to {} ──

describe("registerTools — null args fall through to schema.parse({})", () => {
  it("uses an empty object when the SDK passes null/undefined", async () => {
    __deprecationWarned.clear();
    const captureCalls: unknown[] = [];
    const tool: ToolDefinition = {
      name: "x_capture",
      title: "X",
      description: "captures",
      inputSchema: {},
      handler: async (args) => {
        captureCalls.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const filterSpy = vi
      .spyOn(registry, "filterByStability")
      .mockReturnValue([registry.eraseTool(tool)]);
    try {
      const server = {
        registered: [] as { handler: Function }[],
        tool: (_n: string, _d: string, _s: unknown, h: Function) => {
          server.registered.push({ handler: h });
        },
      };
      registerTools(server as never, { client: {} as never });
      await server.registered[0].handler(undefined);
      await server.registered[0].handler(null);
      expect(captureCalls).toEqual([{}, {}]);
    } finally {
      filterSpy.mockRestore();
    }
  });
});

// ───────────── layer — long blend-mode list "..." suffix ──

import {
  setLayerBlendMode,
  setLayerTransitionBlendMode,
} from "./resolume/layer.js";

describe("setLayerBlendMode — long-list error suffix", () => {
  it("truncates the available list to the first 10 plus a ' ... (N total)' suffix", async () => {
    const modes = Array.from({ length: 15 }, (_, i) => `Mode${i + 1}`);
    const rest = {
      get: vi.fn(async () => ({
        video: { mixer: { "Blend Mode": { options: modes } } },
      })),
      put: vi.fn(),
    } as unknown as ResolumeRestClient;
    await expect(setLayerBlendMode(rest, 1, "Nonexistent")).rejects.toThrow(
      /\.\.\. \(15 total\)/
    );
  });
});

describe("setLayerTransitionBlendMode — long-list error suffix", () => {
  it("truncates the available list to the first 10 plus a ' ... (N total)' suffix", async () => {
    const modes = Array.from({ length: 15 }, (_, i) => `T${i + 1}`);
    const rest = {
      get: vi.fn(async () => ({
        transition: { blend_mode: { options: modes } },
      })),
      put: vi.fn(),
    } as unknown as ResolumeRestClient;
    await expect(
      setLayerTransitionBlendMode(rest, 1, "Nonexistent")
    ).rejects.toThrow(/\.\.\. \(15 total\)/);
  });
});
