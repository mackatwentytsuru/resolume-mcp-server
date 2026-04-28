// Probe Resolume's REST API for the speculative narrower sub-endpoints
// catalogued in `docs/v0.5/04-effect-cache-and-sub-endpoints.md`.
//
// Use when:
//   - You have a live Resolume Arena/Avenue running on 127.0.0.1:8080.
//   - You want empirical confirmation (404 / 405 / 204) that an endpoint
//     either exists or doesn't, without modifying production code.
//
// Usage:
//   node scripts/probe-subendpoints.mjs [host] [port]
//   node scripts/probe-subendpoints.mjs 127.0.0.1 8080
//
// What it probes (each row maps to a row in the catalog):
//   #3  POST   /composition/clear                            (drohi-r style, undocumented)
//   #3b POST   /composition/layers/1/clearclips              (Swagger-confirmed; alt for wipeComposition)
//   #8  PUT    /composition/tempocontroller/tempo            (deep PUT)
//   #9  POST   /composition/tempocontroller/tempo_tap        (action POST)
//   #9b POST   /composition/tempocontroller/tempotap         (alt spelling per Companion OSC)
//   #10 POST   /composition/tempocontroller/resync           (action POST — highest priority)
//   #12 PUT    /composition/crossfader/phase                 (deep PUT)
//
// Side-effect safety:
//   - All probes are READ-only OR fully reversible at the level Resolume
//     normally exposes them. The script DOES NOT probe `/composition/clear`
//     against a populated composition — only run it on a fresh, empty one.
//     Set `--allow-wipe` to opt in.
//   - tap_tempo / resync are visible-but-harmless (one tap, one phase realign).
//   - Deep PUTs use the *current* tempo / phase value as the payload, so even
//     if they happen to succeed they leave state unchanged.
//
// Output:
//   - Prints a markdown table to stdout (suitable for piping into the
//     swagger-probe-results doc).
//   - Exits 0 even when probes return 4xx — the goal is to *catalog* the
//     responses, not enforce success.

import { argv } from "node:process";

const HOST = argv[2] || "127.0.0.1";
const PORT = Number(argv[3] || 8080);
const ALLOW_WIPE = argv.includes("--allow-wipe");

const BASE = `http://${HOST}:${PORT}/api/v1`;

/** @typedef {{ id: string; method: string; path: string; getBody?: () => Promise<unknown>; safe: boolean; notes?: string }} Probe */

/** @returns {Promise<unknown>} Current composition for value-preserving payloads. */
async function readComposition() {
  const res = await fetch(`${BASE}/composition`);
  if (!res.ok) {
    throw new Error(`Cannot read /composition: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Builds the probe list. `getBody` is invoked lazily so a missing composition
 *  read doesn't abort the entire probe run. */
function probes(/** @type {() => Promise<any>} */ readComp) {
  return /** @type {Probe[]} */ ([
    {
      id: "#3",
      method: "POST",
      path: "/composition/clear",
      safe: ALLOW_WIPE, // destructive; opt-in only
      notes: ALLOW_WIPE
        ? "Allowed via --allow-wipe."
        : "Skipped without --allow-wipe (destructive against populated composition).",
    },
    {
      id: "#3b",
      method: "POST",
      path: "/composition/layers/1/clearclips",
      safe: ALLOW_WIPE,
      notes: ALLOW_WIPE
        ? "Allowed via --allow-wipe."
        : "Skipped without --allow-wipe (clears every clip on layer 1).",
    },
    {
      id: "#8",
      method: "PUT",
      path: "/composition/tempocontroller/tempo",
      safe: true,
      // Roundtrip current BPM as a no-op write.
      getBody: async () => {
        const c = await readComp();
        const current = c?.tempocontroller?.tempo?.value ?? 120;
        return { value: typeof current === "number" ? current : 120 };
      },
      notes: "Deep PUT with current BPM — no-op write if endpoint exists.",
    },
    {
      id: "#9",
      method: "POST",
      path: "/composition/tempocontroller/tempo_tap",
      safe: true,
      notes: "One tap is harmless; multiple-taps recalibrate BPM (we send one).",
    },
    {
      id: "#9b",
      method: "POST",
      path: "/composition/tempocontroller/tempotap",
      safe: true,
      notes: "Alt spelling (no underscore) per Companion's OSC trigger path.",
    },
    {
      id: "#10",
      method: "POST",
      path: "/composition/tempocontroller/resync",
      safe: true,
      notes: "Beat phase realign — visible but harmless during testing.",
    },
    {
      id: "#12",
      method: "PUT",
      path: "/composition/crossfader/phase",
      safe: true,
      getBody: async () => {
        const c = await readComp();
        const current = c?.crossfader?.phase?.value ?? 0;
        return { value: typeof current === "number" ? current : 0 };
      },
      notes: "Deep PUT with current phase — no-op write if endpoint exists.",
    },
  ]);
}

/** @returns {Promise<{ status: number; statusText: string; body: string }>} */
async function probe(/** @type {Probe} */ p) {
  /** @type {RequestInit} */
  const init = { method: p.method, headers: {} };
  if (p.getBody) {
    const body = await p.getBody();
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`${BASE}${p.path}`, init);
  let text = "";
  try {
    text = await res.text();
  } catch {}
  return { status: res.status, statusText: res.statusText, body: text.slice(0, 200) };
}

function classify(/** @type {number} */ status) {
  if (status === 200 || status === 204) return "EXISTS";
  if (status === 404) return "NOT_FOUND";
  if (status === 405) return "WRONG_METHOD";
  if (status >= 400 && status < 500) return "CLIENT_ERROR";
  if (status >= 500) return "SERVER_ERROR";
  return "OTHER";
}

async function main() {
  // Quick liveness check. /composition must be GET-able and JSON; if the
  // server returns 404 it's almost certainly NOT Resolume (some other service
  // is bound to the port). Distinguish "not running" (network error) from
  // "wrong service" (404) for clearer triage.
  try {
    const ping = await fetch(`${BASE}/composition`, { signal: AbortSignal.timeout(3000) });
    if (ping.status === 404) {
      console.error(`Got 404 on ${BASE}/composition — port ${PORT} appears to be bound by a different service.`);
      console.error("Stop the other service or pick the correct host/port. (Resolume returns 200 with JSON on /composition.)");
      process.exit(2);
    }
    if (!ping.ok) {
      console.error(`Resolume responded ${ping.status} on /composition. Is the Web Server enabled?`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`Cannot reach ${BASE}/composition:`, err?.message ?? err);
    console.error("Is Resolume running with Preferences > Web Server > Enable Webserver & REST API on?");
    process.exit(2);
  }

  /** @type {Array<{p: Probe; result: { status: number; statusText: string; body: string } | null; skipped?: string; verdict: string }>} */
  const rows = [];
  for (const p of probes(readComposition)) {
    if (!p.safe) {
      rows.push({ p, result: null, skipped: p.notes, verdict: "SKIPPED" });
      continue;
    }
    try {
      const r = await probe(p);
      rows.push({ p, result: r, verdict: classify(r.status) });
    } catch (err) {
      rows.push({
        p,
        result: { status: 0, statusText: String(err?.message ?? err), body: "" },
        verdict: "NETWORK_ERROR",
      });
    }
  }

  // Render markdown table.
  console.log("| # | method | path | status | verdict | notes |");
  console.log("|---|--------|------|--------|---------|-------|");
  for (const { p, result, skipped, verdict } of rows) {
    const status = result ? `${result.status} ${result.statusText}` : "—";
    const notes = skipped ?? p.notes ?? "";
    console.log(
      `| ${p.id} | ${p.method} | \`${p.path}\` | ${status} | ${verdict} | ${notes} |`
    );
  }

  console.log("");
  console.log("**Legend**:");
  console.log("- `EXISTS` (200/204) — endpoint accepted the request; safe to convert.");
  console.log("- `NOT_FOUND` (404) — path doesn't exist; do NOT convert. Mark catalog CONFIRMED NEGATIVE.");
  console.log("- `WRONG_METHOD` (405) — path exists but method is wrong; investigate alternate verbs.");
  console.log("- `CLIENT_ERROR` (4xx) — payload shape may be wrong, but path exists; review body.");
  console.log("- `SKIPPED` — destructive probe; rerun with --allow-wipe on a fresh empty composition.");
}

main().catch((err) => {
  console.error("probe-subendpoints failed:", err);
  process.exit(1);
});
