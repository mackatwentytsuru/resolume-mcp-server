/**
 * Tagged union of all errors raised by the Resolume client and tools.
 * Designed so an LLM can recover without a human round-trip: every variant
 * carries a hint string telling Claude what to do next.
 */
export type ResolumeError =
  | { kind: "ResolumeNotRunning"; hint: string }
  | { kind: "InvalidIndex"; what: "layer" | "column" | "clip" | "deck"; index: number; hint: string }
  | { kind: "InvalidValue"; field: string; value: unknown; hint: string }
  | { kind: "NotFound"; path: string; hint: string }
  | { kind: "BadRequest"; path: string; message: string; hint: string }
  | { kind: "Timeout"; path: string; hint: string }
  | { kind: "Unknown"; message: string; hint: string };

export class ResolumeApiError extends Error {
  constructor(public readonly detail: ResolumeError) {
    super(formatMessage(detail));
    this.name = "ResolumeApiError";
  }
}

function formatMessage(d: ResolumeError): string {
  switch (d.kind) {
    case "ResolumeNotRunning":
      return `Resolume not reachable. ${d.hint}`;
    case "InvalidIndex":
      return `Invalid ${d.what} index ${d.index}. ${d.hint}`;
    case "InvalidValue":
      return `Invalid value for ${d.field}: ${String(d.value)}. ${d.hint}`;
    case "NotFound":
      return `Not found: ${d.path}. ${d.hint}`;
    case "BadRequest":
      return `Bad request to ${d.path}: ${d.message}. ${d.hint}`;
    case "Timeout":
      return `Timed out calling ${d.path}. ${d.hint}`;
    case "Unknown":
      return `Resolume error: ${d.message}. ${d.hint}`;
  }
}

/** Map a thrown value (fetch error, HTTP response, etc.) to a structured error. */
export function mapHttpError(path: string, status: number, body: string): ResolumeApiError {
  if (status === 404) {
    return new ResolumeApiError({
      kind: "NotFound",
      path,
      hint: "The path or index does not exist. Call resolume_get_composition to see the current structure.",
    });
  }
  if (status === 400 || status === 422) {
    return new ResolumeApiError({
      kind: "BadRequest",
      path,
      message: body,
      hint: "Check parameter ranges. Some values must be 0..1, layer indices are 1-based.",
    });
  }
  return new ResolumeApiError({
    kind: "Unknown",
    message: `HTTP ${status}: ${body}`,
    hint: "Verify Resolume version and that the Web Server is enabled in Preferences.",
  });
}

export function mapNetworkError(path: string, err: unknown): ResolumeApiError {
  const msg = err instanceof Error ? err.message : String(err);
  // Node fetch raises ECONNREFUSED via `cause.code` on a TypeError. Match either.
  const isRefused = /ECONNREFUSED|fetch failed|connect/i.test(msg);
  if (isRefused) {
    return new ResolumeApiError({
      kind: "ResolumeNotRunning",
      hint: "Launch Resolume Arena/Avenue and enable the Webserver in Preferences > Webserver.",
    });
  }
  if (/abort|timeout/i.test(msg)) {
    return new ResolumeApiError({
      kind: "Timeout",
      path,
      hint: "The Resolume Web Server did not respond in time. The composition may be very large or the host overloaded.",
    });
  }
  return new ResolumeApiError({
    kind: "Unknown",
    message: msg,
    hint: "Network error while contacting Resolume.",
  });
}
