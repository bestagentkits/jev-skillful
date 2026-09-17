import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // Catalog tests use fixture home directories and must never touch the real home.
    // Tests that need the network are opt-in via SKILLFUL_TEST_NETWORK=1.
    testTimeout: 15_000,
  },
});
