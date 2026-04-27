# v0.5 Prior Art Survey

> Survey conducted 2026-04-27 for resolume-mcp-server v0.5 architecture decisions.
> Current project state: v0.4.2, 36 tools, REST + WebSocket-less + OSC tri-protocol (no WS client today).

This document evaluates three reference implementations against the five architectural questions
that v0.5 needs to answer:

1. **State management** — cache vs always-fresh fetch
2. **OSC OUT consumption** — listener strategy
3. **Tool/action organization** — flat vs modular
4. **Stability tiers** — alpha/beta/stable distinctions
5. **Effect parameter flow** — direct vs 2-step (GET → discover ID → set)

Repos surveyed:

- [Tortillaguy/resolume-mcp](https://github.com/Tortillaguy/resolume-mcp) — Python, WebSocket, by-id paths, 2 meta-tools
- [drohi-r/resolume-mcp](https://github.com/drohi-r/resolume-mcp) — Python, REST + WS + OSC, 206 flat tools
- [bitfocus/companion-module-resolume-arena](https://github.com/bitfocus/companion-module-resolume-arena) — TypeScript, Companion module, mature & production-tested

---

## 1. Tortillaguy — `resolume_mcp` (Python)

Repo root: `C:/temp/prior-art/tortillaguy/`
Tip commit at survey time: shallow clone of `main`.

### 1.1 State management — WebSocket push, full in-memory cache

`ResolumeAgentClient.state` is the **bare composition object** (no `composition` wrapper —
documented quirk). It is hydrated by a long-lived WS listener task and patched in place on every
incremental update.

- Connection model — `connect()` opens WS, awaits the first full composition message via
  `_state_ready: asyncio.Event`, then returns. Subscriptions are auto-replayed after reconnect.
  See `resolume_mcp/client.py:50-78`.
- Listener — `_listen()` dispatches by message type:
  - Bare body with `columns`+`layers` → full `state` replacement.
  - `path`+`value` (no `type`) → `_apply_incremental_update()` walks the path, patches
    `node["value"]`. `client.py:120-145`, `client.py:188-214`.
  - `parameter_get/set/update/subscribed` → fires registered callbacks + resolves pending ACKs.
    `client.py:147-160`.
  - `sources_update` / `effects_update` / `thumbnail_update` → patch dedicated caches.
    `client.py:162-171`.
- ACK protocol — `send_and_wait()` registers a `Future` keyed by path, sends the command, awaits
  Resolume's echo. Single-flight per path. `client.py:296-320`.
- Reconnect — exponential backoff up to N attempts; resubscribes everything on success.
  `client.py:240-258`.

This is the most sophisticated state strategy of the three. The cache is **always fresh by push**,
not by polling — when there are no changes Resolume sends nothing, when there are changes the
cache reflects them within one round-trip.

**Tax** — paths must be resolved against the cache before they can be used (`_resolve_path_to_id`,
`client.py:326-344`), and the listener task ownership / cancellation is non-trivial (the
`_connected = False` flag in `disconnect()` exists specifically to suppress the reconnect branch
in `_listen()` — `client.py:86-100`).

### 1.2 OSC OUT consumption — none

Tortillaguy has no OSC client at all. Pure WebSocket + a `rest_get()` helper for `/effects` and
`/sources` first-fetch fallback (`client.py:518-527`). All real-time data comes via the WS push
described above.

### 1.3 Tool/action organization — minimal meta-tool registry

Only **4 MCP tools** exposed at the protocol level (`code_server.py:223-390`):

- `search(query)` — introspects the SDK methods + walks composition state for matching paths.
- `execute(code)` — wraps user-supplied Python in `async def _fn(client): ...` and awaits inside
  the existing event loop (`code_server.py:510-521`).
- `behaviors` (subcommand-dispatched) — list/add/remove/enable/disable persistent reactive rules.
- `snapshots` (subcommand-dispatched) — save/load/merge/list/delete/show composition slices.

The "200+ Python methods on `ResolumeAgentClient`" become a single `execute` tool surface.
The agent discovers them via `search()`. Token cost: "~2× schema regardless of API surface size"
(per their CLAUDE.md). All composition control happens by `await client.method(...)` inside
`execute()`.

This is the radical end of the design space — tool count → 4, agent freedom → maximum,
type-safety → zero (the model writes raw Python).

### 1.4 Stability tiers — none

No alpha/beta/stable distinction. No feature flags. Behaviors and snapshots are presented as
peer-tier with `search`/`execute`. The `quickstart` MCP prompt (`code_server.py:48-179`) is the
only "documentation tier" surfaced to the agent.

### 1.5 Effect parameter flow — direct via state cache

Because the WS state cache holds parameter IDs already, effects are addressed directly:

```python
# from client.py:479-508
layer_id = layers[layer_index - 1]["id"]
path = f"/composition/layers/by-id/{layer_id}/effects/video/add"
body = f"effect:///video/{effect_name}"
await self.send_command("post", path, body)
```

For parameter sets they use `set_parameter(path, value)` (`client.py:510-512`). The agent
typically reads `client.state["layers"][i]["video"]["effects"]` to find the effect index,
then sets `/composition/layers/{i}/video/effects/{j}/{collection}/{name}` directly. **One
request per set**, no extra GET.

**Bonus**: `monitor_parameter(param_id, callback)` (`client.py:364-394`) lets behaviors hook
parameter updates without reads.

---

## 2. drohi-r — `resolume_mcp` (Python)

Repo root: `C:/temp/prior-art/drohi/`
Tip commit at survey time: shallow clone of `main`.

### 2.1 State management — none, always fresh

`ResolumeClient` is a stateless dataclass holding only `config` (`src/resolume_mcp/client.py:31-33`).
Every tool call constructs a new `httpx.AsyncClient` for REST and a new `websockets.connect()` for
WS (`client.py:48-119`).

For WS commands, the connect-then-immediate-send pattern is used:

```python
async with websockets.connect(self.config.websocket_url, open_timeout=timeout_s) as websocket:
    bootstrap = await self._drain_websocket_bootstrap(websocket)  # drain initial state msgs
    await websocket.send(json.dumps(payload))
    response: Any = None
    if action not in {"trigger", "reset", "post", "remove"}:
        response = await websocket.recv()
```
Source: `src/resolume_mcp/client.py:89-119`.

This bootstrap drain is wasteful (Resolume sends the entire composition on every WS connection)
but it is also the only way to get the by-id mapping fresh. Drohi accepts the cost.

### 2.2 OSC OUT consumption — none (send-only)

OSC is implemented as fire-and-forget UDP send (`client.py:121-143`). Includes a hand-rolled
encoder (`client.py:146-173`) for `i`/`f`/`s`/`T`/`F` types. **No OSC listener** — OSC is purely
an outbound control surface, equivalent to v0.4's `resolume_osc_send`.

### 2.3 Tool/action organization — single flat 3,269-line file

All **206 tools** live in `src/resolume_mcp/server.py` as `@mcp.tool()`-decorated functions.
Helpers (parameter resolution, scope path construction, payload extraction, polling) are
private functions in the same file. Advanced Output XML logic is the only thing factored out
(`advanced_output_xml.py`, 539 lines).

Categories visible by tool name prefix:

- `rest_*` (5 generic), `websocket_*` (10 generic), `osc_send` (1) — escape hatch
- `*_composition_parameter`, `*_layer_parameter`, `*_clip_parameter` etc. — scoped parameter
  generic accessors (4 actions × ~6 scopes)
- Convenience wrappers — `disconnect_all`, `clear_layer`, `tap_tempo`, `select_clip`, etc.
- Effects — `add_effect`, `remove_effect`, `get_effect`, `move_video_effect`, `rename_effect`
- Advanced Output — read-only XML inspection, atomic-write helpers, screen/slice rename
- `get_capabilities` — returns a self-describing summary of what tools exist

The package ships with a `FastMCP` instance configured at `server.py:494-501` and main entry at
`server.py:3264-3265`.

### 2.4 Stability tiers — informal "experimental" tag in capability notes

No feature-flag mechanism, no separate registries. The `get_capabilities` tool's notes mention:

> "Use the output screen/slice parameter helpers when operating Advanced Output without
> hand-building long paths, **but treat them as experimental until your target Resolume build
> exposes Advanced Output over HTTP**."

Source: `src/resolume_mcp/server.py:3256`. That's it — single English sentence in a help blob.

What drohi does instead is **safety tiers**: 16 destructive operations require
`confirm_destructive=True` and return a structured "requires_confirmation" envelope when not
confirmed. Examples:

- `disconnect_all` — `server.py:703-705`
- `clear_group`, `clear_selected_group` — `server.py:1512-1522`
- `disconnect_clips`, `clear_layers` — `server.py:1775-1803`
- `disconnect_clip`, `disconnect_selected_clip`, `clear_clip`, `clear_selected_clip` —
  `server.py:2322-2398`
- `remove_effect` — `server.py:2882-2898`

This is the same pattern v0.4 uses for `clear_layer.confirm`, applied to ~16× the surface area.

### 2.5 Effect parameter flow — strict 2-step GET → resolve → action

Drohi never assumes a path-to-id mapping. Every parameter action does a fresh REST GET on the
parent scope to find the parameter's numeric `id`, then dispatches a WS by-id action.

The pattern lives in `_resolve_parameter_reference()` (`server.py:200-216`):

```python
async def _resolve_parameter_reference(client, rest_path, parameter_suffix, aliases=()):
    rest_payload = await client.request("GET", rest_path)
    resolved = _lookup_parameter_node(rest_payload, parameter_suffix, aliases=aliases)
    node = resolved["node"]
    return {
        "rest_path": rest_path,
        "resolved_suffix": resolved["suffix"],
        "parameter_id": node["id"],
        "parameter_path": _parameter_path_from_id(node["id"]),
        ...
    }
```

`_parameter_action()` (`server.py:219-240`) chains this with a WS action and returns a
fully-traced response (request + response + parameter node).

For effects specifically, scope resolution is uniform across composition / layer / group /
selected-layer / selected-group / clip / selected-clip via `_effect_scope_path()`
(`server.py:130-152`). Effect indices are 1-based and validated by re-fetching the scope's
effects list (`_extract_effect_from_scope_payload`, `server.py:155-174`).

**Cost** — every parameter set is min 2 round-trips: 1 REST GET + 1 WS connect/send.
**Benefit** — zero state desync, every call is provably fresh.

---

## 3. Bitfocus Companion module — `companion-module-resolume-arena` (TypeScript)

Repo root: `C:/temp/prior-art/companion/`
Manifest version: `3.13.0-beta.2` (see `companion/manifest.json:6`).

This is the most production-mature of the three — multiple maintainers, integration test suite,
husky pre-commit hooks, separate vitest config for sequential integration tests against a live
Resolume Arena.

### 3.1 State management — hybrid (WebSocket cache + OSC cache + statemanjs reactive store)

Two parallel state systems coexist:

**A. WebSocket-driven `compositionState` + `parameterStates`** (`src/state.ts`):

```typescript
import {createState} from '@persevie/statemanjs';
import {Composition, ParameterCollection} from './domain/api';

export const compositionState = createState<Composition | undefined>(undefined);
export const parameterStates = createState<ParameterCollection>({});
```

Both are reactive stores subscribed to by feedback functions across the codebase. The WS
listener (`src/websocket.ts:77-136`) populates them:

- Bare body with `columns`+`layers` → `compositionState.set(message)`.
- Bare body with `path` (no type) → `parameterStates.update(state => state[path] = parameter)`.
- `parameter_update` / `parameter_subscribed` → both keys: full path AND `/parameter/by-id/{id}`
  duplicate (`src/websocket.ts:124-129`). Smart move — lets feedbacks subscribe by either name.
- `effects_update` / `thumbnail_update` → broadcast to subscribers; thumbnail update is
  intentionally NOT applied (commented-out, lines 107-118).

Reconnect is implemented as `maybeReconnect()` with a 5-second timer (`websocket.ts:36-44`).

**B. OSC-driven `OscState` map** (`src/osc-state.ts:48-73`):

A `Map<number, LayerState>` keyed by layer index, holding `master`, `opacity`, `volume`,
`bypassed`, `direction`, `layerPosition`, plus per-clip transport position/duration/name and a
duration estimation engine. Updated only from OSC messages by an explicit message dispatcher.

Why two systems? Because **Resolume's WebSocket transport position resolution is poor** but its
OSC OUT firehose pushes positions every frame (~325 msg/s per v0.4 CLAUDE.md). For "what time
is each clip currently at?" the OSC stream is the only reliable answer. The Companion module
uses OSC for transport telemetry and WS for the rest.

OSC dispatch routes by regex (`osc-state.ts:81-150`):

- `/composition/layers/{n}/position` → layer source-of-truth (which clip is currently outputting)
- `/composition/layers/{n}/clips/{m}/transport/position` → clip playhead, **filtered** by layer
  position match within `0.0001` tolerance to ignore preview clips.
- Detects clip change when `activeClip != 0 && activeClip != column` — invalidates duration
  cache, schedules a "quick refresh" REST GET for clip metadata (`osc-state.ts:110-126`).

This is the most realistic state model for a live VJ tool. It explicitly acknowledges that
**different signals come from different transports** and routes accordingly.

### 3.2 OSC OUT consumption — continuous listener, dedicated UDP port

`ArenaOscListener` (`src/osc-listener.ts:36-116`) is the canonical example.

- Binds `0.0.0.0:{oscRxPort}` via the `osc` npm package's `UDPPort`.
- Is **always running** when `config.useOscListener && config.oscRxPort` is set
  (`src/index.ts:178-182`).
- Forwards every message to `instance.handleOscInput(address, value, args)` which dispatches
  into `OscState`.
- Critically, the listener also **sends** OSC from its own bound port: `send()` method
  (`osc-listener.ts:100-115`). Resolume's `?` query responses are addressed back to the sender's
  port, so query+listen must share one socket. v0.4 has the same constraint — `osc-client.ts`
  doesn't share, hence query is one-shot.
- Periodic refresh — `OscState.startPeriodicRefresh()` is called alongside listener start
  (`src/index.ts:181`). This is a slow REST poll for things OSC doesn't push (clip names,
  durations, column states).

EADDRINUSE is detected and logged but does not panic the module
(`osc-listener.ts:60-64`).

### 3.3 Tool/action organization — per-domain module trees

Tools (here called "actions") are organized as a tree:

```
src/actions/
├── clip/      ├── column/    ├── composition/   ├── deck/
├── effect/    ├── layer/     ├── layer-group/   └── osc-transport/
```

Each domain has a top-level `xxxActions.ts` that returns a `CompanionActionDefinitions` object,
plus a sibling `actions/` folder with one `.ts` file per action. The aggregator
(`src/actions.ts:12-26`) merges all 8 domains:

```typescript
export function getActions(instance: ResolumeArenaModuleInstance): CompanionActionDefinitions {
    return {
        ...getClipActions(instance),
        ...getColumnActions(instance),
        ...getCompositionActions(instance),
        ...getDeckActions(instance),
        ...getEffectActions(instance),
        ...getLayerActions(instance),
        ...getLayerGroupActions(instance),
        ...getOscTransportActions(instance),
    };
}
```

Mirroring directories exist for `feedbacks/`, `variables/`, `presets/`, and a separate
`domain/` tree for shared business logic per area (e.g. `domain/effects/effect-utils.ts`).
Effect actions specifically are scope-explicit:

```typescript
// src/actions/effect/effectActions.ts:7-19
return {
    effectBypassLayer:        effectBypass(instance, 'layer'),
    effectBypassClip:         effectBypass(instance, 'clip'),
    effectBypassClipList:     effectBypass(instance, 'clip', true),
    effectBypassGroup:        effectBypass(instance, 'layergroup'),
    effectBypassComposition:  effectBypass(instance, 'composition'),
    effectParameterSetLayer:  effectParameterSet(instance, 'layer'),
    // ... etc
};
```

The same factory function is bound at registration time with the scope as a closure parameter.
Result: 1 implementation file × 5 scope-specific tool IDs.

### 3.4 Stability tiers — version-flagged at module level only

Manifest declares `version: 3.13.0-beta.2`, but **inside the codebase there is no per-tool
flag**. The whole module ships at one stability tier. The README declares a `TEST_PLAN.md`
(23kB) and integration tests under `vitest.integration.config.ts` enforce sequential execution
because OSC port binding requires it.

Quality gating happens via:

- Husky pre-commit (`.husky/`)
- Two vitest configs (`vitest.config.ts` for unit, `vitest.integration.config.ts` for live-
  Resolume integration)
- CI workflow under `.github/`

No alpha/beta/stable per-action tagging.

### 3.5 Effect parameter flow — direct via cached state, with by-id preference

The Companion module reads from `compositionState` (which holds the full parameter tree
including IDs) and prefers the by-id WS path:

```typescript
// src/actions/effect/actions/effect-parameter-set.ts:99-114
const param = eu.getEffectParam(scope, location, effectIdx, collection, paramName);
if (param?.id === undefined) {
    instance.log('warn', `effectParameterSet: param '${paramName}' not found in composition state`);
    return;
}
const paramId = param.id;
const paramKey = '/parameter/by-id/' + paramId;
// ...
ws.setParam(String(paramId), coerceValue(rawValue));
```

`getEffectParam()` (`src/domain/effects/effect-utils.ts:348-360`) walks the cached composition:

```typescript
getEffectParam(scope, location, effectIdx, collection, paramName) {
    const effects = this.getEffectsArray(scope, location);
    if (!effects) return undefined;
    const eff = effects[effectIdx - 1];
    if (!eff) return undefined;
    return (eff[collection] as ParameterCollection | undefined)?.[paramName];
}
```

Note: `effectIdx - 1` confirms 1-based external interface, 0-based internal indexing.

**Modes supported**: `set`, `increase`, `decrease`, `toggle` (lines 110-128). Increase/decrease
do an optimistic local cache write so chained presses don't snap back to the stale
`compositionState` value:

```typescript
parameterStates.set({...parameterStates.get(), [paramKey]: {path: paramKey, value: next} as any});
```

This is a small but important detail: button-press throttling on a real VJ interface needs to
be additive without round-tripping. The optimistic write makes that work.

For bypass, `resolveBypassKey()` (`effect-utils.ts:390-394`) prefers by-id but falls back to
path when the bypass param ID is absent (clip effects, where the WS message format omits IDs).

**Cost** — 1 round-trip per set, no extra GET. **Tax** — depends on `compositionState` being
fresh, which the WS subscription model maintains.

---

## What to borrow for v0.5

### A. **OSC listener strategy from Companion (`osc-listener.ts:36-116`)**

A single always-on UDP socket that does **both** receive and send. v0.4's per-call socket
construction is incompatible with `?` queries (Resolume responds to the sender's bound port).
A long-lived listener also enables push-based playhead tracking (`325 msg/s` cited in v0.4
CLAUDE.md) which is the killer feature that REST cannot provide.

Suggested module: `src/resolume/osc-listener.ts` mirroring the Companion structure, plus an
`OscState`-style domain object (e.g. `src/resolume/osc-state.ts`) keyed by layer index. Use
the **layer-position-tolerance filter** (`osc-state.ts:99-107`) to discard preview-clip
positions — that's a non-obvious gotcha worth porting verbatim.

### B. **Per-domain action modules from Companion (`src/actions/{domain}/`)**

v0.4 already does this loosely (`src/tools/composition`, `src/tools/clip`, etc.). v0.5 should
extend the pattern with **per-scope factory binding** for effects so the 5× repetition of
"composition / layer / group / clip / selected" doesn't get hand-coded. This is the
`effectBypass(instance, 'layer')` pattern from `effectActions.ts:7-19`.

### C. **Drohi's `confirm_destructive` blanket policy (16 ops gated)**

v0.4 has it on `clear_layer` only. v0.5 should generalize: any tool whose name contains
`clear_`, `disconnect_`, `remove_`, `delete_` should default to a `requires_confirmation`
return when called without `confirm: true`. Drohi's pattern returns a structured envelope
with `action`, `requires_confirmation: true`, and a human-readable `message`. The agent
sees a clear retry path — that's exactly the "LLM self-repairable error" model from v0.4
CLAUDE.md `§設計原則 2`.

### D. **Tortillaguy's `monitor_parameter(id, callback)` for behaviors** *(optional, advanced)*

If v0.5 wants to add reactive behaviors (parameter X crosses threshold → trigger Y), the
callback registry pattern (`client.py:364-394`) is the cleanest way. Combined with the
WebSocket parameter_update message, it gives push-based reactions without polling. This is
significantly more complex than current v0.4 — only worth it if reactive behavior is on the
roadmap.

### E. **WebSocket cache for parameter ID resolution (Companion `compositionState`)**

v0.4 stays REST-only. For effect parameter flow specifically, a lightweight cached snapshot
of the composition (refreshed on a WS `composition` message OR a periodic REST GET) avoids
drohi's "1 GET + 1 WS = every set takes 2 round-trips" tax. The minimum viable form is
**not** statemanjs reactivity — just a singleton holder object updated by the WS listener,
and a `getEffectParam(scope, location, effectIdx, collection, paramName)` helper. Companion's
`effect-utils.ts:348-360` shows how lean this can be.

---

## What to avoid for v0.5

### F. **Tortillaguy's `execute(code)` arbitrary-Python pattern**

The agent gets full code execution against a live socket. Reasons to skip:

- **No type safety** — schema is a free-form string `code`. The model writes whatever it
  thinks works; mistakes leak into Resolume.
- **Hard to test** — the surface is "any valid Python the model emits", which can't be
  enumerated, unit tested, or rate limited.
- **Error messages are runtime-only** — no compile-time check that a method exists, no
  validation of `client.state` shape; failure modes are stack traces, not actionable hints.
- **Skill catalog rule (`CLAUDE.md §Skill maintenance`)** — v0.4 enforces 1:1 sync between
  `src/tools/index.ts` and `skills/resolume-mcp-tester/SKILL.md`. A meta-tool defeats this.

The token-cost argument is real but **v0.4's 36 tools are still under 5kB of schema**, so
the savings don't justify the safety loss.

### G. **Drohi's 3,269-line single-file flat registry**

`server.py` is unmaintainable at this scale. v0.4 already follows the per-domain split
(`src/tools/{composition,clip,layer,osc}/`); stay there. Drohi's lesson is **don't grow
a single file past 800 lines** — that aligns with the 800-line max from
`~/.claude/rules/common/coding-style.md`.

### H. **Drohi's "every parameter action GETs the parent first" round-trip cost**

For v0.4's REST-only architecture this is unavoidable when the path-to-id map isn't cached
locally. v0.5 should fix this by caching the composition (Borrow E) rather than accepting
2× round-trips per set. This matters most for fader-style continuous control: opacity sweeps
at 60fps are 120 round-trips per second under drohi's model vs. 60 under cached.

### I. **Companion's `compositionState` mutation-via-`statemanjs`**

Skipping the dependency. The reactive store is overkill for an MCP server (no UI subscribing
to changes — the only reader is the next tool call). A plain mutable singleton + a Zod parse
on every read is cheaper and aligns with v0.4's existing `client.ts` facade. Keep the
**concept** (a single source-of-truth cached object), drop the library.

### J. **Tortillaguy's no-error-context dispatch**

`code_server.py:406-407` returns `f"Error: {type(e).__name__}: {e}"` for all failures. v0.4's
`ResolumeError` tagged union with `kind`+`hint` is strictly better — keep it.

### K. **Stability-tier-as-prose** *(applies to all three)*

None of the three repos surface tool stability programmatically. v0.5 should consider going
slightly further than the prior art here:

- Annotate tools with a `stability: 'stable' | 'beta' | 'experimental'` field in
  `ToolDefinition` (`src/tools/types.ts`).
- Prefix beta tool names with no marker (transparency to the agent), but include the tier in
  the description.
- Optionally allow opt-out via env (`RESOLUME_MCP_HIDE_BETA=1`) so production deployments can
  scope the surface without code changes.

This isn't borrowed from any prior art — it's a **gap** in the prior art that v0.5 can fill.

---

## Quick comparison matrix

| Question | Tortillaguy | drohi-r | Companion |
|----------|-------------|---------|-----------|
| **State cache?** | Full WS push, in-memory tree | None — always fresh | Hybrid: WS for tree + OSC for transport |
| **OSC OUT listener?** | None | None (send-only) | Continuous UDP, shared send/recv socket |
| **Tool count** | 4 (meta) | 206 (flat) | ~80 actions across 8 domains |
| **File org** | 6 files, ~1500 LOC | 1 file, 3269 LOC | Per-domain trees, ~5000 LOC |
| **Confirm-destructive** | None | 16 ops gated | None (Companion has button-press model) |
| **Stability tiers** | None | Prose only | Module-level beta tag only |
| **Effect set flow** | Direct via cached state | 2-step (REST GET → WS by-id) | Direct via cached state, by-id preferred |
| **Production maturity** | Low (single author) | Medium (active) | High (multiple maintainers, integration tests) |
| **Most distinctive idea** | `execute()` meta-tool | Generic `rest_*`/`websocket_*` escape hatches | Parallel WS-tree + OSC-transport state |

---

## Direct citations to specific files

- Tortillaguy WS listener and incremental update: `C:/temp/prior-art/tortillaguy/resolume_mcp/client.py:106-214`
- Tortillaguy meta-tool registry: `C:/temp/prior-art/tortillaguy/resolume_mcp/code_server.py:223-390`
- Tortillaguy `monitor_parameter`: `C:/temp/prior-art/tortillaguy/resolume_mcp/client.py:364-394`
- drohi `_resolve_parameter_reference`: `C:/temp/prior-art/drohi/src/resolume_mcp/server.py:200-240`
- drohi confirm-destructive guard sites: `server.py:703, 1512, 1520, 1775, 1801, 2322, 2344, 2366, 2398, 2882`
- drohi WS bootstrap drain: `C:/temp/prior-art/drohi/src/resolume_mcp/client.py:35-46`
- Companion OSC listener (send + recv same socket): `C:/temp/prior-art/companion/src/osc-listener.ts:36-116`
- Companion OSC state with layer-position filter: `C:/temp/prior-art/companion/src/osc-state.ts:81-150`
- Companion WS message dispatch: `C:/temp/prior-art/companion/src/websocket.ts:77-136`
- Companion per-domain action aggregator: `C:/temp/prior-art/companion/src/actions.ts:12-26`
- Companion scope-binding factory: `C:/temp/prior-art/companion/src/actions/effect/effectActions.ts:7-19`
- Companion `getEffectParam` cache lookup: `C:/temp/prior-art/companion/src/domain/effects/effect-utils.ts:348-360`
- Companion `effect-parameter-set` modes (set/inc/dec/toggle): `C:/temp/prior-art/companion/src/actions/effect/actions/effect-parameter-set.ts:84-135`
- Companion manifest version: `C:/temp/prior-art/companion/companion/manifest.json:6`
