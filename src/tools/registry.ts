import type { z } from "zod";
import type {
  DeprecationInfo,
  Stability,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "./types.js";

/**
 * Type-erased tool entry used by the registry. We cast individual tools
 * (which have specific argument types) to this shape — TS contravariance
 * forbids assigning a narrower handler to a wider one without an explicit
 * cast, but the registry never invokes the handler with the wrong shape:
 * arguments are re-validated against the tool's inputSchema before dispatch.
 */
export interface AnyTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  destructive?: boolean;
  /** Always present after `eraseTool()` — defaults to "stable". */
  stability: Stability;
  deprecated?: DeprecationInfo;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Build the LLM-facing description string for a tool. Pure function so it
 * can be called from tests without going through `eraseTool()`.
 *
 * Semantics (`docs/v0.5/03-tool-registry.md` — Description decoration):
 *
 *   1. Tier prefix is `[BETA] ` for beta, `[ALPHA] ` for alpha, none for stable.
 *   2. Original description follows verbatim.
 *   3. Deprecation suffix is appended when `deprecated` is set:
 *        ` (deprecated since X[, use Y][, removed in Z])`.
 *
 * Stable + no deprecation returns the description byte-identical so the
 * common path stays a no-op.
 */
export function decorateDescription(
  tool: Pick<ToolDefinition, "description" | "stability" | "deprecated">
): string {
  const stability: Stability = tool.stability ?? "stable";
  let prefix = "";
  if (stability === "beta") prefix = "[BETA] ";
  else if (stability === "alpha") prefix = "[ALPHA] ";

  let suffix = "";
  if (tool.deprecated) {
    const parts = [`deprecated since ${tool.deprecated.since}`];
    if (tool.deprecated.replaceWith) {
      parts.push(`use ${tool.deprecated.replaceWith}`);
    }
    if (tool.deprecated.removeIn) {
      parts.push(`removed in ${tool.deprecated.removeIn}`);
    }
    suffix = ` (${parts.join(", ")})`;
  }

  return `${prefix}${tool.description}${suffix}`;
}

/**
 * Coerce a raw env-var value into a stability tier, defaulting to `"beta"`
 * for anything malformed or absent. Out-of-range values are reported via
 * `process.stderr` so a misconfigured operator notices their typo.
 */
export function parseStability(raw: string | undefined): Stability {
  if (raw === undefined || raw === "") return "beta";
  const normalised = raw.toLowerCase().trim();
  if (normalised === "stable" || normalised === "beta" || normalised === "alpha") {
    return normalised;
  }
  process.stderr.write(
    `[resolume-mcp-server] WARNING: RESOLUME_TOOLS_STABILITY='${raw}' is not one of stable|beta|alpha — defaulting to 'beta'.\n`
  );
  return "beta";
}

const TIER_RANK: Record<Stability, number> = {
  stable: 0,
  beta: 1,
  alpha: 2,
};

/**
 * Filter an `AnyTool` array down to tools whose stability tier is at or
 * below the provided maximum visibility level.
 *
 *   `stable` → exposes only stable.
 *   `beta`   → exposes stable + beta (default deploy posture).
 *   `alpha`  → exposes everything.
 *
 * Each tool's stability defaults to `"stable"` when missing — `eraseTool()`
 * already normalises this, but the function is defensive in case it is
 * called against a hand-rolled `AnyTool` array.
 */
export function filterByStability(
  tools: ReadonlyArray<AnyTool>,
  maxTier: Stability
): AnyTool[] {
  const ceiling = TIER_RANK[maxTier];
  return tools.filter((t) => TIER_RANK[t.stability ?? "stable"] <= ceiling);
}

/**
 * Erase the handler's specific argument type while keeping every other field
 * structurally typed. The cast is isolated to the handler — if `AnyTool` and
 * `ToolDefinition` ever drift on any other field, TypeScript will surface it
 * at this site instead of letting a malformed object slip through.
 *
 * As of v0.5, `eraseTool()` also normalises `stability` (defaulting absent
 * values to `"stable"`) and decorates the description with the
 * tier/deprecation markers so the LLM sees the final string at registration
 * time.
 */
export function eraseTool<TShape extends z.ZodRawShape>(
  tool: ToolDefinition<TShape>
): AnyTool {
  const stability: Stability = tool.stability ?? "stable";
  return {
    name: tool.name,
    title: tool.title,
    description: decorateDescription(tool),
    inputSchema: tool.inputSchema,
    destructive: tool.destructive,
    stability,
    deprecated: tool.deprecated,
    handler: tool.handler as AnyTool["handler"],
  };
}
