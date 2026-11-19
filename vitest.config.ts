import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    fileParallelism: false, // integration tests share one database
    testTimeout: 20_000,
    hookTimeout: 60_000, // integration suites rebuild the schema in beforeAll
  },
});
