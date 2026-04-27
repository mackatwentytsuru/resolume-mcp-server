import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResolumeApiError } from "../errors/types.js";
import { allTools } from "../tools/index.generated.js";
import {
  filterByStability,
  parseStability,
  type AnyTool,
} from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

/**
 * Register every Resolume MCP tool against the SDK server. The handler
 * wraps each call in a try/catch so that any ResolumeApiError is surfaced
 * to the LLM as a structured error result instead of crashing the server.
 *
 * Visibility is controlled by the `RESOLUME_TOOLS_STABILITY` env var:
 *   - `stable` exposes only stable tools.
 *   - `beta`   (default) exposes stable + beta.
 *   - `alpha`  exposes everything.
 *
 * When tools are hidden, a single line is emitted to stderr at startup so
 * an operator can see the effect of their setting.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const minTier = parseStability(process.env.RESOLUME_TOOLS_STABILITY);
  const filtered = filterByStability(allTools, minTier);
  const hiddenCount = allTools.length - filtered.length;
  if (hiddenCount > 0) {
    process.stderr.write(
      `resolume-mcp-server: tier filter = ${minTier} (${hiddenCount} ${
        hiddenCount === 1 ? "tool" : "tools"
      } hidden)\n`
    );
  }
  for (const tool of filtered) {
    registerOne(server, ctx, tool);
  }
}

function registerOne(server: McpServer, ctx: ToolContext, tool: AnyTool): void {
  // Compile the strict Zod schema once at registration time rather than on
  // every invocation, avoiding repeated z.object().strict() construction.
  const schema = z.object(tool.inputSchema).strict();
  // SDK signature: server.tool(name, description, paramsShape, handler).
  // The shape is the raw Zod object map; the SDK wraps it with z.object() internally.
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema,
    async (args: unknown) => safeHandle(tool, schema, ctx, args)
  );
}

/**
 * Module-scoped set tracking which deprecated tools have already produced
 * a stderr warning during this process. Ensures we don't spam the log on
 * every invocation of a deprecated tool.
 *
 * Exported for test reset only — production code should never read or
 * mutate it directly.
 */
export const __deprecationWarned = new Set<string>();

function warnIfDeprecated(tool: AnyTool): void {
  if (!tool.deprecated) return;
  if (__deprecationWarned.has(tool.name)) return;
  __deprecationWarned.add(tool.name);
  const dep = tool.deprecated;
  const parts = [`'${tool.name}' is deprecated since ${dep.since}`];
  if (dep.replaceWith) parts.push(`use ${dep.replaceWith} instead`);
  if (dep.removeIn) parts.push(`removed in ${dep.removeIn}`);
  if (dep.reason) parts.push(dep.reason);
  process.stderr.write(
    `[resolume-mcp-server] WARNING: tool ${parts.join(" — ")}\n`
  );
}

async function safeHandle(
  tool: AnyTool,
  schema: z.ZodObject<z.ZodRawShape>,
  ctx: ToolContext,
  rawArgs: unknown
): Promise<ToolResult> {
  warnIfDeprecated(tool);
  try {
    // The SDK already validated against the shape; we re-validate with strict
    // mode to catch unknown keys and produce a clear, schema-stable error message.
    const parsed = schema.parse(rawArgs ?? {});
    return await tool.handler(parsed, ctx);
  } catch (err) {
    return formatError(err);
  }
}

interface ErrorEnvelope {
  error: string;
  message: string;
  hint: string;
  detail?: unknown;
  issues?: { field: string; issue: string }[];
}

function formatError(err: unknown): ToolResult {
  let envelope: ErrorEnvelope;

  if (err instanceof ResolumeApiError) {
    envelope = {
      error: err.detail.kind,
      message: err.message,
      hint: "hint" in err.detail ? err.detail.hint : "",
      detail: err.detail,
    };
  } else if (err instanceof z.ZodError) {
    envelope = {
      error: "InvalidArguments",
      message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      hint: "Re-call the tool with valid arguments. See `issues` for the offending fields.",
      issues: err.issues.map((i) => ({
        field: i.path.join(".") || "(root)",
        issue: i.message,
      })),
    };
  } else {
    const message = err instanceof Error ? err.message : String(err);
    envelope = {
      error: "Unexpected",
      message,
      hint: "This is likely a bug in resolume-mcp-server. Please report it with the exact prompt and arguments.",
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
  };
}
