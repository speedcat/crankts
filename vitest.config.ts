import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests build full TypeScript programs; under parallel load they exceed vitest's 5 s default.
    testTimeout: 30_000,
  },
});
