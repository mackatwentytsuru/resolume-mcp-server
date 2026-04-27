import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns sane defaults when env is empty", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 8080,
      timeoutMs: 10_000,
      osc: { host: "127.0.0.1", inPort: 7000, outPort: 7001 },
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
      osc: { host: "127.0.0.1", inPort: 7000, outPort: 7001 },
    });
  });

  it("respects OSC environment overrides", () => {
    expect(
      loadConfig({
        RESOLUME_OSC_HOST: "100.74.26.128",
        RESOLUME_OSC_IN_PORT: "7100",
        RESOLUME_OSC_OUT_PORT: "7101",
      }).osc
    ).toEqual({ host: "100.74.26.128", inPort: 7100, outPort: 7101 });
  });

  it("rejects public OSC host to prevent SSRF", () => {
    expect(() => loadConfig({ RESOLUME_OSC_HOST: "8.8.8.8" })).toThrow();
  });

  it("rejects invalid OSC ports", () => {
    expect(() => loadConfig({ RESOLUME_OSC_IN_PORT: "0" })).toThrow();
    expect(() => loadConfig({ RESOLUME_OSC_OUT_PORT: "70000" })).toThrow();
  });

  it("accepts localhost and IPv6 loopback", () => {
    expect(loadConfig({ RESOLUME_HOST: "localhost" }).host).toBe("localhost");
    expect(loadConfig({ RESOLUME_HOST: "::1" }).host).toBe("::1");
  });

  it("rejects public IPs to prevent SSRF", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "8.8.8.8" })).toThrow(/SSRF|private/);
    expect(() => loadConfig({ RESOLUME_HOST: "example.com" })).toThrow();
  });

  it("accepts Tailscale CGNAT range (100.64.0.0/10)", () => {
    expect(loadConfig({ RESOLUME_HOST: "100.74.26.128" }).host).toBe("100.74.26.128");
    expect(loadConfig({ RESOLUME_HOST: "100.64.0.1" }).host).toBe("100.64.0.1");
    expect(loadConfig({ RESOLUME_HOST: "100.127.255.255" }).host).toBe("100.127.255.255");
  });

  it("rejects 100.x ranges outside CGNAT", () => {
    expect(() => loadConfig({ RESOLUME_HOST: "100.0.0.1" })).toThrow();
    expect(() => loadConfig({ RESOLUME_HOST: "100.128.0.1" })).toThrow();
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
