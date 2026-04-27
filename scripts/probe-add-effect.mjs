// Probe Resolume to discover the working add/remove effect protocol shape.
// Adds ONE effect to layer 2, verifies via GET, then removes it. Reversible.
//
// Usage: node scripts/probe-add-effect.mjs
//   RESOLUME_HOST=100.74.26.128 RESOLUME_PORT=8080 by default.

import WebSocket from "ws";

const HOST = process.env.RESOLUME_HOST ?? "100.74.26.128";
const PORT = Number(process.env.RESOLUME_PORT ?? 8080);
const HTTP_BASE = `http://${HOST}:${PORT}/api/v1`;
const WS_URL = `ws://${HOST}:${PORT}/api/v1`;
const LAYER = 2;
const EFFECT_NAME = "Blur"; // simple, well-known, harmless effect

async function http(method, path, opts = {}) {
  const url = `${HTTP_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: opts.headers,
    body: opts.body,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text };
}

async function getLayerEffectsCount() {
  const r = await http("GET", `/composition/layers/${LAYER}`);
  const layer = JSON.parse(r.body);
  const effects = layer?.video?.effects ?? [];
  return { count: effects.length, names: effects.map((e) => e.name), ids: effects.map((e) => e.id) };
}

async function tryRestAddPlainText(effectName) {
  const path = `/composition/layers/${LAYER}/effects/video/add`;
  const body = `effect:///video/${effectName}`;
  const r = await http("POST", path, {
    headers: { "content-type": "text/plain" },
    body,
  });
  return { path, body, ...r };
}

async function tryRestDelete(effectIndex) {
  // Resolume effect indices in REST DELETE are 0-based per drohi-r/swagger
  const path = `/composition/layers/${LAYER}/effects/video/${effectIndex}`;
  return { path, ...(await http("DELETE", path)) };
}

async function tryWsRemoveById(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let acked = false;
    ws.on("open", () => {
      const msg = { action: "remove", path: `/composition/effects/by-id/${id}` };
      ws.send(JSON.stringify(msg));
      // Resolume's "remove" usually has no ack — close after short delay
      setTimeout(() => {
        acked = true;
        ws.close();
        resolve({ sent: msg });
      }, 500);
    });
    ws.on("error", (err) => {
      if (!acked) reject(err);
    });
  });
}

(async () => {
  console.log("== Probing Resolume effect add/remove ==");
  console.log("HTTP base:", HTTP_BASE);

  const before = await getLayerEffectsCount();
  console.log("Before:", before);

  console.log(`\n--- Trying REST POST /effects/video/add with text/plain "effect:///video/${EFFECT_NAME}" ---`);
  const addRes = await tryRestAddPlainText(EFFECT_NAME);
  console.log("Status:", addRes.status, "OK:", addRes.ok, "Body:", addRes.body.slice(0, 200));

  // Give Resolume a moment to apply
  await new Promise((r) => setTimeout(r, 300));

  const after = await getLayerEffectsCount();
  console.log("After add:", after);

  const added = after.count > before.count;
  console.log(added ? "  ✔ ADD WORKED" : "  ✘ ADD FAILED");

  if (!added) {
    console.log("\nRetry: REST POST without explicit content-type...");
    const r2 = await http("POST", `/composition/layers/${LAYER}/effects/video/add`, {
      body: `effect:///video/${EFFECT_NAME}`,
    });
    console.log("Status:", r2.status, "OK:", r2.ok, "Body:", r2.body.slice(0, 200));
    await new Promise((r) => setTimeout(r, 300));
    const after2 = await getLayerEffectsCount();
    console.log("After retry:", after2);
  }

  // Cleanup: remove whatever we added (always last effect in array)
  const finalState = await getLayerEffectsCount();
  if (finalState.count > before.count) {
    const newId = finalState.ids[finalState.ids.length - 1];
    const newIndex = finalState.count - 1; // 0-based REST DELETE index
    console.log(`\n--- Removing effect we added: id=${newId}, index=${newIndex} ---`);

    // Try REST DELETE first
    const delRes = await tryRestDelete(newIndex);
    console.log("DELETE status:", delRes.status, "OK:", delRes.ok, "Body:", delRes.body.slice(0, 200));
    await new Promise((r) => setTimeout(r, 300));
    let post = await getLayerEffectsCount();
    if (post.count > before.count) {
      console.log("  REST DELETE didn't remove — trying WS remove by id");
      await tryWsRemoveById(newId);
      await new Promise((r) => setTimeout(r, 500));
      post = await getLayerEffectsCount();
    }
    console.log("After cleanup:", post);
    console.log(post.count === before.count ? "  ✔ CLEAN" : "  ✘ DIRTY — manual cleanup needed!");
  } else {
    console.log("\nNothing to clean up.");
  }
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
