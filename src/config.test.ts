import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns sane defaults when env is empty", () => {
    expect(loadConfig({})).toEqual({
      host: "127.0.0.1",
      port: 8080,
      timeoutMs: 10_000,
      osc: { host: "127.0.0.1", inPort: 7000, outPort: 7001 },
      effectCacheEnabled: true,
      cache: { mode: "off" },
      wipeConcurrency: 4,
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
      effectCacheEnabled: true,
      cache: { mode: "off" },
      wipeConcurrency: 4,
    });
  });

  it("respects OSC environment overrides", () => {
    expect(
      loadConfig({
        RESOLUME_OSC_HOST: "100.64.0.1",
        RESOLUME_OSC_IN_PORT: "7100",
        RESOLUME_OSC_OUT_PORT: "7101",
      }).osc
    ).toEqual({ host: "100.64.0.1", inPort: 7100, outPort: 7101 });
  });

  it("rejects public OSC host to prevent SSRF", () => {
    expect(() => loadConfig({ RESOLUME_OSC_HOST: "8.8.8.8" })).toThrow();
  });

  it("rejects invalid OSC ports", () => {
    expect(() => loadConfig({ RESOLUME_OSC_IN_PORT: "0" })).toThrow();
    expect(() => loadConfig({ RESOLUME_OSC_OUT_PORT: "70000" })).toThrow();
    // Ports below 1024 are reserved (system/privileged) — reject them.
    expect(() => loadConfig({ RESOLUME_OSC_IN_PORT: "1023" })).toThrow();
    expect(() => loadConfig({ RESOLUME_OSC_OUT_PORT: "1023" })).toThrow();
    expect(() => loadConfig({ RESOLUME_OSC_IN_PORT: "1024" })).not.toThrow();
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
    expect(loadConfig({ RESOLUME_HOST: "100.64.0.1" }).host).toBe("100.64.0.1");
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
    // Ports below 1024 are reserved — reject them.
    expect(() => loadConfig({ RESOLUME_PORT: "1023" })).toThrow();
    expect(() => loadConfig({ RESOLUME_PORT: "1024" })).not.toThrow();
  });

  it("rejects extreme timeouts", () => {
    expect(() => loadConfig({ RESOLUME_TIMEOUT_MS: "10" })).toThrow();
    expect(() => loadConfig({ RESOLUME_TIMEOUT_MS: "999999999" })).toThrow();
  });

  describe("RESOLUME_EFFECT_CACHE", () => {
    it("defaults to enabled when unset", () => {
      expect(loadConfig({}).effectCacheEnabled).toBe(true);
    });

    it("'1' enables the cache", () => {
      expect(loadConfig({ RESOLUME_EFFECT_CACHE: "1" }).effectCacheEnabled).toBe(true);
    });

    it("'true' enables the cache", () => {
      expect(loadConfig({ RESOLUME_EFFECT_CACHE: "true" }).effectCacheEnabled).toBe(true);
    });

    it("'0' disables the cache", () => {
      expect(loadConfig({ RESOLUME_EFFECT_CACHE: "0" }).effectCacheEnabled).toBe(false);
    });

    it("'false' disables the cache", () => {
      expect(loadConfig({ RESOLUME_EFFECT_CACHE: "false" }).effectCacheEnabled).toBe(false);
    });

    it("rejects unrecognized values with a helpful error", () => {
      expect(() => loadConfig({ RESOLUME_EFFECT_CACHE: "yes" })).toThrow();
      expect(() => loadConfig({ RESOLUME_EFFECT_CACHE: "" })).toThrow();
    });
  });

  describe("RESOLUME_CACHE", () => {
    it("defaults to mode 'off' when unset", () => {
      expect(loadConfig({}).cache).toEqual({ mode: "off" });
    });

    it("treats empty string as 'off'", () => {
      expect(loadConfig({ RESOLUME_CACHE: "" }).cache.mode).toBe("off");
    });

    it("treats '0' as 'off'", () => {
      expect(loadConfig({ RESOLUME_CACHE: "0" }).cache.mode).toBe("off");
    });

    it("treats '1' as 'owner'", () => {
      expect(loadConfig({ RESOLUME_CACHE: "1" }).cache.mode).toBe("owner");
    });

    it("treats 'owner' as 'owner'", () => {
      expect(loadConfig({ RESOLUME_CACHE: "owner" }).cache.mode).toBe("owner");
    });

    it("treats 'passive' as 'shared'", () => {
      expect(loadConfig({ RESOLUME_CACHE: "passive" }).cache.mode).toBe("shared");
    });

    it("treats 'shared' as 'shared'", () => {
      expect(loadConfig({ RESOLUME_CACHE: "shared" }).cache.mode).toBe("shared");
    });

    it("rejects unknown values", () => {
      expect(() => loadConfig({ RESOLUME_CACHE: "true" })).toThrow();
      expect(() => loadConfig({ RESOLUME_CACHE: "yes" })).toThrow();
    });
  });

  describe("RESOLUME_WIPE_CONCURRENCY", () => {
    it("defaults to 4 when unset", () => {
      expect(loadConfig({}).wipeConcurrency).toBe(4);
    });
    it("accepts 1..16", () => {
      expect(loadConfig({ RESOLUME_WIPE_CONCURRENCY: "1" }).wipeConcurrency).toBe(1);
      expect(loadConfig({ RESOLUME_WIPE_CONCURRENCY: "8" }).wipeConcurrency).toBe(8);
      expect(loadConfig({ RESOLUME_WIPE_CONCURRENCY: "16" }).wipeConcurrency).toBe(16);
    });
    it("rejects 0 and negative values", () => {
      expect(() => loadConfig({ RESOLUME_WIPE_CONCURRENCY: "0" })).toThrow();
      expect(() => loadConfig({ RESOLUME_WIPE_CONCURRENCY: "-1" })).toThrow();
    });
    it("rejects values above 16 (Resolume HTTP throughput cliff)", () => {
      expect(() => loadConfig({ RESOLUME_WIPE_CONCURRENCY: "17" })).toThrow();
      expect(() => loadConfig({ RESOLUME_WIPE_CONCURRENCY: "100" })).toThrow();
    });
    it("rejects non-numeric values", () => {
      expect(() => loadConfig({ RESOLUME_WIPE_CONCURRENCY: "abc" })).toThrow();
    });
  });
});
