import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allTools as manualAllTools } from "./index.js";
import { allTools as generatedAllTools } from "./index.generated.js";

/**
 * Phase 0 parity tests for the convention-based codegen.
 *
 * These tests prove that the generated `index.generated.ts` and the
 * committed `tool-manifest.json` describe exactly the same surface as the
 * existing manual `index.ts`. They are the safety net that lets a future
 * PR flip the import in `registerTools.ts` confident that nothing changes.
 *
 * See `docs/v0.5/03-tool-registry.md` (Migration plan, Phase 0) for the
 * larger story.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, "tool-manifest.json");

interface ManifestEntry {
  name: string;
  symbol: string;
  file: string;
  destructive: boolean;
}

interface Manifest {
  count: number;
  tools: ManifestEntry[];
}

function loadManifest(): Manifest {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw) as Manifest;
}

const NAME_PATTERN = /^resolume_[a-z][a-z0-9_]*$/;

describe("tool registry — codegen parity (Phase 0)", () => {
  it("generated allTools has the same length as the manual allTools", () => {
    expect(generatedAllTools.length).toBe(manualAllTools.length);
  });

  it("generated allTools exposes the same set of tool names as the manual allTools", () => {
    const manualNames = new Set(manualAllTools.map((t) => t.name));
    const generatedNames = new Set(generatedAllTools.map((t) => t.name));
    expect([...generatedNames].sort()).toEqual([...manualNames].sort());
  });

  it("manifest count matches generated allTools.length", () => {
    const manifest = loadManifest();
    expect(manifest.count).toBe(generatedAllTools.length);
    expect(manifest.tools.length).toBe(manifest.count);
  });

  it("manifest tool names equal the generated allTools names", () => {
    const manifest = loadManifest();
    const manifestNames = new Set(manifest.tools.map((t) => t.name));
    const generatedNames = new Set(generatedAllTools.map((t) => t.name));
    expect([...manifestNames].sort()).toEqual([...generatedNames].sort());
  });

  it("every tool name follows the resolume_<snake_case> convention", () => {
    for (const tool of manualAllTools) {
      expect(tool.name).toMatch(NAME_PATTERN);
    }
    for (const tool of generatedAllTools) {
      expect(tool.name).toMatch(NAME_PATTERN);
    }
    const manifest = loadManifest();
    for (const entry of manifest.tools) {
      expect(entry.name).toMatch(NAME_PATTERN);
    }
  });

  it("tool names are unique within each registry", () => {
    const manualNames = manualAllTools.map((t) => t.name);
    expect(new Set(manualNames).size).toBe(manualNames.length);

    const generatedNames = generatedAllTools.map((t) => t.name);
    expect(new Set(generatedNames).size).toBe(generatedNames.length);

    const manifest = loadManifest();
    const manifestNames = manifest.tools.map((t) => t.name);
    expect(new Set(manifestNames).size).toBe(manifestNames.length);
  });

  it("manifest preserves the destructive flag for every tool", () => {
    const manifest = loadManifest();
    const manualByName = new Map(manualAllTools.map((t) => [t.name, t]));
    for (const entry of manifest.tools) {
      const manualTool = manualByName.get(entry.name);
      expect(manualTool, `manifest tool ${entry.name} missing from manual registry`).toBeDefined();
      const manualDestructive = Boolean(manualTool!.destructive);
      expect(entry.destructive).toBe(manualDestructive);
    }
  });
});
