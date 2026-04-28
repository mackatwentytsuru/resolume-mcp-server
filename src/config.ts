import { z } from "zod";

const HOST_PATTERN = /^[a-zA-Z0-9.:-]+$/;
// Loopback, RFC-1918 private, IPv6 ULA/link-local, plus Tailscale's CGNAT range
// 100.64.0.0/10 (RFC 6598) which mesh-VPN users commonly run Resolume over.
const PRIVATE_NET =
  /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|::1$|localhost$|fd[0-9a-f]{2}:|fe80:)/i;
const METADATA_ADDRS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.internal",
]);

// The same private-net guard is applied to the OSC host. Same SSRF threat
// model: an attacker who can set env vars shouldn't be able to point the
// MCP server at an arbitrary internet host.
const HostSchema = z
  .string()
  .refine((h) => HOST_PATTERN.test(h), {
    message: "host must be a hostname or IP (no scheme, no path).",
  })
  .refine((h) => !METADATA_ADDRS.has(h.toLowerCase()), {
    message: "host may not point at a cloud metadata service.",
  })
  .refine((h) => PRIVATE_NET.test(h) || h === "0.0.0.0", {
    message:
      "host must be a loopback or private-network address. Public hosts are refused to prevent SSRF.",
  });

/**
 * `RESOLUME_CACHE` toggle — gates the v0.5 CompositionStore.
 *
 * Default empty/`0` keeps the v0.4 behavior bit-for-bit identical: no socket
 * is bound, no cache is constructed. `1`/`owner` enables the OSC-OUT-bound
 * cache; `passive`/`shared` enables the cache without binding the socket
 * (other tools must feed it via `store.feed`).
 */
const CacheModeSchema = z
  .enum(["", "0", "1", "owner", "passive", "shared"])
  .default("")
  .transform((v) => {
    // The enum guarantees `v` is one of the six listed values — the final
    // branch below is total. No fallback case is needed (or reachable).
    if (v === "1" || v === "owner") return "owner" as const;
    if (v === "passive" || v === "shared") return "shared" as const;
    return "off" as const;
  });

const ConfigEnvSchema = z.object({
  RESOLUME_HOST: HostSchema.default("127.0.0.1"),
  RESOLUME_PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
  RESOLUME_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  RESOLUME_OSC_HOST: HostSchema.default("127.0.0.1"),
  RESOLUME_OSC_IN_PORT: z.coerce.number().int().min(1024).max(65535).default(7000),
  RESOLUME_OSC_OUT_PORT: z.coerce.number().int().min(1024).max(65535).default(7001),
  // v0.5: opt-out for the effect-id cache. Default-on is safe — the cache is
  // correctness-preserving by construction (synchronous invalidation on
  // add/remove/wipe/deck-switch + 300s TTL backstop). Set "0" or "false" to
  // restore v0.4.x GET-then-PUT behavior on every setEffectParameter call.
  RESOLUME_EFFECT_CACHE: z
    .enum(["0", "1", "true", "false"])
    .default("1")
    .transform((v) => v === "1" || v === "true"),
  RESOLUME_CACHE: CacheModeSchema,
  // v0.5.4: concurrency cap for `wipeComposition`'s parallel per-layer
  // `/clearclips` POSTs. Default 4 is safe for most compositions; raise
  // up to 16 for many-layered shows where the default round-trips
  // serially. Resolume's HTTP server starts losing throughput beyond
  // ~8 in-flight requests, so the cap is conservative.
  RESOLUME_WIPE_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4),
});

export interface OscConfig {
  host: string;
  inPort: number;
  outPort: number;
}

export interface CacheConfig {
  /** `off` (default), `owner` (binds OSC OUT), or `shared` (passive — fed by other tools). */
  mode: "off" | "owner" | "shared";
}

export interface ResolumeConfig {
  host: string;
  port: number;
  timeoutMs: number;
  osc: OscConfig;
  effectCacheEnabled: boolean;
  cache: CacheConfig;
  /** Per-layer concurrency cap for `wipeComposition`. Range 1..16, default 4. */
  wipeConcurrency: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolumeConfig {
  const parsed = ConfigEnvSchema.parse({
    RESOLUME_HOST: env.RESOLUME_HOST,
    RESOLUME_PORT: env.RESOLUME_PORT,
    RESOLUME_TIMEOUT_MS: env.RESOLUME_TIMEOUT_MS,
    RESOLUME_OSC_HOST: env.RESOLUME_OSC_HOST,
    RESOLUME_OSC_IN_PORT: env.RESOLUME_OSC_IN_PORT,
    RESOLUME_OSC_OUT_PORT: env.RESOLUME_OSC_OUT_PORT,
    RESOLUME_EFFECT_CACHE: env.RESOLUME_EFFECT_CACHE,
    RESOLUME_CACHE: env.RESOLUME_CACHE,
    RESOLUME_WIPE_CONCURRENCY: env.RESOLUME_WIPE_CONCURRENCY,
  });
  return {
    host: parsed.RESOLUME_HOST,
    port: parsed.RESOLUME_PORT,
    timeoutMs: parsed.RESOLUME_TIMEOUT_MS,
    osc: {
      host: parsed.RESOLUME_OSC_HOST,
      inPort: parsed.RESOLUME_OSC_IN_PORT,
      outPort: parsed.RESOLUME_OSC_OUT_PORT,
    },
    effectCacheEnabled: parsed.RESOLUME_EFFECT_CACHE,
    cache: { mode: parsed.RESOLUME_CACHE },
    wipeConcurrency: parsed.RESOLUME_WIPE_CONCURRENCY,
  };
}
