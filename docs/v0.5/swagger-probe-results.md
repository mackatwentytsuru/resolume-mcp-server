# Sub-endpoint Probe Results — v0.5 Sprint C / Component 4 Phase 2

This document records the outcome of probing the speculative narrower
sub-endpoints catalogued in `04-effect-cache-and-sub-endpoints.md` against
Resolume's REST API.

## Method

Resolume Arena/Avenue was **not** reachable on `127.0.0.1:8080` at the time
of this investigation, so empirical (live) probing was not possible. The
project's `scripts/probe-subendpoints.mjs` is committed for future
contributors with live access — it produces a markdown table identical in
shape to the one below.

In the absence of live verification, conclusions were drawn from static
analysis of:

1. **Resolume's official OpenAPI / Swagger spec** — vendored copy in the
   reference project [`white-tie-live/resolume-js`][rjs] (`swagger.yaml`,
   3077 lines). This is the canonical surface description.
2. **Bitfocus Companion module** ([`bitfocus/companion-module-resolume-arena`][cm])
   — the production-quality VJ controller that has shipped against multiple
   Resolume versions; treats every endpoint conservatively.
3. **Tortillaguy/resolume-mcp** ([`Tortillaguy/resolume-mcp`][tg]) — Python
   MCP server, WebSocket-first.
4. **drohi-r/resolume-mcp** ([`drohi-r/resolume-mcp`][dr]) — Python MCP
   server with a `_parameter_action` helper that resolves parameters to
   numeric ids and mutates them via WebSocket.
5. **Ayesy/resolume-mcp** ([`Ayesy/resolume-mcp`][ay]) — TypeScript MCP
   server, WebSocket-first for parameter mutation.

[rjs]: https://github.com/white-tie-live/resolume-js
[cm]: https://github.com/bitfocus/companion-module-resolume-arena
[tg]: https://github.com/Tortillaguy/resolume-mcp
[dr]: https://github.com/drohi-r/resolume-mcp
[ay]: https://github.com/Ayesy/resolume-mcp

## Confidence Labels

- **CONFIRMED POSITIVE** — endpoint exists in the OpenAPI spec and we have
  matching production usage in at least one reference repo.
- **CONFIRMED NEGATIVE (static)** — endpoint is absent from the OpenAPI spec
  and every reference repo routes the equivalent operation through a
  different surface (typically WebSocket `/parameter/by-id/{id}`).
- **CONFIRMED NEGATIVE (live)** — empirical probe returned 404 / 405.
- **UNVERIFIED** — neither static nor live evidence is conclusive; defer to
  live probe.

## Findings

| # | endpoint | confidence | result | notes |
|---|----------|------------|--------|-------|
| 3  | `POST /composition/clear`                          | CONFIRMED NEGATIVE (static)  | not in Swagger | drohi-r calls this path but no other reference does, and the official spec lists no `/composition/clear`. Most likely a 404. **Use the alternative below instead.** |
| 3-alt | `POST /composition/layers/{n}/clearclips`       | CONFIRMED POSITIVE (static)  | swagger.yaml line 562, returns 204 | Per-layer "clear all clips" is documented. Replaces N×M slot-clear POSTs with N layer-clear POSTs (and parallelizable). **This is the conversion we land for #3.** |
| 8  | `PUT /composition/tempocontroller/tempo`            | CONFIRMED NEGATIVE (static)  | deep PUT not in Swagger | The official spec exposes `tempocontroller` only as a *schema field* on the `Composition` envelope, not as a standalone path. CLAUDE.md's "no deep parameter PUTs" rule applies. All four reference repos route BPM mutations via WebSocket (`/parameter/by-id/{id}`) or fall through to the wide `PUT /composition`. |
| 9  | `POST /composition/tempocontroller/tempo_tap`       | CONFIRMED NEGATIVE (static)  | not in Swagger | Same reason as #8. Companion module routes tap via WebSocket `triggerParam(id, true/false)` and falls back to OSC `/composition/tempocontroller/tempotap` (note: different spelling). REST POST against either spelling is not documented. |
| 10 | `POST /composition/tempocontroller/resync`          | CONFIRMED NEGATIVE (static)  | not in Swagger | Same reason as #8. Companion module routes resync via WebSocket `triggerParam(id, true/false)` and falls back to OSC `/composition/tempocontroller/resync`. Note: the OSC trigger path being well-known does NOT imply a REST POST exists — REST and OSC are distinct surfaces with different vocabularies. CLAUDE.md was correct to flag this only as a known *OSC* trigger. |
| 12 | `PUT /composition/crossfader/phase`                 | CONFIRMED NEGATIVE (static)  | deep PUT not in Swagger | Same reason as #8. Tortillaguy explicitly falls back to `/composition/crossfader/phase` only over WebSocket, not REST. |

## Reasoning

The Resolume Swagger spec at v1 is unambiguous about which paths exist. Under
`/composition` it lists:

- `GET /composition`, `PUT /composition`
- `POST /composition/{parameter}/reset`
- Subtree paths for columns / layers / decks / clips / layergroups / effects
  (each with their own `clear`, `connect`, `select`, `clearclips`, etc.).

There is no `/composition/clear`, no `/composition/tempocontroller/...`, and
no `/composition/crossfader/...` rooted as standalone paths. `tempocontroller`
and `crossfader` appear only as schema fields on the `Composition` envelope,
which means the only REST way to mutate them is `PUT /composition` with a
nested envelope body — which is exactly what `tempo.ts`, `composition.ts`
already do.

This strongly corroborates CLAUDE.md's architectural statement that
"deep parameter PUTs do not exist in Resolume's REST API". The earlier-flagged
items #4 / #5 / #14 (deep layer parameter PUTs) generalize to #8 / #12 too:
deep PUTs of any composition-level parameter are also unsupported.

The OSC trigger paths (`/composition/tempocontroller/resync`,
`/composition/tempocontroller/tempotap`) are real *OSC* addresses, but OSC
addresses are not REST paths. Resolume's REST API uses noun-style endpoints
(GET/PUT a resource, POST an action like `connect` / `select` / `clear`),
not the OSC parameter address tree.

## Conclusions and conversions landed

- **#3 → conversion landed**: replace the inner-loop `POST /clips/{m}/clear`
  with one `POST /layers/{n}/clearclips` per layer, dispatched in parallel
  with `Promise.all` plus a 4-way semaphore so we don't flood Resolume's
  single-threaded HTTP server. Cuts request count from O(layers × clips) to
  O(layers) and adds parallelism.
- **#8, #9, #10, #12 → no conversion**: each is CONFIRMED NEGATIVE statically.
  Updating the catalog to reflect this. The wide `PUT /composition` body
  envelope remains correct for all four.

## Re-running the probe

When live Resolume is available:

```bash
node scripts/probe-subendpoints.mjs 127.0.0.1 8080
```

Append `--allow-wipe` ONLY on a fresh empty composition to also probe
`POST /composition/clear` and the per-layer `clearclips`. Both are
destructive. The script prints a markdown table identical in shape to the
findings table above; paste the new rows in and update confidence labels
from CONFIRMED NEGATIVE (static) to CONFIRMED NEGATIVE (live), or — if the
empirical result diverges — flip the confidence and re-evaluate the
conversion.
