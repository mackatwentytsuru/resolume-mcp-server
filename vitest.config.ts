import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/server/index.ts",
        "src/**/*.test.ts",
        "src/resolume/types.ts",
        "src/version.ts",
        // Test infrastructure / generated registries — no production logic.
        "src/tools/test-helpers.ts",
        "src/tools/index.ts",
        "src/tools/index.generated.ts",
      ],
      thresholds: {
        // Tightened from the v0.5 80% baseline after the v0.6 review fixes
        // pushed actual coverage to ~99% on the production surface.
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
