// Continuous BPM-synced VJ loop — runs until killed (Ctrl+C / SIGINT / process kill)
// Operates Layer 2 only. Cycles through effects + params every beat.
// Safe defaults from resolume-mcp-tester skill:
//   - Bloom Threshold ≥ 0.7, Size ≤ 0.4
//   - No Trails
//   - One effect at a time
//   - Restore baseline on exit

const REST = process.env.RESOLUME_REST ?? "http://127.0.0.1:8080/api/v1";
const LAYER = 2;

// Effect catalog — each entry: name, params to modulate, value generators (return safe values)
// All values clipped to safe ranges per skill rules.
const FX_CATALOG = [
  { name: "Bloom", url: "Bloom", params: [
    { name: "Threshold", gen: () => 0.75 + Math.random() * 0.2 },   // 0.75..0.95
    { name: "Size",      gen: () => 0.15 + Math.random() * 0.2 },   // 0.15..0.35
    { name: "Amount",    gen: () => 0.5 + Math.random() * 0.5 },    // 0.5..1.0
  ]},
  { name: "HueRotate", url: "Hue%20Rotate", params: [
    { name: "Hue Rotate", gen: () => Math.random() },               // 0..1
    { name: "Sat. Scale", gen: () => 0.4 + Math.random() * 0.6 },   // 0.4..1.0
  ]},
  { name: "PixelBlur", url: "Pixel%20Blur", params: [
    { name: "Distance X", gen: () => Math.random() * 100 },          // 0..100
    { name: "Distance Y", gen: () => Math.random() * 100 },
  ]},
  { name: "Posterize", url: "Posterize", params: [
    { name: "Posterize", gen: () => 0.2 + Math.random() * 0.6 },     // 0.2..0.8
  ]},
  { name: "Mirror", url: "Mirror", params: [
    { name: "X", gen: () => Math.random() },
    { name: "Y", gen: () => Math.random() },
  ]},
  { name: "Kaleidoscope", url: "Kaleidoscope", params: [
    { name: "Angles",   gen: () => 0.3 + Math.random() * 0.6 },
    { name: "Rotation", gen: () => Math.random() },
    { name: "Zoom",     gen: () => 0.3 + Math.random() * 0.5 },
  ]},
  { name: "LoRezEffect", url: "LoRez", params: [
    { name: "Pixel Size",    gen: () => Math.random() * 0.6 },       // 0..0.6
    { name: "Bit Reduction", gen: () => Math.random() * 0.7 },
  ]},
  { name: "TileEffect", url: "Tile", params: [
    { name: "Tile X", gen: () => 0.1 + Math.random() * 0.5 },
    { name: "Tile Y", gen: () => 0.1 + Math.random() * 0.5 },
    { name: "Rotation Angle", gen: () => Math.random() * 0.3 },
  ]},
  { name: "Distortion", url: "Distortion", params: [
    { name: "Distort", gen: () => 0.2 + Math.random() * 0.6 },
    { name: "Radius",  gen: () => 0.3 + Math.random() * 0.4 },
  ]},
  { name: "Vignette", url: "Vignette", params: [
    { name: "Size",      gen: () => 0.2 + Math.random() * 0.4 },
    { name: "Roundness", gen: () => Math.random() },
    { name: "Softness",  gen: () => 0.3 + Math.random() * 0.6 },
  ]},
  { name: "Polkadot", url: "Polkadot", params: [] },
  { name: "Sphere", url: "Sphere", params: [
    { name: "Size",     gen: () => 0.4 + Math.random() * 0.4 },
    { name: "Rotation Y", gen: () => -90 + Math.random() * 180 },
  ]},
];

const BLEND_MODES = ["Alpha", "Add", "Multiply", "Screen", "Lighten", "Darken", "Overlay"];

// Helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok && r.status !== 204) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url}: ${t.slice(0,100)}`);
  }
  if (r.status === 204) return null;
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) return null;
  return r.json();
}

async function getLayer() {
  return fetchJson(`${REST}/composition/layers/${LAYER}`);
}

async function addEffect(urlSlug) {
  await fetch(`${REST}/composition/layers/${LAYER}/effects/video/add`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: `effect:///video/${urlSlug}`,
  });
}

async function removeEffectAt(zeroBasedIdx) {
  await fetch(`${REST}/composition/layers/${LAYER}/effects/video/${zeroBasedIdx}`, { method: "DELETE" });
}

async function setEffectParam(effectIdx1Based, effectId, paramName, value) {
  const padding = Array(effectIdx1Based - 1).fill({});
  const body = {
    video: {
      effects: [
        ...padding,
        { id: effectId, params: { [paramName]: { value } } },
      ],
    },
  };
  await fetch(`${REST}/composition/layers/${LAYER}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setBlendMode(mode) {
  await fetch(`${REST}/composition/layers/${LAYER}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video: { mixer: { "Blend Mode": { value: mode } } } }),
  });
}

// State tracking for cleanup
const addedEffects = []; // [{ name, originalIndex }]
let originalBlendMode = "Alpha";
let stopping = false;

async function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log("\n[cleanup] removing added effects + restoring blend mode");
  // remove all added effects (find them by name; remove from end to keep indices stable)
  try {
    const layer = await getLayer();
    const fx = layer.video.effects;
    // Anything beyond the first Transform effect is what we added (assuming Transform is always at index 0)
    const toRemove = [];
    for (let i = 1; i < fx.length; i++) toRemove.push(i);
    for (const idx of toRemove.reverse()) {
      try { await removeEffectAt(idx); } catch (e) { console.error("remove fail:", e.message); }
      await sleep(50);
    }
    await setBlendMode(originalBlendMode);
    console.log("[cleanup] done");
  } catch (e) {
    console.error("[cleanup] error:", e.message);
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

async function main() {
  // Snapshot
  const before = await getLayer();
  originalBlendMode = before.video.mixer["Blend Mode"].value;
  console.log(`[start] L${LAYER} baseline: blend=${originalBlendMode}, ${before.video.effects.length} effect(s)`);

  // Get BPM
  const comp = await fetchJson(`${REST}/composition`);
  const bpm = comp.tempocontroller.tempo.value;
  const beatMs = 60_000 / bpm;
  console.log(`[start] BPM ${bpm.toFixed(1)} → beat = ${beatMs.toFixed(0)}ms`);

  let beatCount = 0;
  let currentEffect = null; // { catalogEntry, layerIndex (1-based), id }

  while (true) {
    beatCount++;

    // Decide what to do this beat
    const choice = beatCount % 8 === 0 ? "swap" :     // every 8 beats, swap effect
                   beatCount % 16 === 0 ? "blend" :   // every 16 beats, swap blend mode
                   "param";                            // otherwise modulate current

    if (choice === "swap" || !currentEffect) {
      // Remove current
      if (currentEffect) {
        try { await removeEffectAt(currentEffect.layerIndex - 1); } catch {}
      }
      // Pick a new one
      const cat = pick(FX_CATALOG);
      await addEffect(cat.url);
      await sleep(150); // let Resolume process the add
      const layer = await getLayer();
      const newFx = layer.video.effects[layer.video.effects.length - 1];
      currentEffect = {
        catalogEntry: cat,
        layerIndex: layer.video.effects.length,
        id: newFx.id,
      };
      console.log(`[beat ${beatCount}] SWAP → ${cat.name} (idx ${currentEffect.layerIndex}, id ${newFx.id})`);
    } else if (choice === "blend") {
      const mode = pick(BLEND_MODES);
      await setBlendMode(mode);
      console.log(`[beat ${beatCount}] BLEND → ${mode}`);
    } else if (choice === "param" && currentEffect) {
      const params = currentEffect.catalogEntry.params;
      if (params.length > 0) {
        const param = pick(params);
        const v = param.gen();
        try {
          await setEffectParam(currentEffect.layerIndex, currentEffect.id, param.name, v);
          if (beatCount % 4 === 0) {
            console.log(`[beat ${beatCount}] ${currentEffect.catalogEntry.name}.${param.name} = ${v.toFixed(3)}`);
          }
        } catch (e) { console.error("param fail:", e.message); }
      }
    }

    await sleep(beatMs);
  }
}

main().catch(async (e) => {
  console.error("FATAL:", e.message);
  await cleanup();
});
