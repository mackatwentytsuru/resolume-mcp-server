import { mapHttpError, mapNetworkError, ResolumeApiError } from "../errors/types.js";

export interface RestClientConfig {
  /** Base URL e.g. http://localhost:8080 (no trailing slash, no /api/v1). */
  baseUrl: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
  /** Maximum binary response size in bytes (default 10 MB). */
  maxBinaryBytes?: number;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_BINARY_BYTES = 10 * 1024 * 1024;

/**
 * Thin typed wrapper around the Resolume REST API. All paths are appended to
 * `${baseUrl}/api/v1`. Errors are normalized to `ResolumeApiError` with
 * structured detail, so tools can present recovery hints to the LLM.
 *
 * The client is intentionally schema-free — callers (tools/services) decide
 * what to validate. This keeps the client small and avoids coupling to a
 * specific Resolume version's parameter tree.
 */
export class ResolumeRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxBinaryBytes: number;

  constructor(private readonly config: RestClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxBinaryBytes = config.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES;
  }

  get baseApi(): string {
    return `${this.config.baseUrl}/api/v1`;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  /**
   * POST a plain-text body. Resolume's effect-add endpoint
   * (`/composition/.../effects/{kind}/add`) requires the body to be a raw URI
   * string like `effect:///video/Blur` with `Content-Type: text/plain`. JSON
   * encoding of the same string is silently rejected with a 204 no-op.
   */
  async postText<T = unknown>(path: string, text: string): Promise<T> {
    return this.request<T>("POST", path, text, { contentType: "text/plain" });
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /** GET a binary resource (e.g. clip thumbnail) and return base64-encoded data. */
  async getBinary(path: string): Promise<{ base64: string; mediaType: string }> {
    const url = this.url(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) {
        const text = await safeText(res);
        throw mapHttpError(path, res.status, text);
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > this.maxBinaryBytes) {
        throw new ResolumeApiError({
          kind: "Unknown",
          message: `Binary response too large: ${declared} bytes (limit ${this.maxBinaryBytes}).`,
          hint: "Increase RestClientConfig.maxBinaryBytes if this is expected, or fetch a smaller resource.",
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > this.maxBinaryBytes) {
        throw new ResolumeApiError({
          kind: "Unknown",
          message: `Binary response exceeded size limit during read: ${buf.byteLength} bytes.`,
          hint: "Increase RestClientConfig.maxBinaryBytes or fetch a smaller resource.",
        });
      }
      const mediaType = res.headers.get("content-type") ?? "application/octet-stream";
      return { base64: buf.toString("base64"), mediaType };
    } catch (err) {
      if (err instanceof ResolumeApiError) throw err;
      throw mapNetworkError(path, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private url(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${this.baseApi}${normalized}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { contentType?: string }
  ): Promise<T> {
    const url = this.url(path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
    try {
      const isText = opts?.contentType === "text/plain";
      const headers: Record<string, string> | undefined =
        body !== undefined
          ? { "content-type": opts?.contentType ?? "application/json" }
          : undefined;
      const encodedBody: BodyInit | undefined =
        body === undefined
          ? undefined
          : isText
            ? String(body)
            : JSON.stringify(body);
      const init: RequestInit = {
        method,
        signal: ctrl.signal,
        headers,
        body: encodedBody,
      };
      const res = await this.fetchImpl(url, init);
      if (!res.ok) {
        const text = await safeText(res);
        throw mapHttpError(path, res.status, text);
      }
      // Empty 204 / 200 with no body is common for PUT.
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        const text = await safeText(res);
        // PUT/POST often return empty bodies. Empty + non-JSON is a normal "ack" — return undefined.
        if (text.length === 0) return undefined as T;
        // Anything else is a protocol violation — Resolume should always return JSON for data endpoints.
        throw new ResolumeApiError({
          kind: "Unknown",
          message: `Unexpected non-JSON response from ${path} (content-type: ${ct || "<missing>"}).`,
          hint: "Verify Resolume version and that the Web Server is enabled. The endpoint may not exist on this Resolume build.",
        });
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ResolumeApiError) throw err;
      throw mapNetworkError(path, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<body unreadable>";
  }
}
