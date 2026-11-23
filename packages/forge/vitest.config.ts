import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Fixture repos must never resolve to the workspace repository.
    setupFiles: ["./vitest.setup.strip-git-env.ts"],
    include: ["src/**/*.test.ts", "os/**/*.test.ts"],
    // The standalone extract-verify suite runs git-fixture-heavy flow and
    // trust-boundary files under arbitrary machine load; 30s trips honest
    // fixture builds (repoWithOrigin, twoIntegrated, fixFlow) before any
    // judged work starts. Heavy tests already declare 90_000 explicitly.
    testTimeout: 90_000,
    maxWorkers: "50%",
    // The trust-boundary suite runs dozens of judged-consult-heavy files
    // in one fork; a single file's transient consult surfaces (evidence
    // snapshots, spawn buffers) peak past node 24's ~4GB default under
    // suite load and the worker dies with no FAIL line.
    execArgv: ["--max-old-space-size=8192"],
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
