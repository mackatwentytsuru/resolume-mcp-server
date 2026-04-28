#!/usr/bin/env node
// @ts-check
/**
 * check-skill-sync.mjs
 *
 * Verifies that the bundled `resolume-mcp-tester` skill catalog stays in
 * lockstep with the registered tools.
 *
 * Strategy (Phase 1, manifest-driven):
 *   1. Read `src/tools/tool-manifest.json` (produced by gen-tool-index.mjs)
 *      and harvest every tool name from `manifest.tools[].name`. The
 *      manifest is the single source of truth — if it is missing, we tell
 *      the contributor to run `npm run gen:tools` first.
 *   2. Read `skills/resolume-mcp-tester/SKILL.md` and harvest every tool
 *      name mentioned, supporting two surface forms:
 *        - full prefix:    `resolume_get_composition`
 *        - short form:     `get_composition` (used in the compact catalog
 *          tables/lists). The short form expansion also covers compound
 *          shorthands such as `set_clip_play_direction|mode|position`, which
 *          stand for three separate tool names sharing the `set_clip_play_`
 *          prefix.
 *   3. Diff the two sets and report:
 *        - tools registered in code but missing from SKILL.md
 *        - tools mentioned in SKILL.md that no longer exist in code
 *        - tool-count mismatch vs the "(N tools)" callouts in SKILL.md
 *
 * Exits non-zero on any mismatch so this can be wired into CI / prepublishOnly.
 *
 * Pure Node + fs + regex — no external dependencies, runs in <2s.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const MANIFEST_PATH = join(repoRoot, "src", "tools", "tool-manifest.json");
const SKILL_PATH = join(
  repoRoot,
  "skills",
  "resolume-mcp-tester",
  "SKILL.md"
);
const PACKAGE_PATH = join(repoRoot, "package.json");

/**
 * Read the generated tool manifest and return the set of every tool name
 * the server registers. The manifest is produced by
 * `scripts/gen-tool-index.mjs` and is the single source of truth as of
 * v0.5 Phase 1 — see `docs/v0.5/03-tool-registry.md`.
 */
function collectRegisteredToolNames() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(
      "check-skill-sync: tool-manifest.json missing — run `npm run gen:tools` first"
    );
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest || !Array.isArray(manifest.tools)) {
    throw new Error(
      "check-skill-sync: tool-manifest.json is malformed (missing `tools` array) — run `npm run gen:tools` to regenerate"
    );
  }
  return new Set(manifest.tools.map((t) => t.name));
}

/**
 * Harvest every tool name mentioned in SKILL.md.
 *
 * Two surface forms are recognised:
 *
 *   1. `resolume_xxx`         — full canonical name in code blocks/tables.
 *   2. `xxx` (short form)     — used inside the compact catalog at the top of
 *      the skill. We only treat a short token as a tool name when it is the
 *      first token after a backtick AND matches a name we already discovered
 *      in the source. This avoids accidentally promoting random words like
 *      `confirm` or `effects`.
 *
 * Compact pipe shorthands such as `set_clip_play_direction|mode|position` are
 * expanded into three separate names by inheriting the `set_clip_play_`
 * prefix from the leftmost token.
 */
function collectMentionedToolNames(skillSource, registered) {
  const mentioned = new Set();

  // Pass 1: full `resolume_xxx` mentions anywhere in the file.
  const fullRe = /resolume_[a-z0-9_]+/g;
  let m;
  while ((m = fullRe.exec(skillSource)) !== null) {
    mentioned.add(m[0]);
  }

  // Pass 2: backticked short-form tokens. We grab any backticked literal that
  // looks like a tool slug, optionally followed by a pipe-shorthand list.
  const shortRe = /`([a-z][a-z0-9_]*(?:\|[a-z0-9_]+)*)`/g;
  while ((m = shortRe.exec(skillSource)) !== null) {
    const token = m[1];
    if (token.startsWith("resolume_")) {
      // already harvested above — skip
      continue;
    }
    const parts = token.split("|");
    const head = parts[0];
    const candidates = [`resolume_${head}`];

    // pipe shorthand expansion: derive prefix from the leftmost token.
    // e.g. `set_clip_play_direction|mode|position`
    //   head            = "set_clip_play_direction"
    //   prefix          = "set_clip_play_"
    //   tail tokens     -> "set_clip_play_mode", "set_clip_play_position"
    if (parts.length > 1) {
      const lastUnderscore = head.lastIndexOf("_");
      const prefix = lastUnderscore >= 0 ? head.slice(0, lastUnderscore + 1) : "";
      for (let i = 1; i < parts.length; i++) {
        candidates.push(`resolume_${prefix}${parts[i]}`);
      }
    }

    for (const c of candidates) {
      if (registered.has(c)) {
        mentioned.add(c);
      }
    }
  }

  return mentioned;
}

/**
 * Find every "(N tools)" or "N tools" callout in the SKILL and return the
 * numbers it claims. Used to flag count drift even when individual names are
 * fine.
 */
function collectClaimedCounts(skillSource) {
  const counts = new Set();
  const re = /(\d+)\s+tools/g;
  let m;
  while ((m = re.exec(skillSource)) !== null) {
    counts.add(Number(m[1]));
  }
  return counts;
}

/**
 * Find every "(vX.Y.Z — N tools)" or "Tool catalog (vX.Y.Z — ...)" version
 * callout in the SKILL and return the version strings it claims. Used to
 * flag *version* drift, separate from tool-count drift — e.g. a SKILL.md
 * saying "v0.5.1" while the package is at v0.5.4.
 */
function collectClaimedVersions(skillSource) {
  const versions = new Set();
  const re = /v(\d+\.\d+\.\d+)\s*—\s*\d+\s*tools/g;
  let m;
  while ((m = re.exec(skillSource)) !== null) {
    versions.add(m[1]);
  }
  return versions;
}

function main() {
  const t0 = Date.now();

  const registered = collectRegisteredToolNames();
  if (!existsSync(SKILL_PATH)) {
    console.error(`check-skill-sync: SKILL.md not found at ${SKILL_PATH}`);
    process.exit(2);
  }
  const skillSource = readFileSync(SKILL_PATH, "utf8");
  const mentioned = collectMentionedToolNames(skillSource, registered);
  const claimedCounts = collectClaimedCounts(skillSource);
  const claimedVersions = collectClaimedVersions(skillSource);
  const pkgVersion = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version;

  const missingFromSkill = [...registered]
    .filter((n) => !mentioned.has(n))
    .sort();
  const extraInSkill = [...mentioned]
    .filter((n) => !registered.has(n))
    .sort();

  const expected = registered.size;
  const countDrift = [...claimedCounts]
    .filter((n) => n !== expected)
    .sort((a, b) => a - b);

  const ms = Date.now() - t0;
  console.log(
    `check-skill-sync: ${registered.size} tools registered, ${mentioned.size} mentioned in SKILL.md (${ms}ms)`
  );

  let failed = false;

  if (missingFromSkill.length > 0) {
    failed = true;
    console.error("\n[FAIL] Tools registered in code but missing from SKILL.md:");
    for (const n of missingFromSkill) console.error(`  - ${n}`);
  }
  if (extraInSkill.length > 0) {
    failed = true;
    console.error("\n[FAIL] Tools mentioned in SKILL.md but not registered in code:");
    for (const n of extraInSkill) console.error(`  - ${n}`);
  }
  if (countDrift.length > 0) {
    failed = true;
    console.error(
      `\n[FAIL] Tool count callouts in SKILL.md disagree with registered count (${expected}):`
    );
    for (const n of countDrift) console.error(`  - SKILL.md says ${n} tools`);
  }

  // Version drift: any "vX.Y.Z — N tools" callout that disagrees with
  // package.json#version is a stale snapshot.
  const versionDrift = [...claimedVersions]
    .filter((v) => v !== pkgVersion)
    .sort();
  if (versionDrift.length > 0) {
    failed = true;
    console.error(
      `\n[FAIL] Tool catalog version callouts in SKILL.md disagree with package.json#version (${pkgVersion}):`
    );
    for (const v of versionDrift) console.error(`  - SKILL.md says v${v}`);
  }

  if (failed) {
    console.error(
      "\nFix the skill or the registry so they agree, then re-run `node scripts/check-skill-sync.mjs`."
    );
    process.exit(1);
  }

  console.log("OK: SKILL.md is in sync with tool-manifest.json");
}

main();
