#!/usr/bin/env node
// examples/osc-realtime-vj.mjs
//
// Standalone OSC-driven realtime VJ demo. Showcases the unique capabilities
// OSC unlocks over REST:
//
//   1. Real-time playhead push — Resolume broadcasts
//      /composition/layers/1/clips/1/transport/position at ~30..60 Hz.
//      We use this as the master clock for phase-based scripting.
//   2. Low-latency triggers — UDP fire-and-forget OSC vs an HTTP round-trip.
//   3. Wildcard subscriptions — one bind catches every layer's playhead.
//
// What the script does (Layer 2 only — Layer 1's audio is left alone):
//
//   Phase A (0..25%   of song): subtle Transform Scale pulse on each beat.
//   Phase B (25..50%):          add Hue Rotate, sweep with each bar (4 beats).
//   Phase C (50..75%):          larger Transform Z-rotation + blend = Add.
//   Phase D (75..100%):         cooldown — opacity fade, restore Alpha blend.
//
// Beat detection: Resolume doesn't broadcast per-beat ticks, so we drive a
// Node-side phase tracker from BPM (60_000 / bpm = ms per beat) and the live
// REST playhead position-in-ms.
//
// Cleanup: SIGINT or end-of-song restores Layer 2 to:
//   - opacity = 1.0
//   - blend mode = Alpha
//   - Transform { Scale=100, Rotation Z=0 }
//   - Hue Rotate effect removed (if we added it)
//
// Usage:
//   node examples/osc-realtime-vj.mjs
//   node examples/osc-realtime-vj.mjs http://127.0.0.1:8080 127.0.0.1 7000 7001
//
// Requirements: Resolume Arena/Avenue running, Web Server on, OSC Input/Output
// enabled, an audio (or video) clip playing on Layer 1, a connectable visual
// clip on Layer 2 with at least the default Transform effect.

import dgram from 'node:dgram';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pull the OSC codec out of the project's compiled build to avoid duplicating
// 80 lines of bit-twiddling. If the build is stale, run `npm run build` once.
const __dirname = dirname(fileURLToPath(import.meta.url));
const codec = await import(
  // file:// URL keeps Windows paths happy.
  new URL('../build/resolume/osc-codec.js', import.meta.url).href
).catch((err) => {
  console.error(
    '[demo] Could not load build/resolume/osc-codec.js. Run `npm run build` first.'
  );
  console.error(err.message);
  process.exit(2);
});
const { encodeMessage, decodePacket, matchOscPattern } = codec;

// ─────────────────────── config ───────────────────────

const REST_BASE = process.argv[2] || 'http://127.0.0.1:8080';
const OSC_HOST = process.argv[3] || '127.0.0.1';
const OSC_IN_PORT = Number(process.argv[4] || 7000);
const OSC_OUT_PORT = Number(process.argv[5] || 7001);

const TARGET_LAYER = 2; // we only mutate L2
const AUDIO_LAYER = 1; // L1's clip is the master clock — read only
const AUDIO_CLIP_SLOT = 1; // probed dynamically below; this is the fallback

// Safety: hard cap how long we run, so a forgotten Ctrl+C doesn't VJ forever.
const MAX_RUN_MS = 1000 * 60 * 30; // 30 minutes

// ─────────────────────── helpers ───────────────────────

/**
 * Match a Resolume effect object against a human name.
 *
 * Resolume effect entries have BOTH `name` (compact id-style, e.g. "HueRotate")
 * AND `display_name` (with spaces, e.g. "Hue Rotate"). Naive matching against
 * just `.name` misses "Hue Rotate", so we compare against both, ignoring
 * spaces.
 */
function effectMatches(effect, target) {
  if (!effect) return false;
  const norm = (s) => (typeof s === 'string' ? s.replace(/\s+/g, '').toLowerCase() : '');
  const want = norm(target);
  return norm(effect.name) === want || norm(effect.display_name) === want;
}

// ─────────────────────── REST helpers ───────────────────────

async function getJson(path) {
  const res = await fetch(`${REST_BASE}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function putJson(path, body) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  // Resolume frequently returns 204 No Content on writes — don't try to parse.
  if (!res.ok && res.status !== 204) {
    throw new Error(`PUT ${path} → ${res.status}`);
  }
}

async function postText(path, body) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`POST ${path} → ${res.status}`);
  }
}

async function deletePath(path) {
  const res = await fetch(`${REST_BASE}${path}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`DELETE ${path} → ${res.status}`);
  }
}

// ─────────────────────── OSC send (one-shot) ───────────────────────

function sendOsc(address, args) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const pkt = encodeMessage(address, args);
    sock.send(pkt, OSC_IN_PORT, OSC_HOST, (err) => {
      sock.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

// ─────────────────────── discovery ───────────────────────

async function discover() {
  console.log('[demo] discovering composition state...');
  const comp = await getJson('/api/v1/composition');
  const bpm = comp?.tempocontroller?.tempo?.value;
  const layerCount = comp?.layers?.length ?? 0;
  if (typeof bpm !== 'number' || layerCount < TARGET_LAYER) {
    throw new Error(
      `Composition not VJ-demo-ready (bpm=${bpm}, layers=${layerCount})`
    );
  }

  // Find which clip slot is connected on L1 (the audio).
  const audioLayer = comp.layers[AUDIO_LAYER - 1];
  const connectedSlot =
    audioLayer.clips.findIndex((c) => {
      const v = c?.connected?.value;
      return v && v !== 'Empty' && v !== 'Disconnected';
    }) + 1; // 1-based; -1 → 0

  if (!connectedSlot) {
    throw new Error(
      `No clip is connected on Layer ${AUDIO_LAYER}. Trigger the audio first.`
    );
  }

  const audioClip = audioLayer.clips[connectedSlot - 1];
  const durationMs = audioClip?.transport?.position?.max ?? 0;
  const positionMs = audioClip?.transport?.position?.value ?? 0;

  // Snapshot Layer 2 so we can restore it.
  const targetLayer = comp.layers[TARGET_LAYER - 1];
  const beforeOpacity = targetLayer?.video?.opacity?.value ?? 1;
  const beforeBlend = targetLayer?.video?.mixer?.['Blend Mode']?.value ?? 'Alpha';

  // Find the Transform effect (every layer ships with one by default).
  const effects = targetLayer?.video?.effects ?? [];
  const transformIdx = effects.findIndex((e) => effectMatches(e, 'Transform'));
  if (transformIdx < 0) {
    throw new Error(
      `Layer ${TARGET_LAYER} has no Transform effect. Add one in Resolume first.`
    );
  }

  const transform = effects[transformIdx];
  const transformId = transform?.id;
  if (typeof transformId !== 'number') {
    throw new Error(
      `Transform effect on Layer ${TARGET_LAYER} has no numeric id; cannot mutate safely.`
    );
  }
  const beforeScale = transform?.params?.Scale?.value ?? 100;
  const beforeRotZ = transform?.params?.['Rotation Z']?.value ?? 0;

  console.log(
    `[demo]   bpm=${bpm}  L1.clip=${connectedSlot} duration=${(durationMs / 1000).toFixed(1)}s position=${(positionMs / 1000).toFixed(1)}s`
  );
  console.log(
    `[demo]   L${TARGET_LAYER} opacity=${beforeOpacity} blend=${beforeBlend} effects=${effects.length} (Transform at idx ${transformIdx + 1})`
  );

  return {
    bpm,
    audioClipSlot: connectedSlot,
    durationMs,
    initialPositionMs: positionMs,
    layer2: {
      opacity: beforeOpacity,
      blend: beforeBlend,
      transformIdx1: transformIdx + 1, // 1-based index for set_effect_parameter
      transformId,
      scale: beforeScale,
      rotationZ: beforeRotZ,
      effectCountBefore: effects.length,
    },
  };
}

// ─────────────────────── L2 mutators ───────────────────────
//
// We use the parent-path nested PUT idiom — Resolume silently ignores or 405s
// writes that target the effect endpoint directly. The supported pattern is:
//
//   PUT /composition/layers/{N}
//     { video: { effects: [ {}, {}, { id: <effectId>, params: { Foo: { value: 42 }}}, ...] }}
//
// The effect at array position i is identified by its `id` *plus* its position
// in the array (positions before it must be present as empty objects, but
// positions after it can be omitted). See src/resolume/client.ts setEffectParameter.

async function setEffectParam(effectIdx1, effectId, paramName, value) {
  const arr = [];
  for (let i = 0; i < effectIdx1 - 1; i += 1) arr.push({});
  arr.push({ id: effectId, params: { [paramName]: { value } } });
  const path = `/api/v1/composition/layers/${TARGET_LAYER}`;
  await putJson(path, { video: { effects: arr } });
}

async function setTransformParam(state, paramName, value) {
  await setEffectParam(
    state.layer2.transformIdx1,
    state.layer2.transformId,
    paramName,
    value
  );
}

async function setLayerOpacity(opacity) {
  const path = `/api/v1/composition/layers/${TARGET_LAYER}`;
  await putJson(path, { video: { opacity: { value: opacity } } });
}

async function setBlendMode(name) {
  const path = `/api/v1/composition/layers/${TARGET_LAYER}`;
  await putJson(path, {
    video: { mixer: { 'Blend Mode': { value: name } } },
  });
}

async function addHueRotate() {
  const path = `/api/v1/composition/layers/${TARGET_LAYER}/effects/video/add`;
  // Resolume parses the body as a URI via Boost.URL. Spaces in the effect
  // name (e.g. "Hue Rotate") MUST be percent-encoded or the server returns
  // 400 "leftover [boost.url.grammar:4]". Single-word names work either way.
  await postText(path, `effect:///video/${encodeURIComponent('Hue Rotate')}`);
}

async function removeEffectByName(name) {
  // Re-read to find current 1-based index (effects shift when one is removed).
  const layer = await getJson(`/api/v1/composition/layers/${TARGET_LAYER}`);
  const effects = layer?.video?.effects ?? [];
  const arrIdx = effects.findIndex((e) => effectMatches(e, name));
  if (arrIdx < 0) return; // already gone
  // DELETE uses 0-based index per Resolume convention.
  await deletePath(
    `/api/v1/composition/layers/${TARGET_LAYER}/effects/video/${arrIdx}`
  );
}

// ─────────────────────── phase logic ───────────────────────

function phaseFor(progress01) {
  if (progress01 < 0.25) return 'A';
  if (progress01 < 0.5) return 'B';
  if (progress01 < 0.75) return 'C';
  return 'D';
}

const phaseDesc = {
  A: '0..25%  subtle Scale pulse per beat',
  B: '25..50% Hue Rotate sweep per bar',
  C: '50..75% bigger Z-rotation + Add blend',
  D: '75..100% cooldown — opacity fade + Alpha',
};

// ─────────────────────── main reactive loop ───────────────────────

async function run() {
  const state = await discover();
  const beatMs = 60_000 / state.bpm;
  const barMs = beatMs * 4;
  console.log(
    `[demo] beat = ${beatMs.toFixed(1)} ms,  bar = ${barMs.toFixed(1)} ms`
  );

  // Pre-build an "added effects" list so cleanup can be precise.
  const addedEffectNames = new Set();

  // Restore handlers: idempotent + safe to call multiple times.
  let cleaningUp = false;
  async function restore(reason) {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log(`[demo] restoring Layer ${TARGET_LAYER} (reason: ${reason})`);
    try {
      // 1. Opacity + blend back to snapshot.
      await setLayerOpacity(state.layer2.opacity);
      await setBlendMode(state.layer2.blend);
      // 2. Transform Scale + Rotation Z back to snapshot.
      await setTransformParam(state, 'Scale', state.layer2.scale);
      await setTransformParam(state, 'Rotation Z', state.layer2.rotationZ);
      // 3. Remove any effects we added.
      for (const name of addedEffectNames) {
        await removeEffectByName(name).catch((err) =>
          console.warn(`[demo] failed to remove ${name}: ${err.message}`)
        );
      }
      console.log('[demo] restore complete.');
    } catch (err) {
      console.error('[demo] restore error:', err?.message || err);
    }
  }

  // Wire SIGINT before subscribe (so Ctrl+C during bind() still cleans up).
  let stopRequested = false;
  process.on('SIGINT', async () => {
    console.log('\n[demo] SIGINT received');
    stopRequested = true;
    await restore('SIGINT');
    process.exit(0);
  });

  // Hard timer — never run forever.
  const hardStopTimer = setTimeout(() => {
    console.log('[demo] hard stop reached (MAX_RUN_MS)');
    stopRequested = true;
  }, MAX_RUN_MS);
  hardStopTimer.unref();

  // ─────────────── OSC subscribe ───────────────
  const sock = dgram.createSocket('udp4');

  let lastProgress = -1;
  let lastBeatIdx = -1;
  let lastBarIdx = -1;
  let lastPhase = '';
  let firstPlayheadSeen = false;
  let totalBeats = 0;

  // Pattern we want — wildcard layer index keeps us robust if the user
  // moves the audio to a different layer mid-session.
  const PATTERN = '/composition/layers/*/clips/*/transport/position';

  sock.on('error', (err) => {
    console.error('[demo] OSC socket error:', err.message);
  });

  sock.on('message', async (buf) => {
    if (stopRequested) return;
    let messages;
    try {
      messages = decodePacket(buf);
    } catch {
      return;
    }
    for (const m of messages) {
      if (!matchOscPattern(PATTERN, m.address)) continue;
      // Filter to *the* audio layer's clip — wildcard catches L2 too.
      const expected = `/composition/layers/${AUDIO_LAYER}/clips/${state.audioClipSlot}/transport/position`;
      if (m.address !== expected) continue;
      const progress01 = m.args[0];
      if (typeof progress01 !== 'number') continue;

      if (!firstPlayheadSeen) {
        firstPlayheadSeen = true;
        console.log(
          `[demo] first playhead arrived: ${(progress01 * 100).toFixed(2)}% via ${m.address}`
        );
      }
      lastProgress = progress01;

      // Compute discrete beat & bar indices from playhead-in-ms.
      const positionMs = progress01 * state.durationMs;
      const beatIdx = Math.floor(positionMs / beatMs);
      const barIdx = Math.floor(positionMs / barMs);
      const phase = phaseFor(progress01);

      // ── Phase transitions ──
      // Set lastPhase BEFORE awaiting setup work, so concurrent inflight
      // playhead messages don't all race through the same transition.
      if (phase !== lastPhase) {
        const fromPhase = lastPhase;
        lastPhase = phase;
        console.log(
          `[demo] >>> phase ${fromPhase || '∅'} → ${phase}: ${phaseDesc[phase]}  (${(progress01 * 100).toFixed(1)}%)`
        );
        try {
          if (phase === 'A') {
            await setBlendMode('Alpha');
            await setLayerOpacity(1.0);
          } else if (phase === 'B') {
            if (!addedEffectNames.has('Hue Rotate')) {
              await addHueRotate();
              addedEffectNames.add('Hue Rotate');
            }
          } else if (phase === 'C') {
            await setBlendMode('Add');
          } else if (phase === 'D') {
            await setBlendMode('Alpha');
          }
        } catch (err) {
          console.warn(`[demo] phase ${phase} setup failed: ${err.message}`);
        }
      }

      // ── Per-beat actions ──
      // Snapshot-and-bump lastBeatIdx before awaiting so concurrent messages
      // for the same beat don't double-fire.
      if (beatIdx !== lastBeatIdx) {
        const prev = lastBeatIdx;
        lastBeatIdx = beatIdx;
        // First playhead packet starts somewhere in the song — only count
        // genuine forward beats, not the initial alignment to the playhead.
        if (prev >= 0) totalBeats++;
        const onUpbeat = beatIdx % 2 === 0;

        try {
          if (phase === 'A') {
            // Subtle scale pulse: 110 on beat, back to 100 on offbeat.
            await setTransformParam(state, 'Scale', onUpbeat ? 110 : 100);
          } else if (phase === 'C') {
            // Bigger rotation that drifts each beat.
            const rot = ((beatIdx % 16) - 8) * 4; // -32..28
            await setTransformParam(state, 'Rotation Z', rot);
          } else if (phase === 'D') {
            // Cooldown: ramp opacity from 1.0 → 0.4 across the last 25%.
            const localProgress = (progress01 - 0.75) / 0.25;
            const opacity = Math.max(0.4, 1.0 - localProgress * 0.6);
            await setLayerOpacity(opacity);
          }
        } catch (err) {
          console.warn(`[demo] beat action failed: ${err.message}`);
        }
      }

      // ── Per-bar actions ──
      if (barIdx !== lastBarIdx) {
        lastBarIdx = barIdx;
        if (phase === 'B' && addedEffectNames.has('Hue Rotate')) {
          // Sweep Hue Rotate's Rotation parameter once per bar (0 → 360).
          const hueDeg = (barIdx % 6) * 60;
          try {
            const layer = await getJson(
              `/api/v1/composition/layers/${TARGET_LAYER}`
            );
            const layerEffects = layer?.video?.effects ?? [];
            const hueArrIdx = layerEffects.findIndex((e) =>
              effectMatches(e, 'Hue Rotate')
            );
            const hueId = layerEffects[hueArrIdx]?.id;
            if (hueArrIdx >= 0 && typeof hueId === 'number') {
              // Hue Rotate's Rotation param is 0..360 degrees.
              await setEffectParam(hueArrIdx + 1, hueId, 'Rotation', hueDeg);
            }
          } catch (err) {
            console.warn(`[demo] hue sweep failed: ${err.message}`);
          }
        }
      }

      // ── End-of-song detection ──
      if (progress01 >= 0.995) {
        console.log('[demo] end-of-song reached');
        stopRequested = true;
        await restore('end-of-song');
        try {
          sock.close();
        } catch {}
        clearTimeout(hardStopTimer);
        process.exit(0);
      }
    }
  });

  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(OSC_OUT_PORT, () => {
      console.log(`[demo] OSC subscribed on udp:${OSC_OUT_PORT} for ${PATTERN}`);
      resolve();
    });
  });

  // Idle loop — keeps the process alive while the OSC handler does work.
  // Heartbeat: every 10s, print where we are in the song so the user can
  // verify the script's understanding of the playhead matches Resolume's UI.
  let lastHeartbeat = Date.now();
  let waitingPrinted = false;
  while (!stopRequested) {
    await delay(500);
    const now = Date.now();
    if (firstPlayheadSeen && lastProgress >= 0 && now - lastHeartbeat >= 10000) {
      lastHeartbeat = now;
      const positionMs = lastProgress * state.durationMs;
      console.log(
        `[demo] heartbeat: ${(lastProgress * 100).toFixed(1)}% (${(positionMs / 1000).toFixed(1)}s / ${(state.durationMs / 1000).toFixed(1)}s)  beats=${totalBeats}  phase=${lastPhase}`
      );
    } else if (!firstPlayheadSeen && !waitingPrinted && now - lastHeartbeat >= 3000) {
      waitingPrinted = true;
      console.log(
        '[demo] (waiting for playhead — is OSC OUT enabled in Resolume Preferences > OSC?)'
      );
    }
  }

  // Stop loop fell out — ensure cleanup.
  await restore('main-loop-exit');
  try {
    sock.close();
  } catch {}
  clearTimeout(hardStopTimer);
}

run().catch(async (err) => {
  console.error('[demo] fatal:', err?.stack || err?.message || err);
  process.exit(1);
});
