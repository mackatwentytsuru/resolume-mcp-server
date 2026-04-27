import { describe, it, expect } from "vitest";
import { mapHttpError, mapNetworkError, ResolumeApiError } from "./types.js";

describe("mapHttpError", () => {
  it("maps 404 to NotFound with recovery hint", () => {
    const err = mapHttpError("/api/v1/composition/layers/99", 404, "not found");
    expect(err).toBeInstanceOf(ResolumeApiError);
    expect(err.detail.kind).toBe("NotFound");
    expect(err.message).toContain("/api/v1/composition/layers/99");
    expect(err.message).toContain("resolume_get_composition");
  });

  it("maps 400 to BadRequest with parameter range hint", () => {
    const err = mapHttpError("/api/v1/composition/layers/1/video/opacity", 400, "value out of range");
    expect(err.detail.kind).toBe("BadRequest");
    expect(err.message).toContain("0..1");
  });

  it("maps 422 to BadRequest", () => {
    const err = mapHttpError("/api/v1/x", 422, "validation");
    expect(err.detail.kind).toBe("BadRequest");
  });

  it("maps unknown HTTP status to Unknown", () => {
    const err = mapHttpError("/api/v1/x", 500, "server error");
    expect(err.detail.kind).toBe("Unknown");
    expect(err.message).toContain("HTTP 500");
  });
});

describe("mapNetworkError", () => {
  it("maps ECONNREFUSED to ResolumeNotRunning", () => {
    const err = mapNetworkError("/api/v1/composition", new TypeError("fetch failed"));
    expect(err.detail.kind).toBe("ResolumeNotRunning");
    expect(err.message).toContain("Webserver");
  });

  it("maps timeout/abort to Timeout", () => {
    const err = mapNetworkError("/api/v1/x", new Error("The operation was aborted"));
    expect(err.detail.kind).toBe("Timeout");
  });

  it("maps unknown errors to Unknown", () => {
    const err = mapNetworkError("/api/v1/x", new Error("something weird"));
    expect(err.detail.kind).toBe("Unknown");
  });

  it("handles non-Error throws", () => {
    const err = mapNetworkError("/api/v1/x", "raw string");
    expect(err.detail.kind).toBe("Unknown");
    expect(err.message).toContain("raw string");
  });
});
