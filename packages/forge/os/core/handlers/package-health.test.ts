/*
<MODULE_CONTRACT>
<purpose>Unit tests for forge.package.health validator — engines, CI workflow, extract config, devDeps completeness.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { runPackageHealth } from "./package-health.ts";

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
    scripts: { build: "tsc --noEmit" },
    devDependencies: { typescript: "^5.0.0" },
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(pkgDir, "extract.config.yaml"), "source: .\n");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
  expect(result.exitCode).toBe(0);
  expect(result.data?.passed).toBe(true);
  expect(result.data?.packagesChecked).toBe(1);
  expect(result.data?.violations).toHaveLength(0);
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

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
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

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
  expect(result.exitCode).toBe(1);
  expect(result.data?.passed).toBe(false);
  const v01 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-01");
  expect(v01).toBeDefined();
  expect(v01?.severity).toBe("error");
  expect(v01?.packageName).toBe("@test/no-engines");
});

test("reports PKG-HEALTH-02 when CI workflow is missing", async () => {
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

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
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

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
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

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
  expect(result.exitCode).toBe(1);
  const v04s = result.data?.violations.filter((v) => v.ruleId === "PKG-HEALTH-04");
  expect(v04s).toHaveLength(2);
  const depNames = v04s?.map((v) => v.message.match(/"([^"]+)"/)?.[1]);
  expect(depNames).toContain("eslint");
  expect(depNames).toContain("vitest");
});

test("handles no packages/ directory gracefully", async () => {
  writePkgJson(tmpDir, { name: "empty", private: true });

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir));
  expect(result.exitCode).toBe(0);
  expect(result.data?.packagesChecked).toBe(0);
  expect(result.data?.passed).toBe(true);
});
