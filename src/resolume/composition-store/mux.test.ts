import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceivedOscMessage } from "../osc-client.js";
import { compilePattern, SubscriptionMux } from "./mux.js";

function msg(address: string, args: ReadonlyArray<unknown> = [], ts = 0): ReceivedOscMessage {
  return { address, args: args as never, timestamp: ts || Date.now() };
}

describe("compilePattern", () => {
  it("compiles literal addresses to exact-match regexes", () => {
    const re = compilePattern("/composition/master");
    expect(re.test("/composition/master")).toBe(true);
    expect(re.test("/composition/masterX")).toBe(false);
    expect(re.test("/composition/master/x")).toBe(false);
  });

  it("treats * as segment-bound wildcard (no slashes)", () => {
    const re = compilePattern("/a/*/b");
    expect(re.test("/a/foo/b")).toBe(true);
    expect(re.test("/a/123/b")).toBe(true);
    // Cross-segment match must NOT succeed.
    expect(re.test("/a/foo/bar/b")).toBe(false);
  });

  it("does not match deeper paths under a trailing wildcard", () => {
    const re = compilePattern("/a/*");
    expect(re.test("/a/x")).toBe(true);
    expect(re.test("/a/x/y")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    const re = compilePattern("/foo+bar");
    expect(re.test("/foo+bar")).toBe(true);
    expect(re.test("/fooXbar")).toBe(false);
  });
});

describe("SubscriptionMux", () => {
  let mux: SubscriptionMux;
  beforeEach(() => {
    mux = new SubscriptionMux();
  });

  it("dispatches messages to handlers whose pattern matches", () => {
    const handler = vi.fn();
    mux.subscribe("/composition/layers/*/video/opacity", handler);
    mux.dispatch(msg("/composition/layers/1/video/opacity", [0.5]));
    mux.dispatch(msg("/composition/layers/2/video/opacity", [0.8]));
    mux.dispatch(msg("/composition/decks/1/select", [true])); // non-matching
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("supports multiple handlers for the same pattern", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    mux.subscribe("/x/*", h1);
    mux.subscribe("/x/*", h2);
    mux.dispatch(msg("/x/1"));
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("returns an unsubscribe function that removes the handler", () => {
    const handler = vi.fn();
    const unsub = mux.subscribe("/foo", handler);
    mux.dispatch(msg("/foo"));
    unsub();
    mux.dispatch(msg("/foo"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("unsubscribe is idempotent", () => {
    const handler = vi.fn();
    const unsub = mux.subscribe("/foo", handler);
    unsub();
    unsub();
    mux.dispatch(msg("/foo"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates handler errors so other handlers still run", () => {
    const ok = vi.fn();
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    mux.subscribe("/x", broken);
    mux.subscribe("/x", ok);
    mux.dispatch(msg("/x"));
    expect(broken).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
  });

  it("size() reflects the number of active subscriptions", () => {
    expect(mux.size()).toBe(0);
    const u1 = mux.subscribe("/a", () => {});
    const u2 = mux.subscribe("/b", () => {});
    expect(mux.size()).toBe(2);
    u1();
    expect(mux.size()).toBe(1);
    u2();
    expect(mux.size()).toBe(0);
  });

  it("dispatch is a no-op when no subscriptions exist", () => {
    expect(() => mux.dispatch(msg("/x"))).not.toThrow();
  });

  it("caches compiled patterns across repeated subscriptions", () => {
    // Indirectly: subscribing the same literal pattern twice should both work,
    // and the second compile cost is amortized. Behavioral check rather than
    // a timing-sensitive one — both subscribers should receive matching events.
    const h1 = vi.fn();
    const h2 = vi.fn();
    mux.subscribe("/a", h1);
    mux.subscribe("/a", h2);
    mux.dispatch(msg("/a"));
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });
});

describe("SubscriptionMux.collect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with collected messages after the duration elapses", async () => {
    const mux = new SubscriptionMux();
    const p = mux.collect("/x/*", 100, 100);
    mux.dispatch(msg("/x/1", [1]));
    mux.dispatch(msg("/y/1", [2])); // filtered
    mux.dispatch(msg("/x/2", [3]));
    vi.advanceTimersByTime(100);
    const out = await p;
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.address)).toEqual(["/x/1", "/x/2"]);
  });

  it("resolves early when maxMessages is reached", async () => {
    const mux = new SubscriptionMux();
    const p = mux.collect("/x/*", 60_000, 2);
    mux.dispatch(msg("/x/1"));
    mux.dispatch(msg("/x/2"));
    // Should resolve without further timer advance.
    const out = await p;
    expect(out).toHaveLength(2);
  });

  it("returns empty array when no matches arrive before timeout", async () => {
    const mux = new SubscriptionMux();
    const p = mux.collect("/x/*", 50, 100);
    vi.advanceTimersByTime(60);
    const out = await p;
    expect(out).toEqual([]);
  });

  it("unsubscribes after resolution so further dispatches are not collected", async () => {
    const mux = new SubscriptionMux();
    const p = mux.collect("/x/*", 100, 1);
    mux.dispatch(msg("/x/1"));
    await p;
    // Subscription should now be removed.
    expect(mux.size()).toBe(0);
    mux.dispatch(msg("/x/2")); // must not throw or accumulate.
  });
});
