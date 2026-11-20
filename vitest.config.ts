import { defineConfig } from "vitest/config";

export default defineConfig({
  // root is src/, so keep Vite's cache in the top-level node_modules instead of src/node_modules
  cacheDir: "../node_modules/.vite",
  test: {
    root: "src",
    include: ["__tests__/**/*.test.ts"],
  },
});
