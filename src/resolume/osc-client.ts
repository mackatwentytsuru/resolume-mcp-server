/**
 * Stateless OSC client for Resolume.
 *
 * Three operations:
 *   - sendOsc(host, port, address, args)
 *       Fire-and-forget UDP send.
 *
 *   - queryOsc(host, inPort, outPort, address, timeoutMs)
 *       Send `address` with no args (Resolume's "?" query convention also
 *       supported by passing args=["?"]) and listen briefly on `outPort` for
 *       the echoed reply. Returns matched messages.
 *
 *   - subscribeOsc(outPort, pattern, durationMs, maxMessages)
 *       Listen on `outPort` for a fixed duration; collect messages whose
 *       address matches the glob pattern; stop early at maxMessages.
 *
 * UDP socket lifecycle is fully managed: each call creates its own socket
 * and closes it before resolving. No persistent listener is kept — that's
 * an explicit design choice so the MCP process never accidentally holds
 * a port across tool calls (matters when the user has another OSC tool
 * already bound to 7001).
 *
 * The socket factory is injectable so tests can mock UDP without real
 * network I/O. The default factory uses node:dgram.
 */

import dgram from "node:dgram";
import type { Buffer } from "node:buffer";
import {
  decodePacket,
  encodeMessage,
  matchOscPattern,
  type OscMessage,
  type OscScalar,
} from "./osc-codec.js";

// Minimal interface we need from a dgram-like socket. Letting the codebase
// inject this means tests don't have to mock node:dgram itself.
export interface UdpSocketLike {
  on(event: "message", listener: (msg: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "listening", listener: () => void): void;
  bind(port: number): void;
  send(
    msg: Buffer,
    port: number,
    host: string,
    cb: (err: Error | null) => void
  ): void;
  close(cb?: () => void): void;
}

export type SocketFactory = () => UdpSocketLike;

const defaultFactory: SocketFactory = () => dgram.createSocket("udp4");

export interface ReceivedOscMessage extends OscMessage {
  /** Wall-clock timestamp (ms since epoch) the message was received. */
  timestamp: number;
}

/**
 * Send a one-shot OSC message. Resolves once the UDP datagram has been
 * handed to the kernel (no application-level ack — UDP is fire-and-forget).
 */
export async function sendOsc(
  host: string,
  port: number,
  address: string,
  args: ReadonlyArray<OscScalar>,
  factory: SocketFactory = defaultFactory
): Promise<void> {
  const pkt = encodeMessage(address, args);
  const sock = factory();
  return new Promise<void>((resolve, reject) => {
    sock.on("error", (err) => {
      try { sock.close(); } catch { /* ignore */ }
      reject(err);
    });
    sock.send(pkt, port, host, (err) => {
      try { sock.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Send an OSC query and listen briefly for the reply on `outPort`.
 *
 * Resolume's read-only convention: send the target address with a single
 * string arg `"?"`, and Resolume echoes back the current value(s) on the
 * configured OSC OUT port. If the address contains `*` wildcards, multiple
 * replies may arrive — they are all collected and returned.
 */
export async function queryOsc(
  host: string,
  inPort: number,
  outPort: number,
  address: string,
  timeoutMs: number,
  factory: SocketFactory = defaultFactory
): Promise<ReceivedOscMessage[]> {
  const sock = factory();
  const collected: ReceivedOscMessage[] = [];
  return new Promise<ReceivedOscMessage[]>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve(collected.filter((m) => matchOscPattern(address, m.address)));
    };
    const timer = setTimeout(finish, Math.max(50, timeoutMs));
    sock.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      reject(err);
    });
    sock.on("message", (msg) => {
      const ts = Date.now();
      try {
        for (const m of decodePacket(msg)) {
          collected.push({ ...m, timestamp: ts });
        }
      } catch {
        // Malformed packets are ignored.
      }
    });
    sock.on("listening", () => {
      // Send the query once we're actually bound.
      const pkt = encodeMessage(address, ["?"]);
      sock.send(pkt, inPort, host, (err) => {
        if (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { sock.close(); } catch { /* ignore */ }
          reject(err);
        }
      });
    });
    sock.bind(outPort);
  });
}

/**
 * Listen on `outPort` for `durationMs` and collect messages whose address
 * matches `pattern`. Stops early when `maxMessages` are collected.
 *
 * IMPORTANT: This binds `outPort` exclusively. If Resolume's OSC OUT is
 * already targeting another receiver on the same machine, the bind will
 * fail with EADDRINUSE.
 */
export async function subscribeOsc(
  outPort: number,
  pattern: string,
  durationMs: number,
  maxMessages: number,
  factory: SocketFactory = defaultFactory
): Promise<ReceivedOscMessage[]> {
  const sock = factory();
  const collected: ReceivedOscMessage[] = [];
  return new Promise<ReceivedOscMessage[]>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* ignore */ }
      resolve(collected);
    };
    const timer = setTimeout(finish, Math.max(50, durationMs));
    sock.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* ignore */ }
      reject(err);
    });
    sock.on("message", (msg) => {
      const ts = Date.now();
      try {
        for (const m of decodePacket(msg)) {
          if (!matchOscPattern(pattern, m.address)) continue;
          collected.push({ ...m, timestamp: ts });
          if (collected.length >= maxMessages) {
            clearTimeout(timer);
            finish();
            return;
          }
        }
      } catch {
        // Malformed packets are ignored.
      }
    });
    sock.bind(outPort);
  });
}

/**
 * Probe whether OSC out (Resolume → us) is reachable by listening briefly.
 * "Reachable" means we received at least one well-formed packet within the
 * grace window. If Resolume isn't broadcasting on `outPort`, we report not
 * reachable. The probe also returns the configured ports so the caller can
 * surface the env config.
 */
export async function probeOscStatus(
  outPort: number,
  graceMs: number,
  factory: SocketFactory = defaultFactory
): Promise<{ reachable: boolean; lastReceived: number | null }> {
  const sock = factory();
  return new Promise<{ reachable: boolean; lastReceived: number | null }>(
    (resolve) => {
      let settled = false;
      let lastReceived: number | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        try { sock.close(); } catch { /* ignore */ }
        resolve({ reachable: lastReceived !== null, lastReceived });
      };
      const timer = setTimeout(finish, Math.max(50, graceMs));
      sock.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sock.close(); } catch { /* ignore */ }
        resolve({ reachable: false, lastReceived: null });
      });
      sock.on("message", () => {
        lastReceived = Date.now();
        clearTimeout(timer);
        finish();
      });
      sock.bind(outPort);
    }
  );
}
