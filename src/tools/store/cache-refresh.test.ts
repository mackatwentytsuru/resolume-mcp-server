import { describe, it, expect, vi } from "vitest";
import { cacheRefreshTool } from "./cache-refresh.js";
import { buildCtx } from "../test-helpers.js";
import type { CompositionStore } from "../../resolume/composition-store/store.js";
import type { ToolContext } from "../types.js";

function fakeStore(refresh: () => Promise<{ durationMs: number; revision: number }>): CompositionStore {
  return { refresh } as unknown as CompositionStore;
}

describe("resolume_cache_refresh", () => {
  it("declares stable stability and an empty input schema", () => {
    expect(cacheRefreshTool.stability).toBe("stable");
    expect(Object.keys(cacheRefreshTool.inputSchema)).toHaveLength(0);
    expect(cacheRefreshTool.name).toBe("resolume_cache_refresh");
  });

  it("returns isError when the store is absent and includes the RESOLUME_CACHE hint", async () => {
    const { ctx } = buildCtx();
    const result = await cacheRefreshTool.handler({}, ctx);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("RESOLUME_CACHE");
    expect(text).toContain("disabled");
  });

  it("calls store.refresh() and returns its result as JSON when the store is present", async () => {
    const refresh = vi.fn(async () => ({ durationMs: 12, revision: 7 }));
    const { ctx: baseCtx } = buildCtx();
    const ctx: ToolContext = { ...baseCtx, store: fakeStore(refresh) };
    const result = await cacheRefreshTool.handler({}, ctx);
    expect(refresh).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
    const json = JSON.parse((result.content[0] as { text: string }).text);
    expect(json).toEqual({ durationMs: 12, revision: 7 });
  });

  it("propagates rejection from store.refresh() so safeHandle can wrap it", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("REST 503");
    });
    const { ctx: baseCtx } = buildCtx();
    const ctx: ToolContext = { ...baseCtx, store: fakeStore(refresh) };
    await expect(cacheRefreshTool.handler({}, ctx)).rejects.toThrow("REST 503");
  });
});
