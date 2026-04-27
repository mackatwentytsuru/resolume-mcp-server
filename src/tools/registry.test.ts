import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allTools } from "./index.generated.js";
import {
  filterByStability,
  parseStability,
  type AnyTool,
} from "./registry.js";

/**
 * Phase 1 manifest integrity tests.
 *
 * Phase 0 used these to assert that the generated registry equalled the
 * manual one. Now that `index.ts` is a thin re-export over
 * `index.generated.ts`, equality is trivially true. The remaining job is to
 * make sure the manifest stays consistent with what the runtime actually
 * exposes — count, name pattern, uniqueness, and that every file path the
 * manifest claims still exists on disk.
 *
 * See `docs/v0.5/03-tool-registry.md` (Migration plan, Phase 1) for context.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, "tool-manifest.json");
const REPO_ROOT = resolve(__dirname, "..", "..");

interface ManifestEntry {
  name: string;
  symbol: string;
  file: string;
  destructive: boolean;
  stability: "stable" | "beta" | "alpha";
  deprecated?: {
    since: string;
    replaceWith?: string;
    removeIn?: string;
    reason?: string;
  };
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

describe("tool registry — manifest integrity (Phase 1)", () => {
  it("manifest count matches runtime allTools.length", () => {
    const manifest = loadManifest();
    expect(manifest.count).toBe(allTools.length);
    expect(manifest.tools.length).toBe(manifest.count);
  });

  it("manifest tool names equal the runtime allTools names", () => {
    const manifest = loadManifest();
    const manifestNames = new Set(manifest.tools.map((t) => t.name));
    const runtimeNames = new Set(allTools.map((t) => t.name));
    expect([...manifestNames].sort()).toEqual([...runtimeNames].sort());
  });

  it("every tool name follows the resolume_<snake_case> convention", () => {
    for (const tool of allTools) {
      expect(tool.name).toMatch(NAME_PATTERN);
    }
    const manifest = loadManifest();
    for (const entry of manifest.tools) {
      expect(entry.name).toMatch(NAME_PATTERN);
    }
  });

  it("tool names are unique within the runtime registry", () => {
    const runtimeNames = allTools.map((t) => t.name);
    expect(new Set(runtimeNames).size).toBe(runtimeNames.length);
  });

  it("tool names are unique within the manifest", () => {
    const manifest = loadManifest();
    const manifestNames = manifest.tools.map((t) => t.name);
    expect(new Set(manifestNames).size).toBe(manifestNames.length);
  });

  it("every file path the manifest references exists on disk", () => {
    const manifest = loadManifest();
    for (const entry of manifest.tools) {
      const abs = resolve(REPO_ROOT, entry.file);
      expect(
        existsSync(abs),
        `manifest references missing file ${entry.file}`
      ).toBe(true);
    }
  });

  it("every manifest entry carries a valid stability tier", () => {
    const manifest = loadManifest();
    const allowed = new Set(["stable", "beta", "alpha"]);
    for (const entry of manifest.tools) {
      expect(
        allowed.has(entry.stability),
        `manifest tool ${entry.name} has invalid stability '${entry.stability}'`
      ).toBe(true);
    }
  });

  it("every deprecated entry carries a semver-shaped since field", () => {
    const manifest = loadManifest();
    const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    for (const entry of manifest.tools) {
      if (entry.deprecated) {
        expect(entry.deprecated.since).toMatch(SEMVER);
        if (entry.deprecated.removeIn !== undefined) {
          expect(entry.deprecated.removeIn).toMatch(SEMVER);
        }
      }
    }
  });

  it("manifest preserves the destructive flag for every runtime tool", () => {
    const manifest = loadManifest();
    const runtimeByName = new Map(allTools.map((t) => [t.name, t]));
    for (const entry of manifest.tools) {
      const runtimeTool = runtimeByName.get(entry.name);
      expect(
        runtimeTool,
        `manifest tool ${entry.name} missing from runtime registry`
      ).toBeDefined();
      const runtimeDestructive = Boolean(runtimeTool!.destructive);
      expect(entry.destructive).toBe(runtimeDestructive);
    }
  });
});

/**
 * Phase 2 — `parseStability` env coercion. Treats malformed input as
 * `"beta"` (the default deploy posture) and writes a warning to stderr so
 * an operator can spot a typo.
 */
describe("parseStability", () => {
  it("returns 'beta' when the env var is undefined", () => {
    expect(parseStability(undefined)).toBe("beta");
  });

  it("returns 'beta' when the env var is empty", () => {
    expect(parseStability("")).toBe("beta");
  });

  it("accepts each canonical tier name verbatim", () => {
    expect(parseStability("stable")).toBe("stable");
    expect(parseStability("beta")).toBe("beta");
    expect(parseStability("alpha")).toBe("alpha");
  });

  it("normalises mixed case and surrounding whitespace", () => {
    expect(parseStability(" Stable ")).toBe("stable");
    expect(parseStability("BETA")).toBe("beta");
    expect(parseStability("Alpha\n")).toBe("alpha");
  });

  it("falls back to 'beta' and warns on stderr for unknown values", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(parseStability("foo")).toBe("beta");
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const msg = String(writeSpy.mock.calls[0][0]);
      expect(msg).toContain("RESOLUME_TOOLS_STABILITY='foo'");
      expect(msg).toContain("'beta'");
    } finally {
      writeSpy.mockRestore();
    }
  });
});

/**
 * Phase 2 — `filterByStability` semantics. The runtime visibility filter
 * has to be exact about which tier admits which tool because operators
 * may rely on `RESOLUME_TOOLS_STABILITY=stable` to hide experimental
 * surface from production sessions.
 */
describe("filterByStability", () => {
  function fakeTool(name: string, stability: AnyTool["stability"]): AnyTool {
    return {
      name,
      title: name,
      description: `desc ${name}`,
      inputSchema: {},
      stability,
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
  }

  const stable = fakeTool("stable_tool", "stable");
  const beta = fakeTool("beta_tool", "beta");
  const alpha = fakeTool("alpha_tool", "alpha");
  const all = [stable, beta, alpha] as const;

  it("'stable' filter exposes only stable tools", () => {
    const out = filterByStability(all, "stable");
    expect(out.map((t) => t.name)).toEqual(["stable_tool"]);
  });

  it("'beta' filter exposes stable + beta and hides alpha", () => {
    const out = filterByStability(all, "beta");
    expect(out.map((t) => t.name)).toEqual(["stable_tool", "beta_tool"]);
  });

  it("'alpha' filter exposes every tier", () => {
    const out = filterByStability(all, "alpha");
    expect(out.map((t) => t.name)).toEqual([
      "stable_tool",
      "beta_tool",
      "alpha_tool",
    ]);
  });

  it("treats a missing stability field as 'stable'", () => {
    // Construct an AnyTool-ish object that lacks stability to exercise the
    // defensive ?? "stable" branch inside filterByStability.
    const looseStable = {
      ...stable,
      stability: undefined as unknown as AnyTool["stability"],
    } as AnyTool;
    const out = filterByStability([looseStable, beta, alpha], "stable");
    expect(out.map((t) => t.name)).toEqual(["stable_tool"]);
  });
});
