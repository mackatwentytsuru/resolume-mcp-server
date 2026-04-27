#!/usr/bin/env node
// @ts-check
/**
 * check-skill-sync.mjs
 *
 * Verifies that the bundled `resolume-mcp-tester` skill catalog stays in
 * lockstep with the registered tools in `src/tools/index.ts`.
 *
 * Strategy:
 *   1. Parse `src/tools/index.ts` for the import paths of every tool that is
 *      passed to `eraseTool(...)` in the `allTools` array.
 *   2. Read each referenced tool source file and extract the
 *      `name: "resolume_*"` literal — these are the names the MCP server
 *      actually exposes.
 *   3. Read `skills/resolume-mcp-tester/SKILL.md` and harvest every tool name
 *      mentioned, supporting two surface forms:
 *        - full prefix:    `resolume_get_composition`
 *        - short form:     `get_composition` (used in the compact catalog
 *          tables/lists). The short form expansion also covers compound
 *          shorthands such as `set_clip_play_direction|mode|position`, which
 *          stand for three separate tool names sharing the `set_clip_play_`
 *          prefix.
 *   4. Diff the two sets and report:
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

const TOOLS_INDEX_PATH = join(repoRoot, "src", "tools", "index.ts");
const SKILL_PATH = join(
  repoRoot,
  "skills",
  "resolume-mcp-tester",
  "SKILL.md"
);

/**
 * Parse `src/tools/index.ts` and return the absolute paths of every tool
 * source file referenced via an import statement that supplies a symbol used
 * inside the `allTools` array.
 */
function collectToolSourcePaths(indexSource) {
  // Identifiers that appear inside `eraseTool(...)` calls within the
  // `allTools` array. Capturing this set lets us ignore unrelated imports.
  const usedIdents = new Set();
  const eraseRe = /eraseTool\(\s*([A-Za-z0-9_]+)\s*\)/g;
  let m;
  while ((m = eraseRe.exec(indexSource)) !== null) {
    usedIdents.add(m[1]);
  }

  // Map identifier -> import path. Handle both single and grouped imports:
  //   import { foo } from "./a.js";
  //   import { foo, bar } from "./b.js";
  //   import {
  //     foo,
  //     bar,
  //   } from "./c.js";
  const importRe = /import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  const identToPath = new Map();
  let im;
  while ((im = importRe.exec(indexSource)) !== null) {
    const names = im[1]
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      // strip `as Alias` if present and use the local alias
      .map((n) => {
        const parts = n.split(/\s+as\s+/);
        return parts[parts.length - 1].trim();
      });
    const importPath = im[2];
    for (const name of names) {
      identToPath.set(name, importPath);
    }
  }

  const sourcePaths = new Set();
  for (const ident of usedIdents) {
    const importPath = identToPath.get(ident);
    if (!importPath) {
      throw new Error(
        `check-skill-sync: identifier '${ident}' is used in allTools but no matching import was found in src/tools/index.ts`
      );
    }
    // TS source files are `.ts`, but imports use `.js` extensions for ESM
    // output. Resolve relative to the index file and rewrite the extension.
    const resolved = resolve(
      dirname(TOOLS_INDEX_PATH),
      importPath.replace(/\.js$/, ".ts")
    );
    sourcePaths.add(resolved);
  }
  return sourcePaths;
}

/**
 * Extract every `name: "resolume_*"` literal from a tool source file. A single
 * file can declare multiple tools (e.g. `transport.ts` exports three).
 */
function extractToolNamesFromSource(source) {
  const names = new Set();
  const nameRe = /name:\s*"(resolume_[a-z0-9_]+)"/g;
  let m;
  while ((m = nameRe.exec(source)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Walk every tool source file referenced by the registry and return the union
 * of every tool name they expose.
 */
function collectRegisteredToolNames() {
  if (!existsSync(TOOLS_INDEX_PATH)) {
    throw new Error(`check-skill-sync: ${TOOLS_INDEX_PATH} not found`);
  }
  const indexSource = readFileSync(TOOLS_INDEX_PATH, "utf8");
  const sourcePaths = collectToolSourcePaths(indexSource);

  const all = new Set();
  for (const p of sourcePaths) {
    if (!existsSync(p)) {
      throw new Error(`check-skill-sync: tool source ${p} not found`);
    }
    const src = readFileSync(p, "utf8");
    for (const name of extractToolNamesFromSource(src)) {
      all.add(name);
    }
  }
  return all;
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

  if (failed) {
    console.error(
      "\nFix the skill or the registry so they agree, then re-run `node scripts/check-skill-sync.mjs`."
    );
    process.exit(1);
  }

  console.log("OK: SKILL.md is in sync with src/tools/index.ts");
}

main();
