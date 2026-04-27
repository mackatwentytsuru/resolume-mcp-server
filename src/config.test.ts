import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns sane defaults when env is empty", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 8080,
      timeoutMs: 10_000,
    });
  });

  it("respects environment overrides for private addresses", () => {
    expect(
      loadConfig({
        RESOLUME_HOST: "192.168.1.10",
        RESOLUME_PORT: "9090",
        RESOLUME_TIMEOUT_MS: "5000",
      })
    ).toEqual({
      host: "192.168.1.10",
      port: 9090,
      timeoutMs: 5000,
    });
  });

  it("accepts localhost and IPv6 loopback", () => {
    expect(loadConfig({ RESOLUME_HOST: "localhost" }).host).toBe("localhost");
    expect(loadConfig({ RESOLUME_HOST: "::1" }).host).toBe("::1");
  });

  it("rejects public IPs to prevent SSRF", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "8.8.8.8" })).toThrow(/SSRF|private/);
    expect(() => loadConfig({ RESOLUME_HOST: "example.com" })).toThrow();
  });

  it("rejects cloud metadata addresses", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "169.254.169.254" })).toThrow(/metadata/);
    expect(() => loadConfig({ RESOLUME_HOST: "metadata.google.internal" })).toThrow();
  });

  it("rejects host strings that include schemes or paths", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "http://localhost" })).toThrow();
    expect(() => loadConfig({ RESOLUME_HOST: "127.0.0.1/api" })).toThrow();
  });

  it("rejects invalid port", () => {
    expect(() => loadConfig({ RESOLUME_PORT: "-1" })).toThrow();
    expect(() => loadConfig({ RESOLUME_PORT: "abc" })).toThrow();
    expect(() => loadConfig({ RESOLUME_PORT: "70000" })).toThrow();
  });

  it("rejects extreme timeouts", () => {
    expect(() => loadConfig({ RESOLUME_TIMEOUT_MS: "10" })).toThrow();
    expect(() => loadConfig({ RESOLUME_TIMEOUT_MS: "999999999" })).toThrow();
  });
});
