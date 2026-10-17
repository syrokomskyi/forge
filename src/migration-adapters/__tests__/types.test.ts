/*
<MODULE_CONTRACT>
<purpose>
Unit tests for __tests__ types covering FORGE_PROTECTED_PATHS; DEFAULT_EXCLUDE_PATTERNS; type contracts.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the __tests__ suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import {
  FORGE_PROTECTED_PATHS,
  DEFAULT_EXCLUDE_PATTERNS,
  type MigrationAdapter,
  type AdapterAnalysis,
  type MigrationResult,
  type Conflict,
} from "../types.ts";

describe("FORGE_PROTECTED_PATHS", () => {
  it("contains forge.yaml", () => {
    expect(FORGE_PROTECTED_PATHS).toContain("forge.yaml");
  });

  it("contains .agents", () => {
    expect(FORGE_PROTECTED_PATHS).toContain(".agents");
  });

  it("contains docs/rfcs", () => {
    expect(FORGE_PROTECTED_PATHS).toContain("docs/rfcs");
  });

  it("contains PREFERENCES.md", () => {
    expect(FORGE_PROTECTED_PATHS).toContain("PREFERENCES.md");
  });
});

describe("DEFAULT_EXCLUDE_PATTERNS", () => {
  it("excludes node_modules", () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain("node_modules");
  });

  it("excludes dist", () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain("dist");
  });

  it("excludes .git", () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain(".git");
  });

  it("excludes .cache", () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain(".cache");
  });

  it("excludes .turbo", () => {
    expect(DEFAULT_EXCLUDE_PATTERNS).toContain(".turbo");
  });
});

describe("type contracts", () => {
  it("MigrationAdapter interface has required methods", () => {
    const adapter: MigrationAdapter = {
      id: "test",
      detect: () => true,
      analyze: (): AdapterAnalysis => ({
        stack: ["typescript"],
        packageManager: "pnpm",
        bindings: { typecheck: null, test: null, scopedBuild: null },
        placement: "apps",
        appName: "test",
        excludePatterns: [],
        gitHistory: false,
      }),
      migrate: (): MigrationResult => ({
        filesCopied: [],
        filesSkipped: [],
        conflicts: [],
        workspaceUpdated: false,
      }),
      postSetup: () => {},
    };
    expect(adapter.id).toBe("test");
    expect(adapter.detect("/")).toBe(true);
  });

  it("Conflict type has required fields", () => {
    const conflict: Conflict = {
      path: "src/file.ts",
      sourceExists: true,
      forgeExists: true,
      resolution: "source-wins",
    };
    expect(conflict.resolution).toBe("source-wins");
  });
});
