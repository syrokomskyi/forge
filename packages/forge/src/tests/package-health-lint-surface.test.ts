/*
<MODULE_CONTRACT>
<purpose>Probe tests for the forge.package.health lint-surface check (PKG-HEALTH-06, RFC-1254):
extractable packages run their own lint contract via an injected runner; failures surface as
per-package lint-surface: fail and flip passed/exitCode.</purpose>
<non-goals>
  <item>Does not exercise the real pnpm execFileSync runner — the lint subprocess is stubbed via the injected lintRunner seam.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../types.ts";
import { runPackageHealth } from "../../os/core/handlers/package-health.ts";

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

function seedHealthyPackage(
  tmpDir: string,
  dirName: string,
  opts: { projectDir?: string; lintScript?: boolean } = {},
): void {
  const pkgDir = join(tmpDir, "packages", dirName);
  mkdirSync(pkgDir, { recursive: true });
  writePkgJson(pkgDir, {
    name: `@test/${dirName}`,
    version: "1.0.0",
    private: false,
    type: "module",
    engines: { node: ">=24 <25" },
    scripts: opts.lintScript ? { lint: "eslint src" } : {},
    devDependencies: opts.lintScript ? { eslint: "^9.0.0" } : {},
  });
  mkdirSync(join(pkgDir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(pkgDir, ".github", "workflows", "ci.yml"), "name: CI\n");
  const projectDirLine = opts.projectDir ? `projectDir: ${opts.projectDir}\n` : "";
  writeFileSync(join(pkgDir, "extract.config.yaml"), `${projectDirLine}standalone: true\n`);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `forge-pkg-health-lint-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  writePkgJson(tmpDir, {
    name: "test-workspace",
    private: true,
    engines: { node: ">=24 <25" },
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("reports lint-surface pass when the injected runner succeeds", async () => {
  seedHealthyPackage(tmpDir, "clean-pkg", { lintScript: true });

  const calls: Array<{ dir: string; hasScript: boolean }> = [];
  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), (dir, hasScript) => {
    calls.push({ dir, hasScript });
    return { ok: true, detail: "" };
  });

  expect(result.exitCode).toBe(0);
  expect(result.data?.passed).toBe(true);
  expect(result.data?.lintSurface).toEqual({ "@test/clean-pkg": "pass" });
  expect(result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-06")).toBeUndefined();
  // pnpm run lint — the package declares a lint script
  expect(calls).toEqual([{ dir: join(tmpDir, "packages", "clean-pkg"), hasScript: true }]);
});

test("reports lint-surface fail and PKG-HEALTH-06 when the runner rejects", async () => {
  seedHealthyPackage(tmpDir, "dirty-pkg");

  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => ({
    ok: false,
    detail: "eslint: 3 errors",
  }));

  expect(result.exitCode).toBe(1);
  expect(result.data?.passed).toBe(false);
  expect(result.data?.lintSurface).toEqual({ "@test/dirty-pkg": "fail" });
  const v06 = result.data?.violations.find((v) => v.ruleId === "PKG-HEALTH-06");
  expect(v06).toBeDefined();
  expect(v06?.severity).toBe("error");
  expect(v06?.packageName).toBe("@test/dirty-pkg");
  // no lint script → eslint fallback flag surfaced in fixHint
  expect(v06?.fixHint).toContain("exec eslint");
});

test("uses projectDir from extract.config.yaml when declared", async () => {
  seedHealthyPackage(tmpDir, "mapped-pkg", { projectDir: "packages/mapped-pkg" });

  const calls: string[] = [];
  await runPackageHealth(makeInput(), makeContext(tmpDir), (dir) => {
    calls.push(dir);
    return { ok: true, detail: "" };
  });

  expect(calls).toEqual([join(tmpDir, "packages", "mapped-pkg")]);
});

test("skips the probe for packages without extract.config.yaml", async () => {
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

  let invoked = false;
  const result = await runPackageHealth(makeInput(), makeContext(tmpDir), () => {
    invoked = true;
    return { ok: true, detail: "" };
  });

  expect(invoked).toBe(false);
  expect(result.data?.lintSurface).toEqual({});
});
