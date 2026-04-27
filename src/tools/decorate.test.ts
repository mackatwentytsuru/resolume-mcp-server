import { describe, it, expect } from "vitest";
import { decorateDescription, eraseTool } from "./registry.js";
import type { ToolDefinition } from "./types.js";

/**
 * Phase 2 — pure description-decoration tests.
 *
 * These exercise every combination of stability tier and deprecation
 * metadata called out in `docs/v0.5/03-tool-registry.md` (Description
 * decoration). The string format is part of the LLM-facing contract, so
 * the assertions are byte-exact on purpose.
 */

const baseTool: ToolDefinition = {
  name: "resolume_dummy",
  title: "Dummy",
  description: "Does a dummy thing.",
  inputSchema: {},
  handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

describe("decorateDescription", () => {
  it("returns the description unchanged for stable + no deprecation", () => {
    expect(decorateDescription(baseTool)).toBe("Does a dummy thing.");
  });

  it("returns the description unchanged when stability is undefined", () => {
    const { stability: _stability, ...withoutStability } = baseTool;
    expect(decorateDescription(withoutStability)).toBe("Does a dummy thing.");
  });

  it("prefixes [BETA] for beta tier", () => {
    expect(
      decorateDescription({ ...baseTool, stability: "beta" })
    ).toBe("[BETA] Does a dummy thing.");
  });

  it("prefixes [ALPHA] for alpha tier", () => {
    expect(
      decorateDescription({ ...baseTool, stability: "alpha" })
    ).toBe("[ALPHA] Does a dummy thing.");
  });

  it("appends a since-only suffix for stable + deprecated{since}", () => {
    expect(
      decorateDescription({
        ...baseTool,
        deprecated: { since: "0.5.0" },
      })
    ).toBe("Does a dummy thing. (deprecated since 0.5.0)");
  });

  it("appends since + replacement when replaceWith is set", () => {
    expect(
      decorateDescription({
        ...baseTool,
        deprecated: { since: "0.5.0", replaceWith: "resolume_v2" },
      })
    ).toBe("Does a dummy thing. (deprecated since 0.5.0, use resolume_v2)");
  });

  it("appends since + replacement + removeIn for the full house", () => {
    expect(
      decorateDescription({
        ...baseTool,
        deprecated: {
          since: "0.5.0",
          replaceWith: "resolume_v2",
          removeIn: "0.7.0",
        },
      })
    ).toBe(
      "Does a dummy thing. (deprecated since 0.5.0, use resolume_v2, removed in 0.7.0)"
    );
  });

  it("combines [BETA] prefix with deprecation suffix", () => {
    expect(
      decorateDescription({
        ...baseTool,
        stability: "beta",
        deprecated: {
          since: "0.5.0",
          replaceWith: "resolume_v2",
          removeIn: "0.6.0",
        },
      })
    ).toBe(
      "[BETA] Does a dummy thing. (deprecated since 0.5.0, use resolume_v2, removed in 0.6.0)"
    );
  });

  it("combines [ALPHA] prefix with deprecation suffix", () => {
    expect(
      decorateDescription({
        ...baseTool,
        stability: "alpha",
        deprecated: { since: "0.5.0", removeIn: "0.6.0" },
      })
    ).toBe(
      "[ALPHA] Does a dummy thing. (deprecated since 0.5.0, removed in 0.6.0)"
    );
  });
});

describe("eraseTool — stability/deprecation propagation", () => {
  it("defaults stability to 'stable' when absent on the source tool", () => {
    const erased = eraseTool(baseTool);
    expect(erased.stability).toBe("stable");
    expect(erased.deprecated).toBeUndefined();
    expect(erased.description).toBe("Does a dummy thing.");
  });

  it("propagates beta tier and bakes the prefix into the description", () => {
    const erased = eraseTool({ ...baseTool, stability: "beta" });
    expect(erased.stability).toBe("beta");
    expect(erased.description).toBe("[BETA] Does a dummy thing.");
  });

  it("propagates the deprecation block to the erased tool", () => {
    const erased = eraseTool({
      ...baseTool,
      deprecated: { since: "0.5.0", replaceWith: "resolume_v2" },
    });
    expect(erased.deprecated).toEqual({
      since: "0.5.0",
      replaceWith: "resolume_v2",
    });
    expect(erased.description).toBe(
      "Does a dummy thing. (deprecated since 0.5.0, use resolume_v2)"
    );
  });
});
