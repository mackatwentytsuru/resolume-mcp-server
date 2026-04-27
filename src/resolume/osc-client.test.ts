import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  sendOsc,
  queryOsc,
  subscribeOsc,
  probeOscStatus,
  type UdpSocketLike,
} from "./osc-client.js";
import { encodeMessage } from "./osc-codec.js";

interface FakeSocket extends UdpSocketLike {
  bound: number | null;
  sent: Array<{ host: string; port: number; msg: Buffer }>;
  emitMessage: (msg: Buffer) => void;
  emitError: (err: Error) => void;
  closed: boolean;
}

function createFakeSocket(opts: { autoListen?: boolean; failSend?: Error } = {}): FakeSocket {
  const listeners: {
    message: Array<(msg: Buffer) => void>;
    error: Array<(err: Error) => void>;
    listening: Array<() => void>;
  } = { message: [], error: [], listening: [] };

  const sock: FakeSocket = {
    bound: null,
    sent: [],
    closed: false,
    on(event: string, listener: any) {
      if (event === "message") listeners.message.push(listener);
      else if (event === "error") listeners.error.push(listener);
      else if (event === "listening") listeners.listening.push(listener);
    },
    bind(port: number) {
      this.bound = port;
      if (opts.autoListen !== false) {
        // Fire listening on next tick so callers can attach handlers first.
        setImmediate(() => listeners.listening.forEach((fn) => fn()));
      }
    },
    send(msg, port, host, cb) {
      this.sent.push({ host, port, msg });
      if (opts.failSend) {
        setImmediate(() => cb(opts.failSend!));
      } else {
        setImmediate(() => cb(null));
      }
    },
    close(cb) {
      this.closed = true;
      cb?.();
    },
    emitMessage(msg) {
      listeners.message.forEach((fn) => fn(msg));
    },
    emitError(err) {
      listeners.error.forEach((fn) => fn(err));
    },
  };
  return sock;
}

describe("sendOsc", () => {
  it("encodes and sends a single packet, then closes the socket", async () => {
    const sock = createFakeSocket();
    await sendOsc("127.0.0.1", 7000, "/foo", [1, "x"], () => sock);
    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].host).toBe("127.0.0.1");
    expect(sock.sent[0].port).toBe(7000);
    expect(sock.closed).toBe(true);
  });

  it("rejects when send callback returns an error", async () => {
    const err = new Error("EHOSTUNREACH");
    const sock = createFakeSocket({ failSend: err });
    await expect(
      sendOsc("127.0.0.1", 7000, "/foo", [], () => sock)
    ).rejects.toThrow(/EHOSTUNREACH/);
    expect(sock.closed).toBe(true);
  });

  it("rejects on socket error event", async () => {
    const sock = createFakeSocket();
    const p = sendOsc("127.0.0.1", 7000, "/foo", [], () => sock);
    sock.emitError(new Error("boom"));
    await expect(p).rejects.toThrow(/boom/);
  });
});

describe("queryOsc", () => {
  it("sends query on listening, collects matching messages, closes on timeout", async () => {
    const sock = createFakeSocket();
    const p = queryOsc("127.0.0.1", 7000, 7001, "/composition/master", 100, () => sock);
    // Wait a tick for bind/listening to fire and the query to be sent.
    await new Promise((r) => setImmediate(r));
    expect(sock.sent).toHaveLength(1);
    // Simulate Resolume reply
    sock.emitMessage(encodeMessage("/composition/master", [0.5]));
    // Also a non-matching reply that should be filtered out
    sock.emitMessage(encodeMessage("/something/else", [1]));
    const result = await p;
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("/composition/master");
    expect(result[0].args[0]).toBeCloseTo(0.5, 5);
    expect(sock.closed).toBe(true);
  });

  it("matches wildcard queries against multiple addresses", async () => {
    const sock = createFakeSocket();
    const p = queryOsc(
      "127.0.0.1",
      7000,
      7001,
      "/composition/layers/*/name",
      100,
      () => sock
    );
    await new Promise((r) => setImmediate(r));
    sock.emitMessage(encodeMessage("/composition/layers/1/name", ["A"]));
    sock.emitMessage(encodeMessage("/composition/layers/2/name", ["B"]));
    sock.emitMessage(encodeMessage("/composition/decks/1/name", ["NotMe"]));
    const result = await p;
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.args[0])).toEqual(["A", "B"]);
  });

  it("returns empty array when no replies received within timeout", async () => {
    const sock = createFakeSocket();
    const result = await queryOsc("127.0.0.1", 7000, 7001, "/x", 50, () => sock);
    expect(result).toEqual([]);
    expect(sock.closed).toBe(true);
  });

  it("rejects on socket error during listen", async () => {
    const sock = createFakeSocket();
    const p = queryOsc("127.0.0.1", 7000, 7001, "/x", 200, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitError(new Error("EADDRINUSE"));
    await expect(p).rejects.toThrow(/EADDRINUSE/);
  });

  it("ignores malformed packets", async () => {
    const sock = createFakeSocket();
    const p = queryOsc("127.0.0.1", 7000, 7001, "/x", 80, () => sock);
    await new Promise((r) => setImmediate(r));
    // Force decoder failure with a malformed buffer
    sock.emitMessage(Buffer.from([0xff])); // No null terminator → returns []
    const result = await p;
    expect(result).toEqual([]);
  });

  it("rejects when the underlying send fails on the query packet", async () => {
    const sock = createFakeSocket({ failSend: new Error("ENETUNREACH") });
    const p = queryOsc("127.0.0.1", 7000, 7001, "/x", 200, () => sock);
    await expect(p).rejects.toThrow(/ENETUNREACH/);
  });
  it("filters non-matching messages at receive time (buffer never holds non-matching)", async () => {
    const sock = createFakeSocket();
    const p = queryOsc("127.0.0.1", 7000, 7001, "/match/*", 200, () => sock);
    await new Promise((r) => setImmediate(r));
    // Send 95 non-matching + 5 matching messages
    for (let i = 0; i < 95; i++) {
      sock.emitMessage(encodeMessage("/other/path", [i]));
    }
    for (let i = 0; i < 5; i++) {
      sock.emitMessage(encodeMessage("/match/" + i, [i]));
    }
    const result = await p;
    // Only the 5 matching messages should appear.
    expect(result).toHaveLength(5);
    expect(result.every((m) => m.address.startsWith("/match/"))).toBe(true);
  
});});

describe("subscribeOsc", () => {
  it("collects messages matching the pattern and stops at maxMessages", async () => {
    const sock = createFakeSocket();
    const p = subscribeOsc(7001, "/foo/*", 500, 2, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitMessage(encodeMessage("/foo/a", [1]));
    sock.emitMessage(encodeMessage("/bar/x", [9])); // filtered
    sock.emitMessage(encodeMessage("/foo/b", [2]));
    // Should resolve early at 2 matches
    const result = await p;
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.address)).toEqual(["/foo/a", "/foo/b"]);
    expect(sock.closed).toBe(true);
  });

  it("returns whatever was collected when duration elapses", async () => {
    const sock = createFakeSocket();
    const p = subscribeOsc(7001, "/x/*", 60, 100, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitMessage(encodeMessage("/x/1", [1]));
    const result = await p;
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBeGreaterThan(0);
  });

  it("rejects on socket error", async () => {
    const sock = createFakeSocket();
    const p = subscribeOsc(7001, "/*", 200, 50, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitError(new Error("EACCES"));
    await expect(p).rejects.toThrow(/EACCES/);
  });

  it("ignores malformed packets and continues collecting", async () => {
    const sock = createFakeSocket();
    const p = subscribeOsc(7001, "/m/*", 80, 10, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitMessage(Buffer.from([0xff])); // bad
    sock.emitMessage(encodeMessage("/m/ok", [1]));
    const result = await p;
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe("/m/ok");
  });
});

describe("probeOscStatus", () => {
  it("reports reachable=true on first message received", async () => {
    const sock = createFakeSocket();
    const p = probeOscStatus(7001, 200, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitMessage(encodeMessage("/heartbeat", [1]));
    const status = await p;
    expect(status.reachable).toBe(true);
    expect(status.lastReceived).not.toBeNull();
  });

  it("reports reachable=false on grace timeout", async () => {
    const sock = createFakeSocket();
    const status = await probeOscStatus(7001, 50, () => sock);
    expect(status.reachable).toBe(false);
    expect(status.lastReceived).toBeNull();
  });

  it("reports reachable=false on socket error", async () => {
    const sock = createFakeSocket();
    const p = probeOscStatus(7001, 200, () => sock);
    await new Promise((r) => setImmediate(r));
    sock.emitError(new Error("EADDRINUSE"));
    const status = await p;
    expect(status.reachable).toBe(false);
  });
  it("reports reachable=false when only non-OSC UDP traffic arrives", async () => {
    const sock = createFakeSocket();
    const p = probeOscStatus(7001, 60, () => sock);
    await new Promise((r) => setImmediate(r));
    // Random bytes that are not a valid OSC packet.
    sock.emitMessage(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const status = await p;
    expect(status.reachable).toBe(false);
    expect(status.lastReceived).toBeNull();
  
});});
