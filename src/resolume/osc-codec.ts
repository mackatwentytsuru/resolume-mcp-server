/**
 * Minimal OSC 1.0 encoder/decoder. Hand-rolled (no external deps).
 *
 * Resolume speaks OSC 1.0 with the standard `,` type-tag string and 4-byte
 * alignment. We support the four atomic types we actually need to talk to it:
 *
 *   i — int32          (BE)
 *   f — float32        (BE)
 *   s — null-terminated string, padded to 4-byte boundary
 *   T/F — boolean (no payload)
 *
 * Bundles (`#bundle`) are decoded by flattening their elements into a list
 * of {address, args} messages. Bundles are not produced on the encode path —
 * Resolume accepts plain messages.
 */

import { Buffer } from "node:buffer";

export type OscScalar = number | string | boolean;

export interface OscMessage {
  address: string;
  args: OscScalar[];
}

const BUNDLE_PREFIX = "#bundle";

/**
 * Encode a single OSC message. Argument types are inferred from JS values:
 *   number  → integer if Number.isInteger(v) within int32 range, else float32
 *   string  → 's'
 *   boolean → 'T' or 'F'
 *
 * If you need a float for an integer-valued number (e.g. `1.0`), pass it as a
 * non-integer literal (e.g. `1.0001`) or extend this function with an explicit
 * type-tag override. For Resolume's read-only "?" query convention, just pass
 * the address and `["?"]` as args.
 */
export function encodeMessage(address: string, args: ReadonlyArray<OscScalar>): Buffer {
  if (typeof address !== "string" || address.length === 0 || address[0] !== "/") {
    throw new TypeError(
      `OSC address must start with "/" (got ${JSON.stringify(address)})`
    );
  }
  let tags = ",";
  const argBufs: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "number") {
      if (Number.isInteger(a) && a >= -0x80000000 && a <= 0x7fffffff) {
        tags += "i";
        argBufs.push(oscInt32(a));
      } else {
        tags += "f";
        argBufs.push(oscFloat32(a));
      }
    } else if (typeof a === "string") {
      tags += "s";
      argBufs.push(oscString(a));
    } else if (typeof a === "boolean") {
      tags += a ? "T" : "F";
      // No payload for T/F.
    } else {
      throw new TypeError(
        `Unsupported OSC arg type: ${typeof a} (only number/string/boolean)`
      );
    }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...argBufs]);
}

/**
 * Decode a UDP datagram into one or more {address, args} messages.
 * Bundles are flattened. Unknown type tags abort the message gracefully.
 */
export function decodePacket(buf: Buffer): OscMessage[] {
  if (buf.length === 0) return [];
  if (
    buf.length >= 8 &&
    buf.slice(0, BUNDLE_PREFIX.length).toString("utf8") === BUNDLE_PREFIX
  ) {
    return decodeBundle(buf);
  }
  const msg = decodeMessage(buf);
  return msg ? [msg] : [];
}

function decodeBundle(buf: Buffer): OscMessage[] {
  // Layout: "#bundle\0" (8 bytes) + 8-byte timetag + repeated (size:int32, payload:bytes).
  const out: OscMessage[] = [];
  let p = 16;
  while (p + 4 <= buf.length) {
    const sz = buf.readUInt32BE(p);
    p += 4;
    if (sz <= 0 || p + sz > buf.length) break;
    const elt = buf.slice(p, p + sz);
    p += sz;
    if (
      elt.length >= 8 &&
      elt.slice(0, BUNDLE_PREFIX.length).toString("utf8") === BUNDLE_PREFIX
    ) {
      // Nested bundle (rare but legal).
      out.push(...decodeBundle(elt));
    } else {
      const msg = decodeMessage(elt);
      if (msg) out.push(msg);
    }
  }
  return out;
}

function decodeMessage(buf: Buffer): OscMessage | null {
  let p = 0;
  const addrEnd = buf.indexOf(0, p);
  if (addrEnd === -1) return null;
  const address = buf.slice(p, addrEnd).toString("utf8");
  p = align4(addrEnd + 1);
  if (p > buf.length) return { address, args: [] };
  const tagsEnd = buf.indexOf(0, p);
  if (tagsEnd === -1) return { address, args: [] };
  const tags = buf.slice(p, tagsEnd).toString("utf8");
  p = align4(tagsEnd + 1);
  const args: OscScalar[] = [];
  if (tags.length === 0 || tags[0] !== ",") return { address, args };
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i];
    if (t === "i") {
      if (p + 4 > buf.length) break;
      args.push(buf.readInt32BE(p));
      p += 4;
    } else if (t === "f") {
      if (p + 4 > buf.length) break;
      args.push(buf.readFloatBE(p));
      p += 4;
    } else if (t === "s") {
      const e = buf.indexOf(0, p);
      if (e === -1) break;
      args.push(buf.slice(p, e).toString("utf8"));
      p = align4(e + 1);
    } else if (t === "T") {
      args.push(true);
    } else if (t === "F") {
      args.push(false);
    } else if (t === "N" || t === "I") {
      // OSC 1.0 marker types with no payload — represent as null-ish boolean false.
      args.push(false);
    } else {
      // Unknown tag — abort cleanly.
      break;
    }
  }
  return { address, args };
}

/** Glob-match an OSC address against a pattern with `*` wildcards (no `?`/`[]`). */
export function matchOscPattern(pattern: string, address: string): boolean {
  if (pattern === address) return true;
  if (!pattern.includes("*")) return false;
  // Compile pattern: escape regex metacharacters except `*` → `[^/]*` (segment-bound).
  const segments = pattern.split("*");
  const escaped = segments
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(address);
}

// ───────────────────── helpers ─────────────────────

function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

function padTo4(buf: Buffer): Buffer {
  // OSC strings are null-terminated AND padded to 4-byte alignment.
  // The total length must be a multiple of 4 with at least one trailing null.
  const totalLen = align4(buf.length + 1);
  const out = Buffer.alloc(totalLen);
  buf.copy(out, 0);
  // Remaining bytes are already zero-filled by Buffer.alloc.
  return out;
}

function oscString(s: string): Buffer {
  return padTo4(Buffer.from(s, "utf8"));
}

function oscInt32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

function oscFloat32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatBE(n, 0);
  return b;
}
