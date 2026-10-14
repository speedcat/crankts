import { defineConfig } from "vitest/config";

// Profile-shape tests weight samples by wall time, so they run alone after everything else (groupOrder 1).
const profiledTests = ["test/observe-m0.test.ts", "test/observe-m3.test.ts"];

export default defineConfig({
  test: {
    // Many tests build full TypeScript programs; under parallel load they exceed vitest's 5 s default.
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["test/**/*.test.ts"], exclude: [...profiledTests, "**/node_modules/**"], sequence: { groupOrder: 0 } },
      },
      {
        extends: true,
        test: { name: "profiled", include: profiledTests, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
