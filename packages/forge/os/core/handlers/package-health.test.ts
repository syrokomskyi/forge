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
  expect(result.data?.violations).toHaveLength(0);
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
