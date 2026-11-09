import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules", "dist", "**/*.test.ts", "src/__tests__/stub-client.ts"],
    },
    // Quiet by default; tests that assert on logs capture stderr themselves.
    env: { LOG_LEVEL: "error" },
    mockReset: true,
    restoreMocks: true,
  },
});
