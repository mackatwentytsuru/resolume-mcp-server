import { describe, it, expect, vi } from "vitest";
import { ResolumeRestClient } from "./rest.js";
import { ResolumeApiError } from "../errors/types.js";

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    return handler(u, init);
  }) as unknown as typeof fetch;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseConfig = { baseUrl: "http://localhost:8080", timeoutMs: 1000 };

describe("ResolumeRestClient.get", () => {
  it("returns parsed JSON from /api/v1 prefixed URL", async () => {
    const fetchImpl = makeFetch(() => makeJsonResponse({ ok: true, n: 42 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    const result = await client.get<{ ok: boolean; n: number }>("/composition");
    expect(result).toEqual({ ok: true, n: 42 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/composition",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("normalizes paths missing the leading slash", async () => {
    const fetchImpl = makeFetch(() => makeJsonResponse({}));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await client.get("composition");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/composition",
      expect.anything()
    );
  });

  it("maps 404 to a ResolumeApiError(NotFound)", async () => {
    const fetchImpl = makeFetch(
      () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await expect(client.get("/composition/layers/99")).rejects.toMatchObject({
      name: "ResolumeApiError",
      detail: { kind: "NotFound" },
    });
  });

  it("maps fetch failure to ResolumeNotRunning", async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await expect(client.get("/composition")).rejects.toMatchObject({
      detail: { kind: "ResolumeNotRunning" },
    });
  });

  it("maps abort to Timeout", async () => {
    const fetchImpl = makeFetch(async (_url, init) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      throw new Error("aborted");
    });
    const client = new ResolumeRestClient({ ...baseConfig, timeoutMs: 5, fetchImpl });
    await expect(client.get("/slow")).rejects.toMatchObject({
      detail: { kind: "Timeout" },
    });
  });
});

describe("ResolumeRestClient.put", () => {
  it("sends JSON body with content-type", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    const result = await client.put("/composition/layers/1/video/opacity", { value: 0.5 });
    expect(result).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/composition/layers/1/video/opacity",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ value: 0.5 }),
        headers: { "content-type": "application/json" },
      })
    );
  });

  it("propagates 400 as BadRequest", async () => {
    const fetchImpl = makeFetch(
      () => new Response("range error", { status: 400, headers: { "content-type": "text/plain" } })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await expect(
      client.put("/composition/layers/1/video/opacity", { value: 99 })
    ).rejects.toMatchObject({ detail: { kind: "BadRequest" } });
  });
});

describe("ResolumeRestClient.post", () => {
  it("works without a body (e.g. trigger column)", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await client.post("/composition/columns/1/connect");
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});

describe("ResolumeRestClient.postText", () => {
  it("sends a raw string body with text/plain content-type (no JSON encoding)", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await client.postText(
      "/composition/layers/2/effects/video/add",
      "effect:///video/Blur"
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/composition/layers/2/effects/video/add",
      expect.objectContaining({
        method: "POST",
        body: "effect:///video/Blur", // not JSON.stringify'd
        headers: { "content-type": "text/plain" },
      })
    );
  });

  it("returns undefined on 204 ack", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    expect(
      await client.postText("/composition/layers/1/effects/video/add", "effect:///video/Blur")
    ).toBeUndefined();
  });

  it("propagates 404 (e.g. when /add suffix is missing) as NotFound", async () => {
    const fetchImpl = makeFetch(
      () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await expect(
      client.postText("/composition/layers/99/effects/video/add", "effect:///video/Blur")
    ).rejects.toMatchObject({ detail: { kind: "NotFound" } });
  });
});

describe("ResolumeRestClient.delete", () => {
  it("issues a DELETE without body", async () => {
    const fetchImpl = makeFetch(() => new Response(null, { status: 204 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await client.delete("/composition/layers/3");
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});

describe("ResolumeRestClient non-JSON responses", () => {
  it("treats empty non-JSON 200 as undefined (PUT/POST ack)", async () => {
    const fetchImpl = makeFetch(
      () => new Response("", { status: 200, headers: { "content-type": "text/plain" } })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    expect(await client.put("/x", { value: 1 })).toBeUndefined();
  });

  it("throws Unknown for non-empty non-JSON 200 responses", async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response("<html>oops</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await expect(client.get("/composition")).rejects.toMatchObject({
      detail: { kind: "Unknown" },
    });
  });
});

describe("ResolumeRestClient.getBinary", () => {
  it("returns base64-encoded payload with media type", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = makeFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    const result = await client.getBinary("/composition/layers/1/clips/1/thumbnail");
    expect(result.mediaType).toBe("image/png");
    expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from(bytes));
  });

  it("throws structured error on 404", async () => {
    const fetchImpl = makeFetch(() => new Response("", { status: 404 }));
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl });
    await expect(client.getBinary("/x")).rejects.toBeInstanceOf(ResolumeApiError);
  });

  it("rejects responses larger than maxBinaryBytes (declared)", async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(new Uint8Array(10), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "999999" },
        })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl, maxBinaryBytes: 100 });
    await expect(client.getBinary("/big")).rejects.toMatchObject({
      detail: { kind: "Unknown" },
    });
  });

  it("rejects responses larger than maxBinaryBytes (actual)", async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(new Uint8Array(200), {
          status: 200,
          headers: { "content-type": "image/png" }, // no content-length
        })
    );
    const client = new ResolumeRestClient({ ...baseConfig, fetchImpl, maxBinaryBytes: 100 });
    await expect(client.getBinary("/big")).rejects.toMatchObject({
      detail: { kind: "Unknown" },
    });
  });
});
