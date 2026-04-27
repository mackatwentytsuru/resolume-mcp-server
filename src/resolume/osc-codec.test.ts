import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  encodeMessage,
  decodePacket,
  matchOscPattern,
} from "./osc-codec.js";

describe("OSC codec", () => {
  describe("encodeMessage", () => {
    it("encodes int args using ',i' tag", () => {
      const buf = encodeMessage("/foo", [42]);
      // Bytes: "/foo\0\0\0\0,i\0\0" + int32(42 BE)
      expect(buf.length % 4).toBe(0);
      const decoded = decodePacket(buf);
      expect(decoded).toEqual([{ address: "/foo", args: [42] }]);
    });

    it("encodes float args (non-integer numbers) using ',f' tag", () => {
      const buf = encodeMessage("/x", [1.5]);
      const [m] = decodePacket(buf);
      expect(m.address).toBe("/x");
      expect(m.args.length).toBe(1);
      expect(m.args[0]).toBeCloseTo(1.5, 5);
    });

    it("encodes strings", () => {
      const buf = encodeMessage("/composition/master", ["?"]);
      const [m] = decodePacket(buf);
      expect(m).toEqual({ address: "/composition/master", args: ["?"] });
    });

    it("encodes booleans as T/F (no payload)", () => {
      const buf = encodeMessage("/flag", [true, false]);
      const [m] = decodePacket(buf);
      expect(m).toEqual({ address: "/flag", args: [true, false] });
    });

    it("encodes mixed args round-trip", () => {
      const buf = encodeMessage("/m", [1, "two", 3.25, false]);
      const [m] = decodePacket(buf);
      expect(m.address).toBe("/m");
      expect(m.args[0]).toBe(1);
      expect(m.args[1]).toBe("two");
      expect(m.args[2]).toBeCloseTo(3.25, 5);
      expect(m.args[3]).toBe(false);
    });

    it("handles empty args list", () => {
      const buf = encodeMessage("/ping", []);
      const [m] = decodePacket(buf);
      expect(m).toEqual({ address: "/ping", args: [] });
    });

    it("rejects addresses that do not start with '/'", () => {
      expect(() => encodeMessage("foo", [1])).toThrow(/start with/);
    });

    it("rejects empty addresses", () => {
      expect(() => encodeMessage("", [1])).toThrow();
    });

    it("rejects unsupported arg types", () => {
      // @ts-expect-error intentional bad input for runtime guard
      expect(() => encodeMessage("/x", [{}])).toThrow(/Unsupported/);
    });

    it("aligns string padding to 4-byte boundary with terminating null", () => {
      // "/abc" is 4 bytes — needs at least one null + pad to 8 total
      const buf = encodeMessage("/abc", []);
      // address(8) + tags(",\0\0\0" 4) = 12
      expect(buf.length).toBe(12);
      expect(buf.length % 4).toBe(0);
    });

    it("encodes large integers as int32 within range, float beyond", () => {
      const huge = 1e12; // beyond int32 range → falls back to float32
      const buf = encodeMessage("/big", [huge]);
      const [m] = decodePacket(buf);
      // float32 precision is ~7 decimal digits; allow ~1 part in 1e6 deviation
      const arg = m.args[0] as number;
      expect(typeof arg).toBe("number");
      expect(Math.abs(arg - huge) / huge).toBeLessThan(1e-5);
    });
  });

  describe("decodePacket", () => {
    it("returns empty list for empty buffer", () => {
      expect(decodePacket(Buffer.alloc(0))).toEqual([]);
    });

    it("decodes #bundle with two messages", () => {
      const m1 = encodeMessage("/a", [1]);
      const m2 = encodeMessage("/b", ["x"]);
      const bundle = buildBundle([m1, m2]);
      const out = decodePacket(bundle);
      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({ address: "/a", args: [1] });
      expect(out[1]).toEqual({ address: "/b", args: ["x"] });
    });

    it("decodes nested bundles", () => {
      const inner = buildBundle([encodeMessage("/inner", [7])]);
      const outer = buildBundle([inner]);
      const out = decodePacket(outer);
      expect(out).toEqual([{ address: "/inner", args: [7] }]);
    });

    it("ignores unknown type tags by stopping cleanly", () => {
      // Build a message with an exotic 'h' (int64) we don't support.
      const addr = oscString("/x");
      const tags = oscString(",h"); // unknown
      const payload = Buffer.alloc(8); // bogus int64
      const buf = Buffer.concat([addr, tags, payload]);
      const [m] = decodePacket(buf);
      expect(m.address).toBe("/x");
      expect(m.args).toEqual([]);
    });

    it("returns null-skip behavior on malformed (no null terminator) packets", () => {
      const bad = Buffer.from([0x2f, 0x61, 0x62, 0x63]); // "/abc" with no terminator
      expect(decodePacket(bad)).toEqual([]);
    });

    it("handles N (null) and I (impulse) markers as boolean false", () => {
      const buf = Buffer.concat([
        oscString("/m"),
        oscString(",NI"),
      ]);
      const [m] = decodePacket(buf);
      expect(m.args).toEqual([false, false]);
    });
  });

  describe("matchOscPattern", () => {
    it("matches exact addresses", () => {
      expect(matchOscPattern("/composition/master", "/composition/master")).toBe(true);
      expect(matchOscPattern("/foo", "/bar")).toBe(false);
    });

    it("matches single-segment wildcard", () => {
      expect(matchOscPattern("/composition/layers/*/name", "/composition/layers/3/name")).toBe(true);
      // Wildcards do not cross '/' segments
      expect(matchOscPattern("/composition/layers/*/name", "/composition/layers/3/clips/1/name")).toBe(false);
    });

    it("escapes regex metacharacters in non-wildcard portions", () => {
      // '.' should be literal
      expect(matchOscPattern("/a.b", "/a.b")).toBe(true);
      expect(matchOscPattern("/a.b", "/aXb")).toBe(false);
    });

    it("returns false for patterns that do not contain wildcards and don't match", () => {
      expect(matchOscPattern("/foo", "/foo/bar")).toBe(false);
    });

    it("matches multi-wildcard patterns", () => {
      expect(
        matchOscPattern(
          "/composition/layers/*/clips/*/name",
          "/composition/layers/2/clips/5/name"
        )
      ).toBe(true);
    });
  });
});

// ───── helpers ─────

function oscString(s: string): Buffer {
  // duplicates internal helper for test purposes
  const raw = Buffer.from(s, "utf8");
  const totalLen = Math.ceil((raw.length + 1) / 4) * 4;
  const out = Buffer.alloc(totalLen);
  raw.copy(out, 0);
  return out;
}

function buildBundle(messages: Buffer[]): Buffer {
  const head = oscString("#bundle");
  const timetag = Buffer.alloc(8); // immediate
  const elts: Buffer[] = [];
  for (const m of messages) {
    const sz = Buffer.alloc(4);
    sz.writeUInt32BE(m.length, 0);
    elts.push(sz, m);
  }
  return Buffer.concat([head, timetag, ...elts]);
}
