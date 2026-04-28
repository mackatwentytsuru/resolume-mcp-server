#!/usr/bin/env node
// @ts-check
/**
 * gen-tool-index.mjs
 *
 * Build-time codegen for the Resolume MCP tool registry.
 *
 * Walks `src/tools/<domain>/<verb-noun>.ts` files, parses the
 * `export const xxxTool: ToolDefinition<...>` declarations and the
 * `name: "resolume_..."` literal inside each, and emits two artifacts:
 *
 *   1. `src/tools/index.generated.ts` — a TypeScript module that imports
 *      every tool symbol and exports an `allTools` array. The file is
 *      committed so that PR diffs visibly show new tools landing.
 *   2. `src/tools/tool-manifest.json` — a structured manifest consumed by
 *      tests (and, in a later phase, by `check-skill-sync.mjs`). Sorted
 *      keys, 2-space indent, deterministic order.
 *
 * Validation rules (build fails on any violation):
 *   - File must export at least one symbol matching /^[a-z][A-Za-z0-9]*Tool$/.
 *   - Each exported tool must have name === "resolume_<snake_case>".
 *   - Names must be unique across the entire tree.
 *   - `stability:` literal, when present, must be "stable" | "beta" | "alpha".
 *   - `deprecated.since`, when present, must be a semver string (e.g. "0.5.0").
 *
 * Modes:
 *   default        write generated files
 *   --check        regenerate in memory, diff against committed files,
 *                  exit non-zero if drift is detected
 *   --dry-run      print generated files to stdout (used by tests)
 *
 * Determinism:
 *   - Glob results sorted lexicographically by path before processing.
 *   - JSON manifest sorted (tools sorted by name) with 2-space indent.
 *   - Banner timestamp deliberately omitted to keep diffs stable.
 *
 * Pure Node (fs.glob from Node 22) + regex — no external deps. Runs in <1s.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { glob, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const TOOLS_DIR = join(repoRoot, "src", "tools");
const GENERATED_TS = join(TOOLS_DIR, "index.generated.ts");
const MANIFEST_JSON = join(TOOLS_DIR, "tool-manifest.json");

const args = new Set(process.argv.slice(2));
const MODE_CHECK = args.has("--check");
const MODE_DRY_RUN = args.has("--dry-run");

/**
 * Stable POSIX-style relative path (forward slashes) from the repo root.
 * Manifest paths must be platform-independent so diffs are stable on
 * Windows and Unix alike.
 *
 * @param {string} absPath
 */
function repoRelPosix(absPath) {
  return relative(repoRoot, absPath).split(/[\\/]/).join("/");
}

/**
 * Locate every candidate tool source file under src/tools/.
 *
 * Excludes:
 *   - types.ts (definitions, not a tool)
 *   - test-helpers.ts and *.test.ts (tests)
 *   - index*.ts (registry/aggregator files — generated or manual)
 *   - leading-underscore files (convention for private helpers)
 *
 * Sorted lexicographically for deterministic output.
 *
 * @returns {Promise<string[]>} absolute paths
 */
async function findToolSourceFiles() {
  const collected = new Set();

  // Prefer fs.glob (Node 22+) for clarity. Fall back to manual recursion if
  // the platform's glob behavior surprises us.
  try {
    /** @type {AsyncIterable<string>} */
    const it = glob("**/*.ts", { cwd: TOOLS_DIR });
    for await (const rel of it) {
      collected.add(join(TOOLS_DIR, rel));
    }
  } catch {
    await walkDir(TOOLS_DIR, collected);
  }

  const filtered = [...collected].filter((p) => {
    const name = basename(p);
    if (name === "types.ts") return false;
    if (name === "registry.ts") return false;
    if (name === "test-helpers.ts") return false;
    if (name.endsWith(".test.ts")) return false;
    if (name.startsWith("index")) return false;
    if (name.startsWith("_")) return false;
    return true;
  });

  filtered.sort();
  return filtered;
}

/**
 * Recursive readdir fallback for environments lacking fs.glob.
 *
 * @param {string} dir
 * @param {Set<string>} out
 */
async function walkDir(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.add(full);
    }
  }
}

/**
 * @typedef {Object} DeprecationInfo
 * @property {string} since
 * @property {string=} replaceWith
 * @property {string=} removeIn
 * @property {string=} reason
 */

/**
 * @typedef {Object} ToolEntry
 * @property {string} symbol
 * @property {string} name
 * @property {boolean} destructive
 * @property {string} file
 * @property {"stable"|"beta"|"alpha"} stability
 * @property {DeprecationInfo=} deprecated
 */

/**
 * Extract a single string literal property from an object body. Returns the
 * captured value or null if the key is absent / empty.
 *
 * @param {string} body
 * @param {string} key
 * @returns {string | null}
 */
function extractStringLiteral(body, key) {
  const re = new RegExp(`${key}\\s*:\\s*"([^"]*)"`);
  const m = re.exec(body);
  return m ? m[1] : null;
}

/**
 * Extract the `deprecated: { ... }` block from a tool body and parse it into
 * a structured DeprecationInfo. Tolerates trailing commas, single/double
 * quoting, and missing optional keys. Returns undefined when the key is
 * absent (the tool is not deprecated).
 *
 * @param {string} body
 * @returns {DeprecationInfo | undefined}
 */
function extractDeprecatedBlock(body) {
  // Match `deprecated: { ... }` at the property-position level. The inner
  // braces are not nested in real-world tool files, so a non-greedy match
  // up to the next `}` is sufficient. If we ever embed nested objects we
  // should switch to a proper bracket counter.
  const re = /deprecated\s*:\s*\{([\s\S]*?)\}/;
  const m = re.exec(body);
  if (!m) return undefined;
  const inner = m[1];

  const since = extractStringLiteral(inner, "since");
  if (!since) {
    throw new Error(
      "deprecated block is missing required `since:` string literal"
    );
  }
  /** @type {DeprecationInfo} */
  const info = { since };
  const replaceWith = extractStringLiteral(inner, "replaceWith");
  if (replaceWith) info.replaceWith = replaceWith;
  const removeIn = extractStringLiteral(inner, "removeIn");
  if (removeIn) info.removeIn = removeIn;
  const reason = extractStringLiteral(inner, "reason");
  if (reason) info.reason = reason;
  return info;
}

/**
 * Parse a single tool source file. Returns one entry per `xxxTool` export
 * found, since some files (e.g. clip/clear-clip.ts) export multiple tools.
 *
 * @param {string} absPath
 * @returns {ToolEntry[]}
 */
function parseToolFile(absPath) {
  const source = readFileSync(absPath, "utf8");
  const fileRel = repoRelPosix(absPath);

  // Match `export const xxxTool: ToolDefinition<...> = { ... };`
  // We capture the symbol name and then parse the object body that follows
  // it to find the `name:` literal and `destructive:` flag belonging to
  // *this* declaration.
  //
  // BRITTLENESS NOTE: This is a pure regex parser, not a real TS AST walk.
  // It will misparse two things if a future tool author introduces them:
  //   1. Nested object literals whose closing `};` precedes the outer one
  //      (the `[\s\S]*?\n\};` non-greedy match terminates too early).
  //   2. Computed/template-literal property names for `name:`,
  //      `stability:`, etc. (the inner `extractStringLiteral` helper only
  //      matches plain `"..."` literals).
  // Both cases are caught at CI time by `npm run check:tools` which
  // regenerates and diffs against the committed manifest — drift fails
  // the build before merge. If you hit either limit, switch this file to
  // a TS AST parse (e.g. via `typescript`'s compiler API).
  const declRe =
    /export\s+const\s+([a-z][A-Za-z0-9]*Tool)\s*:\s*ToolDefinition\b[^=]*=\s*(\{[\s\S]*?\n\};)/g;

  /** @type {ToolEntry[]} */
  const found = [];
  let m;
  while ((m = declRe.exec(source)) !== null) {
    const symbol = m[1];
    const body = m[2];

    const nameMatch = /name\s*:\s*"(resolume_[a-z][a-z0-9_]*)"/.exec(body);
    if (!nameMatch) {
      throw new Error(
        `gen-tool-index: ${fileRel} exports ${symbol} but its body does not contain a 'name: "resolume_..."' literal`
      );
    }
    const name = nameMatch[1];

    const destructive = /destructive\s*:\s*true\b/.test(body);

    // Stability literal — defaults to "stable" when absent.
    /** @type {"stable" | "beta" | "alpha"} */
    let stability = "stable";
    const stabilityMatch = /stability\s*:\s*"([a-z]+)"/.exec(body);
    if (stabilityMatch) {
      const v = stabilityMatch[1];
      if (v !== "stable" && v !== "beta" && v !== "alpha") {
        throw new Error(
          `gen-tool-index: ${fileRel} exports ${symbol} with invalid stability '${v}'. Expected "stable" | "beta" | "alpha".`
        );
      }
      stability = v;
    }

    let deprecated;
    try {
      deprecated = extractDeprecatedBlock(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `gen-tool-index: ${fileRel} exports ${symbol} with malformed deprecated block — ${msg}`
      );
    }
    if (deprecated) {
      // semver: MAJOR.MINOR.PATCH with optional pre-release / build suffix.
      const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
      if (!SEMVER.test(deprecated.since)) {
        throw new Error(
          `gen-tool-index: ${fileRel} exports ${symbol} with invalid deprecated.since '${deprecated.since}'. Expected a semver string like "0.5.0".`
        );
      }
      if (deprecated.removeIn !== undefined && !SEMVER.test(deprecated.removeIn)) {
        throw new Error(
          `gen-tool-index: ${fileRel} exports ${symbol} with invalid deprecated.removeIn '${deprecated.removeIn}'. Expected a semver string like "0.7.0".`
        );
      }
    }

    /** @type {ToolEntry} */
    const entry = { symbol, name, destructive, file: fileRel, stability };
    if (deprecated) entry.deprecated = deprecated;
    found.push(entry);
  }

  if (found.length === 0) {
    throw new Error(
      `gen-tool-index: ${fileRel} contains no 'export const xxxTool: ToolDefinition<...>' declarations. ` +
        `Move the file out of src/tools/ or rename so its export matches the convention.`
    );
  }

  return found;
}

/**
 * Validate the parsed manifest. Mirrors the three-layer convention from
 * docs/v0.5/03-tool-registry.md. Phase 0 enforces the parts that don't
 * require speculative file-path → symbol derivation.
 *
 * @param {{ symbol: string, name: string, destructive: boolean, file: string }[]} entries
 */
function validateEntries(entries) {
  // Layer 2 already enforced by the regex (export symbol matches *Tool$).

  // Layer 3: name matches resolume_<snake_case>.
  const nameRe = /^resolume_[a-z][a-z0-9_]*$/;
  for (const e of entries) {
    if (!nameRe.test(e.name)) {
      throw new Error(
        `gen-tool-index: ${e.file} declares invalid tool name '${e.name}'. ` +
          `Expected /^resolume_[a-z][a-z0-9_]*$/.`
      );
    }
  }

  // Uniqueness: every name appears exactly once across the tree.
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.name)) {
      const prev = seen.get(e.name);
      throw new Error(
        `gen-tool-index: duplicate tool name '${e.name}' declared in ${prev} and ${e.file}.`
      );
    }
    seen.set(e.name, e.file);
  }
}

/**
 * Group manifest entries by source file so we can emit one `import` per file
 * (regardless of how many tools that file exports). Imports are emitted in
 * sorted order by file path; symbols within a single import are also sorted.
 *
 * @param {{ symbol: string, name: string, destructive: boolean, file: string }[]} entries
 * @returns {{ file: string, symbols: string[] }[]}
 */
function groupBySourceFile(entries) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.file)) map.set(e.file, new Set());
    map.get(e.file).add(e.symbol);
  }
  const grouped = [...map.entries()]
    .map(([file, syms]) => ({
      file,
      symbols: [...syms].sort(),
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return grouped;
}

/**
 * Build the TypeScript source for index.generated.ts.
 *
 * @param {{ file: string, symbols: string[] }[]} grouped
 * @param {{ symbol: string, name: string, destructive: boolean, file: string }[]} entries
 */
function renderGeneratedTs(grouped, entries) {
  const lines = [];
  lines.push("// AUTO-GENERATED by scripts/gen-tool-index.mjs — DO NOT EDIT");
  lines.push("// Run `npm run gen:tools` to refresh.");
  lines.push("");
  lines.push('import { eraseTool, type AnyTool } from "./registry.js";');
  for (const g of grouped) {
    // src/tools/clip/trigger-clip.ts → ./clip/trigger-clip.js
    const rel = g.file.replace(/^src\/tools\//, "./").replace(/\.ts$/, ".js");
    if (g.symbols.length === 1) {
      lines.push(`import { ${g.symbols[0]} } from "${rel}";`);
    } else {
      lines.push("import {");
      for (const s of g.symbols) lines.push(`  ${s},`);
      lines.push(`} from "${rel}";`);
    }
  }
  lines.push("");
  lines.push("export const allTools: ReadonlyArray<AnyTool> = [");
  // Stable order: by file path (already sorted in `entries` via the original
  // sort plus the regex-walk order). Within a file, declaration order is
  // preserved by parseToolFile.
  for (const e of entries) {
    lines.push(`  eraseTool(${e.symbol}),`);
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the JSON manifest payload. Tools sorted alphabetically by name so
 * diffs are line-local even when two PRs add tools in adjacent slots.
 *
 * The `stability` field is always present (defaulting to `"stable"`) so the
 * downstream consumer never has to handle `undefined`. `deprecated` is only
 * emitted when the tool actually carries a deprecation marker.
 *
 * @param {ToolEntry[]} entries
 */
function renderManifestJson(entries) {
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  const payload = {
    count: sorted.length,
    tools: sorted.map((e) => {
      /** @type {Record<string, unknown>} */
      const tool = {
        destructive: e.destructive,
        file: e.file,
        name: e.name,
        stability: e.stability,
        symbol: e.symbol,
      };
      if (e.deprecated) {
        // Sort the deprecation keys alphabetically for stable diffs.
        /** @type {Record<string, string>} */
        const dep = {};
        for (const k of /** @type {const} */ (["reason", "removeIn", "replaceWith", "since"])) {
          const v = e.deprecated[k];
          if (v !== undefined) dep[k] = v;
        }
        tool.deprecated = dep;
      }
      return tool;
    }),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

/**
 * Compute the file content the user is about to commit (or what's already
 * committed) using the same byte-exact comparison the --check mode needs.
 *
 * @param {string} path
 */
function readIfExists(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

async function main() {
  const t0 = Date.now();

  const sourceFiles = await findToolSourceFiles();
  /** @type {{ symbol: string, name: string, destructive: boolean, file: string }[]} */
  const entries = [];
  for (const f of sourceFiles) {
    for (const e of parseToolFile(f)) {
      entries.push(e);
    }
  }

  validateEntries(entries);

  const grouped = groupBySourceFile(entries);
  const tsOut = renderGeneratedTs(grouped, entries);
  const jsonOut = renderManifestJson(entries);

  if (MODE_DRY_RUN) {
    process.stdout.write("=== index.generated.ts ===\n");
    process.stdout.write(tsOut);
    process.stdout.write("\n=== tool-manifest.json ===\n");
    process.stdout.write(jsonOut);
    return;
  }

  if (MODE_CHECK) {
    const tsCurrent = readIfExists(GENERATED_TS);
    const jsonCurrent = readIfExists(MANIFEST_JSON);
    const drift = [];
    if (tsCurrent !== tsOut) drift.push(repoRelPosix(GENERATED_TS));
    if (jsonCurrent !== jsonOut) drift.push(repoRelPosix(MANIFEST_JSON));
    if (drift.length > 0) {
      console.error(
        `gen-tool-index: drift detected in ${drift.join(
          ", "
        )}. Run \`npm run gen:tools\` and commit the result.`
      );
      process.exit(1);
    }
    const ms = Date.now() - t0;
    console.log(
      `gen-tool-index: ${entries.length} tools, generated files up to date (${ms}ms)`
    );
    return;
  }

  writeFileSync(GENERATED_TS, tsOut);
  writeFileSync(MANIFEST_JSON, jsonOut);
  const ms = Date.now() - t0;
  console.log(
    `gen-tool-index: wrote ${repoRelPosix(GENERATED_TS)} and ${repoRelPosix(
      MANIFEST_JSON
    )} (${entries.length} tools, ${ms}ms)`
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
