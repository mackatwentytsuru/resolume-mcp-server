// Continuous BPM-synced VJ loop (v2 — crash-safe).
// 5-second tick rate (~11 beats @ 131.4 BPM).
// Per skill Rule 2.5: max 1 effect swap per 32 beats (~14s) — we space ours at ~20s avg.
// Stack cap: 3 effects total (Transform + 2 added).

const REST = "http://100.74.26.128:8080/api/v1";
const LAYER = 2;
const TICK_MS = 5000;
const MAX_STACK = 3;

const FX_CATALOG = [
  { name: "Bloom", url: "Bloom", params: [
    { n: "Threshold", gen: () => 0.75 + Math.random() * 0.2 },
    { n: "Size",      gen: () => 0.15 + Math.random() * 0.25 },
    { n: "Amount",    gen: () => 0.5 + Math.random() * 0.5 },
  ]},
  { name: "HueRotate", url: "Hue%20Rotate", params: [
    { n: "Hue Rotate", gen: () => Math.random() },
    { n: "Sat. Scale", gen: () => 0.4 + Math.random() * 0.6 },
  ]},
  { name: "PixelBlur", url: "Pixel%20Blur", params: [
    { n: "Distance X", gen: () => Math.random() * 80 },
    { n: "Distance Y", gen: () => Math.random() * 80 },
  ]},
  { name: "Posterize", url: "Posterize", params: [
    { n: "Posterize", gen: () => 0.2 + Math.random() * 0.6 },
  ]},
  { name: "Mirror", url: "Mirror", params: [
    { n: "X", gen: () => Math.random() },
    { n: "Y", gen: () => Math.random() },
  ]},
  { name: "Kaleidoscope", url: "Kaleidoscope", params: [
    { n: "Angles",   gen: () => 0.3 + Math.random() * 0.6 },
    { n: "Rotation", gen: () => Math.random() },
    { n: "Zoom",     gen: () => 0.3 + Math.random() * 0.5 },
  ]},
  { name: "LoRezEffect", url: "LoRez", params: [
    { n: "Pixel Size",    gen: () => Math.random() * 0.5 },
    { n: "Bit Reduction", gen: () => Math.random() * 0.7 },
  ]},
  { name: "TileEffect", url: "Tile", params: [
    { n: "Tile X", gen: () => 0.1 + Math.random() * 0.4 },
    { n: "Tile Y", gen: () => 0.1 + Math.random() * 0.4 },
  ]},
  { name: "Distortion", url: "Distortion", params: [
    { n: "Distort", gen: () => 0.2 + Math.random() * 0.6 },
    { n: "Radius",  gen: () => 0.3 + Math.random() * 0.4 },
  ]},
  { name: "Vignette", url: "Vignette", params: [
    { n: "Size",      gen: () => 0.2 + Math.random() * 0.4 },
    { n: "Roundness", gen: () => Math.random() },
  ]},
  { name: "Sphere", url: "Sphere", params: [
    { n: "Size",       gen: () => 0.4 + Math.random() * 0.4 },
    { n: "Rotation Y", gen: () => -90 + Math.random() * 180 },
  ]},
  { name: "Tunnel", url: "Tunnel", params: [
    { n: "Position", gen: () => Math.random() },
    { n: "Twist",    gen: () => Math.random() },
  ]},
];

const BLEND_MODES = ["Alpha", "Add", "Multiply", "Screen", "Lighten", "Overlay", "Hard Light", "Soft Light"];

// Effects that DON'T need their own URL slug (name == url)
const findCat = (name) => FX_CATALOG.find(c => c.name === name);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok && r.status !== 204) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${t.slice(0,80)}`);
  }
  if (r.status === 204) return null;
  if (!(r.headers.get("content-type") || "").includes("json")) return null;
  return r.json();
}

const getLayer = () => fetchJson(`${REST}/composition/layers/${LAYER}`);

async function addEffect(urlSlug) {
  await fetch(`${REST}/composition/layers/${LAYER}/effects/video/add`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: `effect:///video/${urlSlug}`,
  });
}

async function removeAt0(zeroIdx) {
  await fetch(`${REST}/composition/layers/${LAYER}/effects/video/${zeroIdx}`, { method: "DELETE" });
}

async function setBlend(mode) {
  await fetch(`${REST}/composition/layers/${LAYER}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video: { mixer: { "Blend Mode": { value: mode } } } }),
  });
}

async function setOpacity(v) {
  await fetch(`${REST}/composition/layers/${LAYER}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video: { opacity: { value: v } } }),
  });
}

async function setParam(idxOneBased, effectId, paramName, value) {
  const padding = Array(idxOneBased - 1).fill({});
  await fetch(`${REST}/composition/layers/${LAYER}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video: { effects: [...padding, { id: effectId, params: { [paramName]: { value } } }] },
    }),
  });
}

let stopping = false;
let originalBlend = "Alpha";
let originalOpacity = 1.0;

async function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log("\n[cleanup] removing added effects + restoring");
  try {
    const layer = await getLayer();
    const fx = layer.video.effects;
    // Remove anything past the first Transform
    for (let i = fx.length - 1; i >= 1; i--) {
      try { await removeAt0(i); } catch {}
      await sleep(80);
    }
    await setBlend(originalBlend);
    await setOpacity(originalOpacity);
    console.log("[cleanup] done");
  } catch (e) {
    console.error("[cleanup] err:", e.message);
  }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

async function main() {
  const before = await getLayer();
  originalBlend = before.video.mixer["Blend Mode"].value;
  originalOpacity = before.video.opacity.value;
  console.log(`[start] L${LAYER}: blend=${originalBlend}, opacity=${originalOpacity}, ${before.video.effects.length} fx`);

  const comp = await fetchJson(`${REST}/composition`);
  const bpm = comp.tempocontroller.tempo.value;
  console.log(`[start] BPM ${bpm.toFixed(1)} → tick every ${TICK_MS}ms`);

  let tick = 0;
  let lastSwapTick = -10; // Initialize so first swap can fire after a few ticks
  const SWAP_COOLDOWN = 4; // tickごと(=20秒)に最低 swap 間隔

  while (true) {
    tick++;

    // Read current state
    let layer;
    try {
      layer = await getLayer();
    } catch (e) {
      console.error(`[tick ${tick}] read fail (Resolume crashed?):`, e.message);
      await cleanup();
      return;
    }

    const fx = layer.video.effects; // Transform at idx 0, added effects at idx 1+
    const stackCount = fx.length;

    // Weighted random action
    const r = Math.random();
    const canSwap = (tick - lastSwapTick) >= SWAP_COOLDOWN;
    const canAdd = stackCount < MAX_STACK && canSwap;
    const canRemove = stackCount > 1 && canSwap;

    let action;
    if (r < 0.50) action = "param";
    else if (r < 0.65) action = "blend";
    else if (r < 0.75) action = "opacity";
    else if (r < 0.90 && canAdd) action = "add";
    else if (canRemove) action = "remove";
    else action = "param";

    try {
      if (action === "param" && stackCount > 0) {
        // Pick a random effect (including Transform — only modulate Transform's safe params)
        const effIdx = Math.floor(Math.random() * stackCount);
        const eff = fx[effIdx];
        const cat = findCat(eff.name);
        let paramSet;
        if (cat) {
          paramSet = cat.params;
        } else if (eff.name === "Transform") {
          // Safe transform params — Scale only
          paramSet = [
            { n: "Scale",      gen: () => 80 + Math.random() * 80 },   // 80..160
            { n: "Rotation Z", gen: () => -30 + Math.random() * 60 },
          ];
        } else {
          paramSet = [];
        }
        if (paramSet.length > 0) {
          const param = pick(paramSet);
          const v = param.gen();
          await setParam(effIdx + 1, eff.id, param.n, v);
          console.log(`[tick ${tick}] PARAM  ${eff.name}.${param.n} = ${typeof v === "number" ? v.toFixed(2) : v}`);
        }
      } else if (action === "blend") {
        const mode = pick(BLEND_MODES);
        await setBlend(mode);
        console.log(`[tick ${tick}] BLEND  ${mode}`);
      } else if (action === "opacity") {
        const v = 0.6 + Math.random() * 0.4; // 0.6..1.0
        await setOpacity(v);
        console.log(`[tick ${tick}] OPAC   ${v.toFixed(2)}`);
      } else if (action === "add") {
        const cat = pick(FX_CATALOG.filter(c => !fx.some(e => e.name === c.name))); // avoid duplicates
        if (cat) {
          await addEffect(cat.url);
          lastSwapTick = tick;
          console.log(`[tick ${tick}] ADD    ${cat.name}  (stack=${stackCount + 1})`);
        }
      } else if (action === "remove") {
        // Remove last (newest) added effect
        await removeAt0(stackCount - 1);
        lastSwapTick = tick;
        const removed = fx[stackCount - 1];
        console.log(`[tick ${tick}] REMOVE ${removed.name}  (stack=${stackCount - 1})`);
      }
    } catch (e) {
      console.error(`[tick ${tick}] action fail:`, e.message);
    }

    await sleep(TICK_MS);
  }
}

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await cleanup();
});
