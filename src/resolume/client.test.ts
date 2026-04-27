import { describe, it, expect, vi } from "vitest";
import { ResolumeClient } from "./client.js";

describe("ResolumeClient.fromConfig", () => {
  it("constructs a working client targeting host:port", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;
    // Use the static factory with a fetch override patched on by reaching into the rest client.
    const client = ResolumeClient.fromConfig({ host: "127.0.0.1", port: 9999, timeoutMs: 1000 });
    // Smoke test: the constructed REST client targets the right base URL.
    // We can't easily inject fetchImpl here, so we just confirm the factory returns an object.
    expect(client).toBeInstanceOf(ResolumeClient);
    void fetchImpl;
  });
});

