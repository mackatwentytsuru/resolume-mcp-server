// Live smoke test: drive the built tool surface against running Resolume.
// Adds Blur to layer 2 via the MCP tool, verifies, removes via the MCP tool.
// Reversible: always restores state.

import { ResolumeClient } from "../build/resolume/client.js";
import { ResolumeRestClient } from "../build/resolume/rest.js";

const HOST = process.env.RESOLUME_HOST ?? "100.74.26.128";
const PORT = Number(process.env.RESOLUME_PORT ?? 8080);
const LAYER = 2;
const EFFECT = "Blur";

const rest = new ResolumeRestClient({
  baseUrl: `http://${HOST}:${PORT}`,
  timeoutMs: 5000,
});
const client = new ResolumeClient(rest);

const before = await client.listLayerEffects(LAYER);
console.log("Before:", before.map((e) => e.name));

console.log(`\n→ addEffectToLayer(${LAYER}, "${EFFECT}")`);
await client.addEffectToLayer(LAYER, EFFECT);
await new Promise((r) => setTimeout(r, 300));

const mid = await client.listLayerEffects(LAYER);
console.log("After add:", mid.map((e) => e.name));
if (mid.length !== before.length + 1 || mid[mid.length - 1].name !== EFFECT) {
  console.error("FAIL: effect not added as expected");
  process.exit(1);
}
console.log("  ✔ ADD OK");

const newIndex = mid.length; // 1-based
console.log(`\n→ removeEffectFromLayer(${LAYER}, ${newIndex})`);
await client.removeEffectFromLayer(LAYER, newIndex);
await new Promise((r) => setTimeout(r, 300));

const after = await client.listLayerEffects(LAYER);
console.log("After remove:", after.map((e) => e.name));
if (after.length !== before.length) {
  console.error("FAIL: effect not removed; manual cleanup may be required");
  process.exit(1);
}
console.log("  ✔ REMOVE OK");
console.log("\nAll good — layer state restored.");
