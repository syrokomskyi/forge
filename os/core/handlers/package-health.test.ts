/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.package.health validator — engines, CI workflow, extract config, devDeps completeness.</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the package suite's contract for test-file scaffold coverage.</item>
  <item>RFC-1517: add preflight-extract-gates — FLOW-PUB-01 changelog check at ref plus shared PKG-HEALTH-10 fixture-path scan for RFC-1517</item>
  <item>RFC-1517: make pkg-health-10 shipped-set faithful and scan the publish ref</item>
  <item>RFC-1518: docs-drift gate PKG-HEALTH-11/12 in forge.package.health

Live-inventory docs gate: PKG-HEALTH-11 flags registered commands absent
from the package DOCS_SURFACE, PKG-HEALTH-12 flags dead x.y doc tokens.
loadCommandInventory unions the runtime registry with the generated
command manifest (getLiveCommands precedent); namespace + TLD-tail
resolution keep property paths and domains silent. Same-line
pkg-health-11/12 markers journal intentional exceptions.

Audit diff to land green: canonical forge.* names in forge docs,
leitstand.access.* expansions, registered-surface listings for
projektarchiv-operations/werkstatt-journal/werkstatt-engine, and 100+
journaled suppressions for code paths, family prefixes, and the planned
werkstatt-knowledge CLI surface.</item>
  <item>RFC-1518: attribution merge, private-package docs gate, suppression journal</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import {
  deriveShippedFiles,
  runPackageHealth,
  scanFixturePathEscapes,
} from "./package-health.ts";

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
    dryRun: false,
    outputFormat: "pretty",
  };
}

function makeInput(): ForgeCommandInput {
  return { argv: [], flags: {} };
}

function writePkgJson(dir: string, pkg: Record<string, unknown>) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `forge-pkg-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("passes when all published packages are healthy", async () => {
  const rootPkg = {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  };
  writePkgJson(tmpDir, rootPkg);

  const pkgDir = join(tmpDir, "packages", "my-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/my-pkg",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {
      build: "tsc --noEmit",
      lint: "eslint src",
      typecheck: "tsc --noEmit",
      test: "vitest run",
    },
    devDependencies: {
      typescript: "^5.0.0",
      eslint: "^9.0.0",
      vitest: "^4.0.0",
    },
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(
    join(pkgDir, "extract.config.yaml"),
    "source: .\nci:\n  provider: github-actions\n",
  );

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(0);
  expect(result.data?.passed).toBe(true);
  expect(result.data?.packagesChecked).toBe(1);
  // The empty-inventory PKG-HEALTH-12 warning is expected — no manifest, no registry.
  expect(result.data?.violations.filter((v) => v.severity === "error")).toHaveLength(0);
});

test("skips private packages", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "private-pkg");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/private-pkg",
    version: "1.0.0",
    private: true,
  });

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(0);
  expect(result.data?.packagesChecked).toBe(0);
  expect(result.data?.passed).toBe(true);
});

test("reports PKG-HEALTH-01 when engines.node is missing", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "no-engines");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/no-engines",
    version: "1.0.0",
    private: false,
    type: "module",
    scripts: {},
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(1);
  expect(result.data?.passed).toBe(false);
  const v01 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-01");
  expect(v01).toBeDefined();
  expect(v01?.severity).toBe("error");
  expect(v01?.packageName).toBe("@test/no-engines");
});

test("accepts generated CI — extractable package with ci: provider needs no in-package workflow", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "generated-ci");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/generated-ci",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: { build: "tsc", lint: "eslint src", typecheck: "tsc --noEmit", test: "vitest run" },
    devDependencies: { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^4.0.0" },
  });
  // No .github/workflows/ci.yml — repo-extract generates it from the ci: block.
  writeFileSync(
    join(pkgDir, "extract.config.yaml"),
    "source: .\nci:\n  provider: github-actions\n  publish: true\n",
  );

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(0);
  expect(result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-02")).toBeUndefined();
});

test("accepts in-package CI as fallback — extractable package without ci: provider keeps shipped workflow", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "shipped-ci");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/shipped-ci",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {},
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-02")).toBeUndefined();
});

test("reports PKG-HEALTH-02 when extracted repo would ship no CI", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "no-ci");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/no-ci",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {},
  });
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(1);
  const v02 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-02");
  expect(v02).toBeDefined();
  expect(v02?.severity).toBe("error");
});

test("reports PKG-HEALTH-03 when extract.config.yaml is missing", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "no-extract");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/no-extract",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {},
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  const v03 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-03");
  expect(v03).toBeDefined();
  expect(v03?.severity).toBe("warning");
  // Warning only — should still pass
  expect(result.exitCode).toBe(0);
});

test("reports PKG-HEALTH-04 when script tool is not in devDependencies", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "hoisted-dep");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/hoisted-dep",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {
      lint: 'pnpm exec eslint "src/**/*.ts"',
      test: "vitest run",
    },
    devDependencies: {},
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(1);
  const v04s = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-04");
  expect(v04s).toHaveLength(2);
  const depNames = v04s?.map((v) => v.message.match(/"([^"]+)"/)?.[1]);
  expect(depNames).toContain("eslint");
  expect(depNames).toContain("vitest");
});

test("reports PKG-HEALTH-07 when generated CI invokes a missing script", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "missing-scripts");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/missing-scripts",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: { build: "tsc", test: "vitest run" },
    devDependencies: { typescript: "^5.0.0", vitest: "^4.0.0" },
  });
  writeFileSync(
    join(pkgDir, "extract.config.yaml"),
    "source: .\nci:\n  provider: github-actions\n",
  );

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  const v07 = result.data?.violations
    .filter((v) => v.ruleId === "PKG-HEALTH-07")
    .map((v) => v.message);
  expect(v07?.some((m) => m.includes('"lint"'))).toBe(true);
  expect(v07?.some((m) => m.includes('"typecheck"'))).toBe(true);
  expect(v07?.some((m) => m.includes('"build"'))).toBe(false);
  expect(v07?.some((m) => m.includes('"test"'))).toBe(false);
});

test("PKG-HEALTH-07 respects ci.skipBuild for the build script", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "skip-build");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/skip-build",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: { lint: "eslint src", typecheck: "tsc --noEmit", test: "vitest run" },
    devDependencies: { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^4.0.0" },
  });
  writeFileSync(
    join(pkgDir, "extract.config.yaml"),
    "source: .\nci:\n  provider: github-actions\n  skipBuild: true\n",
  );

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-07")).toBeUndefined();
});

test("reports PKG-HEALTH-08 when repository.url is missing or mismatched under ci.publish", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const scripts = {
    build: "tsc",
    lint: "eslint src",
    typecheck: "tsc --noEmit",
    test: "vitest run",
  };
  const devDependencies = { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^4.0.0" };

  const missingDir = join(tmpDir, "packages", "no-repo-field");
  mkdirSync(missingDir, { recursive: true });
  writePkgJson(missingDir, {
    name: "@test/no-repo-field",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts,
    devDependencies,
  });
  writeFileSync(
    join(missingDir, "extract.config.yaml"),
    "source: .\nci:\n  provider: github-actions\n  publish: true\ngit:\n  remote: git@github.com:owner/no-repo-field.git\n",
  );

  const mismatchDir = join(tmpDir, "packages", "bad-repo-field");
  mkdirSync(mismatchDir, { recursive: true });
  writePkgJson(mismatchDir, {
    name: "@test/bad-repo-field",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts,
    devDependencies,
    repository: { type: "git", url: "git+https://github.com/someone-else/other.git" },
  });
  writeFileSync(
    join(mismatchDir, "extract.config.yaml"),
    "source: .\nci:\n  provider: github-actions\n  publish: true\ngit:\n  remote: git@github.com:owner/bad-repo-field.git\n",
  );

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  const v08 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-08");
  expect(v08).toHaveLength(2);
  expect(v08?.map((v) => v.packageName).sort()).toEqual([
    "@test/bad-repo-field",
    "@test/no-repo-field",
  ]);
});

test("reports PKG-HEALTH-09 when files[] omits a reachable src file", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "files-gap");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/files-gap",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    files: ["dist/", "src/index.ts"],
    scripts: { build: "tsc", lint: "eslint src", typecheck: "tsc --noEmit", test: "vitest run" },
    devDependencies: { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^4.0.0" },
  });
  writeFileSync(join(pkgDir, "src", "index.ts"), 'export * from "./helper.ts";\n');
  writeFileSync(join(pkgDir, "src", "helper.ts"), "export const x = 1;\n");
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  const v09 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-09");
  expect(v09).toBeDefined();
  expect(v09?.message).toContain("src/helper.ts");
});

test('"extractable": false suppresses extract-dependent checks', async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "opted-out");
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/opted-out",
    version: "1.0.0",
    private: false,
    extractable: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {},
  });
  // No extract.config.yaml, no CI — all extract checks suppressed.

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(0);
  expect(result.data?.violations.filter((v) => v.severity === "error")).toHaveLength(0);
});

test("reports PKG-HEALTH-10 at file:line when a shipped file's ../ literal escapes the package root (AC-2)", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "escaping");
  mkdirSync(join(pkgDir, "src", "tests"), { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/escaping",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {
      build: "tsc",
      lint: "eslint src",
      typecheck: "tsc --noEmit",
      test: "vitest run",
    },
    devDependencies: { eslint: "^9.0.0", typescript: "^5.0.0", vitest: "^4.0.0" },
  });
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");
  writeFileSync(
    join(pkgDir, "src", "tests", "fixture.test.ts"),
    'const fixture = "../../../docs/rfcs/rfc-0000-template.md";\nexport { fixture };\n',
  );

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  const v10 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-10");
  expect(v10).toBeDefined();
  expect(v10?.severity).toBe("error");
  expect(v10?.message).toContain("src/tests/fixture.test.ts:1");
  expect(v10?.message).toContain("../../../docs/rfcs/rfc-0000-template.md");
  expect(result.data?.passed).toBe(false);
});

test("a ../ literal resolving inside the package root is not flagged (AC-4)", async () => {
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });

  const pkgDir = join(tmpDir, "packages", "inside-root");
  mkdirSync(join(pkgDir, "src", "deep"), { recursive: true });
  writePkgJson(pkgDir, {
    name: "@test/inside-root",
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: {},
  });
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");
  // sibling module import — resolves inside the package root, must not flag.
  writeFileSync(join(pkgDir, "src", "deep", "mod.ts"), 'export { x } from "../mod.ts";\n');
  writeFileSync(join(pkgDir, "src", "mod.ts"), "export const x = 1;\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(
    result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-10"),
  ).toHaveLength(0);
});

test("scanFixturePathEscapes honors suppression, raw-mode, and per-extension modes", () => {
  const pkgDir = join(tmpDir, "packages", "scan");
  mkdirSync(join(pkgDir, "sub"), { recursive: true });
  // suppression comment escapes a justified non-path use.
  writeFileSync(
    join(pkgDir, "suppressed.ts"),
    'const s = "../../outside.md"; // pkg-health-10: prose example, not a path\n',
  );
  // non-doc non-ts files get the raw scan — unquoted ../ chains still flag.
  writeFileSync(join(pkgDir, "notes.yaml"), "see: ../../../outside.md\n");
  // a ../ inside a comment does not flag in ts files (literal-aware mode).
  writeFileSync(join(pkgDir, "sub", "noted.ts"), "// resolves ../../outside.md\nexport {};\n"); // pkg-health-10: fixture string exercises the unsuppressed path
  // doc files are exempt — prose links are never resolved.
  writeFileSync(join(pkgDir, "README.md"), "see ../../../outside.md for details\n");

  const escapes = scanFixturePathEscapes(pkgDir, [
    "suppressed.ts",
    "notes.yaml",
    "README.md",
    "sub/noted.ts",
  ]);
  expect(escapes).toHaveLength(1);
  expect(escapes[0]?.file).toBe("notes.yaml");
  expect(escapes[0]?.line).toBe(1);
  expect(escapes[0]?.literal).toContain("../");
});

test("deriveShippedFiles applies ignoreDirs, excludePathSegments, and excludeExtensions", () => {
  const pkgDir = join(tmpDir, "packages", "derive");
  mkdirSync(join(pkgDir, "src", "tests"), { recursive: true });
  mkdirSync(join(pkgDir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(pkgDir, "src", "index.ts"), "export {};\n");
  writeFileSync(join(pkgDir, "src", "tests", "x.test.ts"), "export {};\n");
  writeFileSync(join(pkgDir, "src", "cache.db"), "db\n");
  writeFileSync(join(pkgDir, "src", "out.tsbuildinfo"), "{}\n");
  writeFileSync(join(pkgDir, "node_modules", "dep", "index.js"), "\n");

  const config =
    "ignoreDirs:\n  - .turbo\nexcludePathSegments:\n  - src/tests\nexcludeExtensions:\n  - .db\n";
  const shipped = deriveShippedFiles(pkgDir, config);
  expect(shipped).toEqual(["src/index.ts"]);
});

test("handles no packages/ directory gracefully", async () => {
  writePkgJson(tmpDir, { name: "empty", private: true });

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: true,
    detail: "",
  }));
  expect(result.exitCode).toBe(0);
  expect(result.data?.packagesChecked).toBe(0);
  expect(result.data?.passed).toBe(true);
});

// ---------------------------------------------------------------------------
// RFC-1518: docs drift gate — PKG-HEALTH-11 coverage + PKG-HEALTH-12 dead refs
// ---------------------------------------------------------------------------

function makeRegistryContext(workspaceRoot: string, commands: { name: string; module: string }[]): ForgeRuntimeContext {
  return {
    ...makeContext(workspaceRoot),
    commandRegistry: {
      listCommandNames: () => commands.map((c) => c.name),
      listCommands: () => commands.map((c) => ({ name: c.name, module: c.module, provider: "workspace" as const, description: "", scope: "workspace" as const })),
      getCommand: () => undefined,
    },
  };
}

function seedDocsPkg(opts: { name?: string; docs?: Record<string, string>; readme?: string; agents?: string } = {}) {
  const pkgDir = join(tmpDir, "packages", "lib");
  mkdirSync(join(pkgDir, "docs", "reference"), { recursive: true });
  writePkgJson(pkgDir, { name: opts.name ?? "@warpgogol/lib", version: "1.0.0", engines: { node: ">=20" } });
  for (const [rel, content] of Object.entries(opts.docs ?? {})) {
    const abs = join(pkgDir, "docs", rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.readme !== undefined) writeFileSync(join(pkgDir, "README.md"), opts.readme);
  if (opts.agents !== undefined) writeFileSync(join(pkgDir, "AGENTS.md"), opts.agents);
  // kernel.config.ts attributing the "lib-mod" module to packages/lib
  mkdirSync(join(tmpDir, "tools"), { recursive: true });
  writeFileSync(
    join(tmpDir, "tools", "kernel.config.ts"),
    'export default { moduleLoaders: { "lib-mod": async () => (await import("@warpgogol/lib/kernel")).m } };\n',
  );
  return pkgDir;
}

test("PKG-HEALTH-11: a registered command absent from the docs surface errors naming token + reference doc (AC-1)", async () => {
  seedDocsPkg({ docs: { "reference/cli.md": "# CLI\n\n`lib.alpha` does a thing.\n" } });
  const ctx = makeRegistryContext(tmpDir, [
    { name: "lib.alpha", module: "lib-mod" },
    { name: "lib.beta", module: "lib-mod" },
  ]);
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const v11 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-11") ?? [];
  expect(v11).toHaveLength(1);
  expect(v11[0]?.message).toContain("lib.beta");
  expect(v11[0]?.message).toContain("docs/reference/cli.md");
  expect(v11[0]?.severity).toBe("error");
});

test("PKG-HEALTH-12: a doc token resolving to no registered command errors at doc:line; versions and config paths stay silent (AC-3)", async () => {
  seedDocsPkg({
    docs: {
      "guide.md": "# Guide\n\nRun `lib.retired` first, then check `9.1.0` and `extract.config.yaml`.\n",
    },
  });
  const ctx = makeRegistryContext(tmpDir, [{ name: "lib.alpha", module: "lib-mod" }]);
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const v12 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-12") ?? [];
  expect(v12).toHaveLength(1);
  expect(v12[0]?.message).toContain("docs/guide.md:3");
  expect(v12[0]?.message).toContain("lib.retired");
});

test("pkg-health-11/pkg-health-12 markers skip the line and journal the suppression (AC-4)", async () => {
  seedDocsPkg({
    docs: {
      "reference/cli.md":
        "# CLI\n\nlib.beta <!-- pkg-health-11: internal plumbing, not operator-facing -->\n\nUse `lib.retired`. <!-- pkg-health-12: historical narrative of the retired flow -->\n",
    },
  });
  const ctx = makeRegistryContext(tmpDir, [
    { name: "lib.alpha", module: "lib-mod" },
    { name: "lib.beta", module: "lib-mod" },
  ]);
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const docs = result.data?.violations.filter((v) => v.ruleId.startsWith("PKG-HEALTH-1")) ?? [];
  // lib.alpha uncovered (PKG-HEALTH-11); lib.beta suppressed; lib.retired suppressed.
  expect(docs).toHaveLength(1);
  expect(docs[0]?.message).toContain("lib.alpha");
  const sup = result.data?.suppressions ?? [];
  expect(sup.some((s) => s.ruleId === "PKG-HEALTH-11" && s.token === "lib.beta")).toBe(true);
  expect(sup.some((s) => s.ruleId === "PKG-HEALTH-12" && s.token === "lib.retired")).toBe(true);
  expect(sup[0]?.reason.length).toBeGreaterThan(0);
});

test("excluded surfaces (CHANGELOG, generated, audit archive) are never scanned (AC-5)", async () => {
  const pkgDir = seedDocsPkg({ docs: {} });
  writeFileSync(join(pkgDir, "CHANGELOG.md"), "# Changes\n\n## [9.9.9]\n\n- mentions `lib.retired`\n");
  mkdirSync(join(pkgDir, "docs", "audits", "archive"), { recursive: true });
  writeFileSync(join(pkgDir, "docs", "audits", "archive", "old.md"), "`lib.retired` history\n");
  writeFileSync(join(pkgDir, "docs", "status.generated.md"), "`lib.retired` generated\n");
  const ctx = makeRegistryContext(tmpDir, [{ name: "lib.alpha", module: "lib-mod" }]);
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const v12 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-12") ?? [];
  expect(v12).toHaveLength(0);
});

// r1 review fixes: manifest/registry merge, private-package semantics,
// unquoted module-map keys, suppression journal shape.

test("registry entry without module preserves manifest module provenance (r1)", async () => {
  seedDocsPkg({ docs: {} });
  mkdirSync(join(tmpDir, "docs"), { recursive: true });
  writeFileSync(
    join(tmpDir, "docs", "command-manifest.generated.yaml"),
    "commands:\n  - name: lib.alpha\n    module: lib-mod\n  - name: lib.beta\n    module: lib-mod\n",
  );
  // Standalone CLI registry shape: entries may omit module entirely.
  const ctx: ForgeRuntimeContext = {
    ...makeContext(tmpDir),
    commandRegistry: {
      listCommandNames: () => ["lib.alpha"],
      listCommands: () => [{ name: "lib.alpha", provider: "workspace" as const, description: "", scope: "workspace" as const }],
      getCommand: () => undefined,
    },
  };
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const v11 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-11") ?? [];
  // Both manifest commands attribute to packages/lib; neither is documented.
  expect(v11).toHaveLength(2);
  expect(v11.map((v) => v.message).join()).toContain("lib.alpha");
  expect(v11.map((v) => v.message).join()).toContain("lib.beta");
});

test("private package docs: PKG-HEALTH-12 still fires, PKG-HEALTH-11 stays silent (r1, D-003)", async () => {
  const pkgDir = join(tmpDir, "packages", "priv");
  mkdirSync(join(pkgDir, "docs"), { recursive: true });
  writePkgJson(pkgDir, { name: "@warpgogol/priv", version: "1.0.0", private: true });
  writeFileSync(join(pkgDir, "docs", "notes.md"), "run `lib.retired` first\n");
  const ctx = makeRegistryContext(tmpDir, [{ name: "lib.alpha", module: "lib-mod" }]);
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const v11 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-11" && v.packageName === "@warpgogol/priv") ?? [];
  const v12 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-12" && v.packageName === "@warpgogol/priv") ?? [];
  expect(v11).toHaveLength(0);
  expect(v12).toHaveLength(1);
  expect(v12[0]?.message).toContain("lib.retired");
});

test("unquoted module-map keys attribute modules to packages (r1)", async () => {
  seedDocsPkg({ docs: {} });
  // seedDocsPkg wrote kernel.config; module-map takes precedence for its keys.
  const mmDir = join(tmpDir, "packages", "werkstatt-engine", "src", "kernel");
  mkdirSync(mmDir, { recursive: true });
  writeFileSync(
    join(mmDir, "module-map.ts"),
    'const ENGINE = "@warpgogol/lib";\nexport const MAP = { lib-mod: engine(ENGINE) };\n',
  );
  mkdirSync(join(tmpDir, "docs"), { recursive: true });
  writeFileSync(
    join(tmpDir, "docs", "command-manifest.generated.yaml"),
    "commands:\n  - name: lib.alpha\n    module: lib-mod\n",
  );
  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({ ok: true, detail: "" }));
  const v11 = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-11") ?? [];
  expect(v11).toHaveLength(1);
  expect(v11[0]?.packageName).toBe("@warpgogol/lib");
});

test("suppression journal carries file, line, token, package and clean reason (r1)", async () => {
  seedDocsPkg({
    docs: {
      "reference/cli.md": "Use `lib.retired`. <!-- pkg-health-12: retired command family -->\n",
    },
  });
  const ctx = makeRegistryContext(tmpDir, [{ name: "lib.alpha", module: "lib-mod" }]);
  const result = await runPackageHealth(makeInput(), ctx, () => ({ ok: true, detail: "" }));
  const sup = (result.data?.suppressions ?? []).find((s) => s.token === "lib.retired");
  expect(sup).toBeDefined();
  expect(sup?.file).toContain("docs/reference/cli.md");
  expect(sup?.line).toBe(1);
  expect(sup?.packageName).toBe("@warpgogol/lib");
  expect(sup?.reason).toBe("retired command family");
});
