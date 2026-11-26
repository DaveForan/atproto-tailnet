import { defineConfig } from "vitest/config";

export default defineConfig({
  // root is src/, so keep Vite's cache in the top-level node_modules instead of src/node_modules
  cacheDir: "../node_modules/.vite",
  test: {
    root: "src",
    include: ["__tests__/**/*.test.ts"],
    // The service does not start without a coordinator. No test calls this address.
    env: {
      COORDINATOR_URL: "http://coordinator.test:9443",
      COORDINATOR_API_KEY: "test-coordinator-key-0000000000000000000000",
    },
  },
});
