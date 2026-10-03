import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/helpers/globalSetup.ts"],
    testTimeout: 15_000,
    hookTimeout: 120_000,
  },
});
