/**
 * CompositionStore — in-memory cache of Resolume composition state.
 *
 * The store owns a long-lived UDP listener (in OWNER mode) that consumes
 * Resolume's OSC OUT broadcast (~325 msg/s) and reduces it into an
 * immutable snapshot tree. REST seeds bootstrap structural shape and
 * recover from drift; per-field TTL gates let read paths fall through to
 * REST when cached data is stale.
 *
 * See `docs/v0.5/01-composition-store.md` for the full design rationale.
 *
 * **Coexistence note**: The OSC OUT port is currently bound exclusively by
 * `resolume_osc_subscribe` calls. When the cache is in OWNER mode, the
 * store also binds it. With cache disabled (default RESOLUME_CACHE=off),
 * nothing binds — old behavior preserved. With cache enabled and
 * `resolume_osc_subscribe` invoked concurrently, the legacy tool's bind
 * will fail with EADDRINUSE — this is an accepted limitation for Sprint B.
 * Phase 5 (next sprint) teaches `osc_subscribe` to multiplex through the
 * store's `collect()` so they can coexist.
 */

import dgram from "node:dgram";
import type { Buffer } from "node:buffer";
import { decodePacket } from "../osc-codec.js";
import type { ReceivedOscMessage, SocketFactory, UdpSocketLike } from "../osc-client.js";
import type { ResolumeRestClient } from "../rest.js";
import { SubscriptionMux } from "./mux.js";
import { applyFullSeed, applyOscMessage, createEmptySnapshot } from "./reducers.js";
import type {
  CachedClip,
  CachedComposition,
  CachedLayer,
  CachedScalar,
  CachedTempo,
  CompositionStoreMode,
  CompositionStoreOptions,
} from "./types.js";
import { ageMs, type TtlField } from "./ttl.js";

const defaultFactory: SocketFactory = () => dgram.createSocket("udp4");

const DEFAULT_HYDRATION_TIMEOUT_MS = 5_000;
const DEFAULT_REHYDRATE_THROTTLE_MS = 500;
const DEFAULT_RECONNECT_INTERVAL_MS = 5_000;

/**
 * Internal counters surfaced by `stats()` for debugging and the upcoming
 * `resolume_cache_status` tool (Phase 5).
 */
interface StoreStats {
  msgsReceived: number;
  rehydrationsTriggered: number;
}

interface StoreConstructorArgs {
  readonly options: CompositionStoreOptions;
  readonly rest: ResolumeRestClient;
  readonly socketFactory?: SocketFactory;
  readonly stderr?: { write: (s: string) => void };
  /**
   * Override Date.now() for deterministic tests. Real callers leave this
   * undefined; the reducers call `Date.now()` directly via their default arg.
   */
  readonly now?: () => number;
}

export type StoreChangeListener = (snapshot: CachedComposition) => void;

export class CompositionStore {
  private readonly options: CompositionStoreOptions;
  private readonly rest: ResolumeRestClient;
  private readonly socketFactory: SocketFactory;
  private readonly stderr: { write: (s: string) => void };
  private readonly mux = new SubscriptionMux();

  private socket: UdpSocketLike | null = null;
  private snapshot: CachedComposition = createEmptySnapshot();
  private listeners: Set<StoreChangeListener> = new Set();

  /** Active reconnect timer (null when not scheduled). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Active drift-debounce timer. */
  private rehydrateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Final operating mode after start() — may differ from options.mode after EADDRINUSE degradation. */
  private effectiveMode: CompositionStoreMode;
  private stats_: StoreStats = { msgsReceived: 0, rehydrationsTriggered: 0 };
  private stopped = false;

  constructor(args: StoreConstructorArgs) {
    this.options = args.options;
    this.rest = args.rest;
    this.socketFactory = args.socketFactory ?? defaultFactory;
    this.stderr = args.stderr ?? { write: (s) => process.stderr.write(s) };
    this.effectiveMode = args.options.mode;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /**
   * Bind the listener (OWNER mode) and run REST seed in parallel.
   *
   * Never throws on hydration failure — the store stays `hydrated=false` and
   * a background reconnect loop retries the REST seed until it succeeds.
   * Reads always fall through to REST when `!hydrated`, so the cache is an
   * opt-in optimization, never a single point of failure.
   */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.options.mode === "off") return;

    if (this.options.mode === "owner") {
      this.tryBindSocket();
    }

    const timeoutMs = this.options.hydrationTimeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS;
    // Race REST seed against the configured timeout. The seed itself never
    // throws — it triggers reconnect on failure and returns false.
    await Promise.race([this.runSeed(), sleep(timeoutMs)]);
  }

  /**
   * Idempotent shutdown: closes the socket, clears all timers. Safe to
   * call multiple times. Wired up to SIGINT/SIGTERM in `index.ts`.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    this.clearRehydrate();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* socket may already be closed */
      }
      this.socket = null;
    }
  }

  // ───────────────────────── snapshot reads ─────────────────────────

  /** Return the latest immutable snapshot. Always non-null. */
  readSnapshot(): CachedComposition {
    return this.snapshot;
  }

  /** Tempo subtree (raw BPM, normalized BPM, min, max). */
  readTempo(): CachedTempo {
    return this.snapshot.tempo;
  }

  /** Returns the cached layer or null when out of range / not yet hydrated. */
  readLayer(layerIndex: number): CachedLayer | null {
    if (layerIndex < 1 || layerIndex > this.snapshot.layerCount) return null;
    return this.snapshot.layers[layerIndex - 1] ?? null;
  }

  /** Returns the cached clip or null when out of range / not yet hydrated. */
  readClip(layerIndex: number, clipIndex: number): CachedClip | null {
    const layer = this.readLayer(layerIndex);
    if (!layer) return null;
    if (clipIndex < 1 || clipIndex > layer.clips.length) return null;
    return layer.clips[clipIndex - 1] ?? null;
  }

  /** Crossfader scalar with provenance. */
  readCrossfader(): CachedScalar<number | null> {
    return this.snapshot.crossfaderPhase;
  }

  /**
   * Per-clip transport position with explicit age + source for tooling.
   * Returns null `value` if never observed; `ageMs` is null in that case too.
   */
  readClipPosition(layer: number, clip: number): {
    value: number | null;
    ageMs: number | null;
    source: CachedScalar<number | null>["source"];
  } {
    const c = this.readClip(layer, clip);
    if (!c) return { value: null, ageMs: null, source: { kind: "unknown" } };
    return {
      value: c.transportPosition.value,
      ageMs: ageMs(c.transportPosition.source),
      source: c.transportPosition.source,
    };
  }

  // ───────────────────────── freshness gates ─────────────────────────

  /**
   * Returns true if the most-recent global observation for the given field
   * is within its TTL. Field-level reads should call this with their own
   * field source to avoid false positives, but tool callers usually only
   * need a coarse check ("is the cache fresh enough to skip a REST round-trip?").
   *
   * For per-field freshness, use the source attached to the read result.
   */
  isFresh(field: TtlField, ageMsOverride?: number): boolean {
    if (typeof ageMsOverride === "number") {
      return ageMsOverride <= this.ttlFor(field);
    }
    if (this.snapshot.lastOscAt === null) return false;
    return Date.now() - this.snapshot.lastOscAt <= this.ttlFor(field);
  }

  isHydrated(): boolean {
    return this.snapshot.hydrated;
  }

  isOscLive(): boolean {
    return this.snapshot.oscLive;
  }

  // ───────────────────────── subscription mux ─────────────────────────

  /** Register a pattern-matched handler for OSC messages. */
  subscribe(pattern: string, handler: (msg: ReceivedOscMessage) => void): () => void {
    return this.mux.subscribe(pattern, handler);
  }

  /** Collect helper that mirrors `subscribeOsc` semantics for the legacy tool. */
  collect(pattern: string, durationMs: number, maxMessages: number): Promise<ReceivedOscMessage[]> {
    return this.mux.collect(pattern, durationMs, maxMessages);
  }

  // ───────────────────────── feed (SHARED mode) ─────────────────────────

  /**
   * Push an externally-collected OSC message into the store. Used in SHARED
   * mode where another tool owns the UDP socket and forwards messages here.
   */
  feed(msg: ReceivedOscMessage): void {
    this.handleMessage(msg);
  }

  // ───────────────────────── manual invalidation ─────────────────────────

  /**
   * Force a full REST re-seed and return its timing.
   *
   * Bumps revision via `applyFullSeed` regardless of whether anything
   * actually changed.
   */
  async refresh(): Promise<{ durationMs: number; revision: number }> {
    const t0 = Date.now();
    await this.runSeed();
    return { durationMs: Date.now() - t0, revision: this.snapshot.revision };
  }

  /**
   * Targeted invalidation — currently a thin shim that schedules a full
   * re-seed. Future work (Phase 5+) may add per-subtree refetches; for now
   * the simplest correct behavior is to refresh the whole composition.
   */
  invalidate(_scope: "all" | { layer: number } | { layer: number; clip: number }): void {
    void _scope;
    this.scheduleRehydrate("invalidate-call");
  }

  // ───────────────────────── reactivity ─────────────────────────

  onChange(listener: StoreChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ───────────────────────── diagnostics ─────────────────────────

  stats(): {
    revision: number;
    hydrated: boolean;
    oscLive: boolean;
    lastOscAt: number | null;
    lastSeedAt: number | null;
    msgsReceived: number;
    rehydrationsTriggered: number;
    mode: CompositionStoreMode;
  } {
    return {
      revision: this.snapshot.revision,
      hydrated: this.snapshot.hydrated,
      oscLive: this.snapshot.oscLive,
      lastOscAt: this.snapshot.lastOscAt,
      lastSeedAt: this.snapshot.lastSeedAt,
      msgsReceived: this.stats_.msgsReceived,
      rehydrationsTriggered: this.stats_.rehydrationsTriggered,
      mode: this.effectiveMode,
    };
  }

  // ───────────────────────── private internals ─────────────────────────

  private ttlFor(field: TtlField): number {
    const o = this.options.ttls;
    if (!o) return ttlDefault(field);
    switch (field) {
      case "transportPosition":
        return o.transportPositionMs ?? ttlDefault(field);
      case "opacity":
      case "bypassed":
      case "solo":
      case "layerPosition":
        return o.layerScalarsMs ?? ttlDefault(field);
      case "bpm":
      case "crossfaderPhase":
        return o.compositionScalarsMs ?? ttlDefault(field);
      case "structural":
        return o.structuralMs ?? ttlDefault(field);
    }
  }

  private tryBindSocket(): void {
    let sock: UdpSocketLike;
    try {
      sock = this.socketFactory();
    } catch (err) {
      this.stderr.write(`[resolume-mcp][store] socket create failed: ${describe(err)}\n`);
      return;
    }
    sock.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException | Error & { code?: string }).code;
      if (code === "EADDRINUSE") {
        // Degrade to SHARED so the user's existing OSC listener keeps working.
        this.effectiveMode = "shared";
        this.stderr.write(
          `[resolume-mcp][store] OSC OUT port ${this.options.oscOutPort} already bound; degrading to SHARED mode.\n`
        );
        try {
          sock.close();
        } catch { /* ignore */ }
        this.socket = null;
        return;
      }
      this.stderr.write(`[resolume-mcp][store] socket error: ${describe(err)}\n`);
    });
    sock.on("message", (buf: Buffer) => this.onSocketBuffer(buf));
    sock.bind(this.options.oscOutPort);
    this.socket = sock;
  }

  private onSocketBuffer(buf: Buffer): void {
    let messages;
    try {
      messages = decodePacket(buf);
    } catch {
      // Malformed packets are silently dropped — same policy as osc-client.ts.
      return;
    }
    const ts = Date.now();
    for (const m of messages) {
      this.handleMessage({ ...m, timestamp: ts });
    }
  }

  private handleMessage(msg: ReceivedOscMessage): void {
    this.stats_.msgsReceived += 1;
    const next = applyOscMessage(this.snapshot, msg, {
      onUnknownAddress: () => {
        // Unknown addresses are usually new Resolume features — debounce a
        // re-seed to keep the cache aligned without thundering REST.
        this.scheduleRehydrate("unknown-address");
      },
      onDriftDetected: () => {
        this.scheduleRehydrate("drift");
      },
    });
    this.commit(next);
    // Fan out the raw message AFTER reducer commit so subscribers can
    // observe a consistent snapshot via readSnapshot() inside their handler.
    this.mux.dispatch(msg);
  }

  private commit(next: CachedComposition): void {
    if (next === this.snapshot) return;
    const prevRevision = this.snapshot.revision;
    this.snapshot = next;
    // Only fire onChange listeners when the revision actually changed.
    // High-frequency no-op writes (e.g. transportPosition replays of the same
    // value, or oscLive/lastOscAt-only updates) replace the snapshot
    // reference but leave revision unchanged, so listeners are NOT awoken.
    if (next.revision === prevRevision) return;
    if (this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch {
          // Same isolation policy as the mux.
        }
      }
    }
  }

  /**
   * REST seed. Never throws. On failure, schedules a reconnect attempt.
   * Returns true on success.
   */
  private async runSeed(): Promise<boolean> {
    if (this.stopped) return false;
    try {
      const tree = await this.rest.get("/composition");
      const next = applyFullSeed(this.snapshot, tree);
      this.commit(next);
      this.clearReconnect();
      return true;
    } catch (err) {
      this.stderr.write(`[resolume-mcp][store] REST seed failed: ${describe(err)}\n`);
      this.scheduleReconnect();
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.stopped) return;
    const base = this.options.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    // Jitter ±20% so multiple instances don't synchronize their retries.
    const jitter = base * 0.2;
    const delay = Math.max(100, Math.floor(base + (Math.random() * 2 - 1) * jitter));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runSeed();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleRehydrate(_reason: string): void {
    if (this.stopped) return;
    if (this.rehydrateTimer) return; // already pending
    const delay = this.options.rehydrateThrottleMs ?? DEFAULT_REHYDRATE_THROTTLE_MS;
    this.stats_.rehydrationsTriggered += 1;
    this.rehydrateTimer = setTimeout(() => {
      this.rehydrateTimer = null;
      void this.runSeed();
    }, delay);
  }

  private clearRehydrate(): void {
    if (this.rehydrateTimer) {
      clearTimeout(this.rehydrateTimer);
      this.rehydrateTimer = null;
    }
  }

  /** Provided for testing — used to verify hydration internals. */
  __testInternals(): {
    hasReconnectTimer: boolean;
    hasRehydrateTimer: boolean;
    socketBound: boolean;
    effectiveMode: CompositionStoreMode;
  } {
    return {
      hasReconnectTimer: this.reconnectTimer !== null,
      hasRehydrateTimer: this.rehydrateTimer !== null,
      socketBound: this.socket !== null,
      effectiveMode: this.effectiveMode,
    };
  }
}

function ttlDefault(field: TtlField): number {
  switch (field) {
    case "transportPosition":
      return 250;
    case "opacity":
    case "bypassed":
    case "solo":
    case "layerPosition":
      return 5_000;
    case "bpm":
    case "crossfaderPhase":
      return 2_000;
    case "structural":
      return 30_000;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
