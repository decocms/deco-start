import { defineConfig } from "vitest/config";

// Two test suites, one runner:
// - `src/**` runs in jsdom (React rendering, hooks, browser globals).
// - `scripts/**` runs in node (filesystem, migration script logic).
// vitest applies env-per-file via the `environmentMatchGlobs` map.
export default defineConfig({
  test: {
    environment: "jsdom",
    environmentMatchGlobs: [
      ["scripts/**", "node"],
    ],
    include: [
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.ts",
    ],
    globals: true,
  },
});
