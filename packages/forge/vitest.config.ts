import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "os/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["json", "json-summary", "text-summary", "html"],
      reportsDirectory: "./.coverage",
      include: ["src/**/*.ts", "os/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "os/**/*.test.ts",
        "src/**/*.d.ts",
        "os/**/*.d.ts",
        "src/**/index.ts",
        "os/**/index.ts",
      ],
    },
  },
});
