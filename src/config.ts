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

const ConfigEnvSchema = z.object({
  RESOLUME_HOST: z
    .string()
    .default("127.0.0.1")
    .refine((h) => HOST_PATTERN.test(h), {
      message: "RESOLUME_HOST must be a hostname or IP (no scheme, no path).",
    })
    .refine((h) => !METADATA_ADDRS.has(h.toLowerCase()), {
      message: "RESOLUME_HOST may not point at a cloud metadata service.",
    })
    .refine((h) => PRIVATE_NET.test(h) || h === "0.0.0.0", {
      message:
        "RESOLUME_HOST must be a loopback or private-network address. Public hosts are refused to prevent SSRF.",
    }),
  RESOLUME_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  RESOLUME_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
});

export interface ResolumeConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolumeConfig {
  const parsed = ConfigEnvSchema.parse({
    RESOLUME_HOST: env.RESOLUME_HOST,
    RESOLUME_PORT: env.RESOLUME_PORT,
    RESOLUME_TIMEOUT_MS: env.RESOLUME_TIMEOUT_MS,
  });
  return {
    host: parsed.RESOLUME_HOST,
    port: parsed.RESOLUME_PORT,
    timeoutMs: parsed.RESOLUME_TIMEOUT_MS,
  };
}
