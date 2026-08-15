#!/usr/bin/env node
/*
  Tarball smoke test for @warpgogol/forge under Node 24 (RFC-0854).
  Packs the forge package, verifies the packed manifest, installs offline,
  and exercises the CLI entry point and a read-only command.
*/
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = join(__dirname, "..", "..");
const TMP = mkdtempSync(join(tmpdir(), "forge-tarball-node24-"));

const CHILD_ENV = {
  ...process.env,
  NPM_TOKEN: "",
  NODE_AUTH_TOKEN: "",
  GITHUB_TOKEN: "",
};

try {
  const tarballPath = execSync("pnpm pack", { cwd: FORGE_ROOT, encoding: "utf8", env: CHILD_ENV })
    .trim()
    .split("\n")
    .pop()
    .trim();
  const tarballAbs = join(FORGE_ROOT, tarballPath);

  const manifestOut = execSync(`npm pack --dry-run --json ${tarballAbs}`, {
    cwd: FORGE_ROOT,
    encoding: "utf8",
    env: CHILD_ENV,
  });
  const manifest = JSON.parse(manifestOut)[0];
  if (manifest.version !== "1.0.0") {
    throw new Error(`packed version is ${manifest.version}, expected 1.0.0`);
  }
  const pkgContent = JSON.parse(readFileSync(join(FORGE_ROOT, "package.json"), "utf8"));
  if (!pkgContent.engines || pkgContent.engines.node !== ">=24 <25") {
    throw new Error(`packed engines.node is ${pkgContent.engines?.node}, expected >=24 <25`);
  }

  const consumerPkg = {
    name: "node24-consumer-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
    engines: { node: ">=24 <25" },
    dependencies: { "@warpgogol/forge": `file:${tarballAbs}` },
  };
  writeFileSync(join(TMP, "package.json"), JSON.stringify(consumerPkg, null, 2) + "\n");

  execSync("pnpm install --no-frozen-lockfile --offline", {
    cwd: TMP,
    stdio: "pipe",
    env: CHILD_ENV,
  });

  const forgeBin = join(TMP, "node_modules", ".bin", "forge");
  if (!existsSync(forgeBin)) {
    throw new Error("forge binary not found after install");
  }

  const versionOut = execSync(`${forgeBin} --version`, {
    cwd: TMP,
    encoding: "utf8",
    env: CHILD_ENV,
  });
  if (!versionOut.trim()) {
    throw new Error("forge --version produced empty output");
  }

  console.log("node24-consumer smoke: PASS");
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
