# Examples

Standalone Node scripts that demonstrate what the Resolume MCP server is built to enable. Each script is a working tool *and* a reference implementation you can copy into your own project.

These scripts intentionally use only Node built-ins (`dgram`, `node:buffer`, `fetch`) plus the project's own compiled OSC codec at `build/resolume/osc-codec.js`. No extra npm dependencies. They are designed to be readable from top to bottom.

## Prerequisites

1. **Resolume Arena/Avenue running** at the host/port you'll pass to the script (default `100.74.26.128:8080`; common local default is `127.0.0.1:8080`).
2. **Web Server enabled** — `Preferences > Web Server > Enable Webserver & REST API`.
3. **OSC enabled** — `Preferences > OSC > OSC Input` *and* `OSC Output` both ticked. The script listens on Resolume's OSC OUT port (default 7001) for the playhead push and sends to OSC IN (7000).
4. **Project built** — these scripts import from `build/resolume/osc-codec.js`. Run `npm run build` once.
5. **Audio playing on Layer 1, visual on Layer 2** with the default Transform effect attached. (Resolume gives every layer a Transform by default, so this just means "trigger something on each layer".)

## Scripts

### `osc-realtime-vj.mjs` — OSC-driven realtime VJ demo

Treats Layer 1's audio playhead (broadcast over OSC at ~30..60 Hz on `/composition/layers/1/clips/N/transport/position`) as the master clock and drives Layer 2 effects through four phases of a song:

| Progress | Phase | What happens |
|---|---|---|
| 0..25% | A | Subtle Transform Scale pulse on each beat (100 ↔ 110) |
| 25..50% | B | Adds a Hue Rotate effect, sweeps it once per bar |
| 50..75% | C | Bigger Z-rotation + blend mode switches to Add |
| 75..100% | D | Cooldown — opacity fade, blend back to Alpha |

#### Run it

```bash
# Default: hits 100.74.26.128 (the maintainer's tailnet)
node examples/osc-realtime-vj.mjs

# Or with explicit endpoints (REST base, OSC host, OSC IN, OSC OUT)
node examples/osc-realtime-vj.mjs http://127.0.0.1:8080 127.0.0.1 7000 7001
```

#### What it modifies / restores

The script **only ever writes to Layer 2**. On startup it snapshots:

- Layer 2 opacity
- Layer 2 blend mode
- Transform effect's Scale and Rotation Z values

On `Ctrl+C` (SIGINT) or end-of-song detection (`progress >= 99.5%`), it restores all of those exactly, removes the Hue Rotate effect it added, and exits cleanly. There's also a 30-minute hard cap as a runaway-protection backstop.

It **never** touches Layer 1 (the audio), the BPM, the master, or any other layer.

#### Why this is useful as a template

Most Resolume integrations either poll REST every 100 ms (laggy, wasteful) or use OSC purely for triggers. This script demonstrates the unique pattern OSC unlocks: **subscribe to the playhead and let Resolume push it to you**, then react in Node-land. It shows:

- `dgram` UDP bind on port 7001 to receive Resolume's OSC OUT broadcasts
- Glob-pattern address matching (`/composition/layers/*/clips/*/transport/position`) via the project's `matchOscPattern`
- Phase tracking driven by the audio playhead (NOT wall-clock time — paused audio = paused effects)
- BPM-locked beat detection in Node (Resolume doesn't broadcast beat ticks; we compute `beatIdx = floor(positionMs / (60000/bpm))`)
- Race-safe transition guards (set `lastPhase` *before* awaiting setup work so concurrent inflight playhead packets don't all race through the same transition)
- Snapshot-and-restore pattern for safe live VJ scripting

Copy this file, swap in your own phase logic, and you have a foundation for any time-based VJ automation.

#### Resolume API quirks the script handles

These are the load-bearing details we discovered while building this — they're documented in the source as comments too:

1. **OSC playhead is normalized 0..1**, not milliseconds. REST gives you milliseconds (`transport.position.value` 0..`max`); OSC gives you a float in [0, 1]. We multiply by `state.durationMs` to get a position-in-ms for beat math.
2. **Effect parameter PUTs target the parent layer**, not the effect path. `PUT /composition/layers/{N}/effects/video/{idx}` returns 405. The supported pattern is `PUT /composition/layers/{N}` with body `{ video: { effects: [ {}, {}, { id: <effectId>, params: { Foo: { value: 42 } } } ] } }` — the array slot must include the effect's numeric `id`.
3. **Effect names with spaces must be percent-encoded** in the `effect:///video/{Name}` URI body. Resolume parses it via Boost.URL, which 400s on raw spaces (`leftover [boost.url.grammar:4]`). Compare:

   ```
   POST .../add  body: effect:///video/Hue Rotate     → 400
   POST .../add  body: effect:///video/Hue%20Rotate   → 204
   ```

4. **Effect objects expose two name fields** — `name` (compact, e.g. `"HueRotate"`) and `display_name` (with spaces, e.g. `"Hue Rotate"`). Match against both, ignoring whitespace, to avoid silent misses.
5. **DELETE is 0-based**, everything else 1-based. `DELETE /effects/video/0` removes the first effect.

## Safety

These scripts include `SIGINT` handlers that restore state before exiting. If you `kill -9` the process or your terminal crashes, the snapshot is lost and you'll need to manually undo any added effects / restore opacity / restore blend mode in Resolume.

For live performance, run a quick `Ctrl+C` test before going on stage to confirm cleanup works on your machine.
