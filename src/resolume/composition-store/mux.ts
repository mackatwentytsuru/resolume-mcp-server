/**
 * Subscription multiplexer for OSC OUT messages.
 *
 * Multiple consumers (the cache reducers, the legacy `resolume_osc_subscribe`
 * tool, future `onChange` listeners) need to register pattern-matched handlers
 * against the single OSC OUT stream the store owns. `SubscriptionMux` is a
 * tiny pub/sub that compiles each pattern's regex once and dispatches matched
 * messages to the registered handlers.
 *
 * Pattern semantics match `osc-codec.ts#matchOscPattern` (segment-bound `*`
 * wildcards per OSC 1.0). We compile our own regexes here rather than calling
 * `matchOscPattern` per dispatch because the store fans out to potentially
 * thousands of messages per second; the compile-once regex is ~10x faster.
 */

import type { ReceivedOscMessage } from "../osc-client.js";

export type OscHandler = (msg: ReceivedOscMessage) => void;

interface Subscription {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly handler: OscHandler;
}

/**
 * Compile an OSC address pattern with `*` wildcards into a RegExp.
 *
 * `*` matches any run of characters that does NOT include `/` — i.e. matches
 * are bound to a single OSC address segment (OSC 1.0 spec).
 */
export function compilePattern(pattern: string): RegExp {
  // Escape regex metacharacters EXCEPT `*`, then replace `*` with `[^/]*`.
  const escaped = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

export class SubscriptionMux {
  private readonly subscriptions = new Set<Subscription>();
  /**
   * Cache of compiled patterns to avoid recompiling when the same pattern is
   * subscribed many times (e.g. multiple `collect()` calls during a session).
   */
  private readonly patternCache = new Map<string, RegExp>();

  /**
   * Register a handler for messages whose address matches `pattern`.
   * Returns an unsubscribe function. The unsubscribe is idempotent.
   */
  subscribe(pattern: string, handler: OscHandler): () => void {
    const regex = this.getCompiledPattern(pattern);
    const sub: Subscription = { pattern, regex, handler };
    this.subscriptions.add(sub);
    return () => {
      this.subscriptions.delete(sub);
    };
  }

  /**
   * Dispatch a single message to every handler whose pattern matches.
   *
   * Handlers are isolated from each other — a thrown error in one handler
   * does not prevent the others from running. Errors are swallowed silently
   * because the dispatch path is hot and there is no LLM-facing context to
   * surface them to. Tests that need to observe handler errors can use
   * subscribe with an explicit try/catch.
   */
  dispatch(msg: ReceivedOscMessage): void {
    if (this.subscriptions.size === 0) return;
    for (const sub of this.subscriptions) {
      if (!sub.regex.test(msg.address)) continue;
      try {
        sub.handler(msg);
      } catch {
        // Isolate handler failures.
      }
    }
  }

  /**
   * Collect messages matching `pattern` for up to `durationMs`, stopping
   * early when `maxMessages` is reached. Mirrors `subscribeOsc` semantics
   * but multiplexes through this mux instead of binding its own UDP socket.
   *
   * The returned promise never rejects — it always resolves with whatever
   * was collected. This matches the design's "never throw on hydration
   * failure" principle.
   */
  collect(
    pattern: string,
    durationMs: number,
    maxMessages: number
  ): Promise<ReceivedOscMessage[]> {
    return new Promise((resolve) => {
      const collected: ReceivedOscMessage[] = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(collected);
      };
      const unsubscribe = this.subscribe(pattern, (msg) => {
        if (settled) return;
        collected.push(msg);
        if (collected.length >= maxMessages) finish();
      });
      const timer = setTimeout(finish, Math.max(0, durationMs));
    });
  }

  /** Diagnostic — number of active subscriptions. */
  size(): number {
    return this.subscriptions.size;
  }

  private getCompiledPattern(pattern: string): RegExp {
    let re = this.patternCache.get(pattern);
    if (!re) {
      re = compilePattern(pattern);
      this.patternCache.set(pattern, re);
    }
    return re;
  }
}
