/**
 * RFC-1517 self-scan regression: the real werkstatt workspace must carry zero
 * PKG-HEALTH-10 violations — any shipped `../` literal resolving outside its
 * package root is either a genuine defect (fix it), a monorepo-bound file
 * (excludePathSegments), or a justified non-path use (same-line suppression /
 * pkgHealth10Suppressions). This file is monorepo-only: it reads the real
 * workspace tree, so it lives in excludePathSegments for the standalone
 * extract.
 */
import { test, expect } from "vitest";
import { join } from "node:path";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../src/types.ts";
import { runPackageHealth } from "../../os/core/handlers/package-health.ts";

test("PKG-HEALTH-10 reports no violations on the real workspace", async () => {
  const context: ForgeRuntimeContext = {
    workspaceRoot: join(process.cwd(), "..", ".."),
    logger: { section: () => {}, info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
    dryRun: false,
    outputFormat: "json",
  };
  const input: ForgeCommandInput = { argv: [], flags: {} };
  const result = await runPackageHealth(input, context, () => ({ ok: true, detail: "" }));
  const v10 =
    result.data?.violations
      .filter((v) => v.ruleId === "PKG-HEALTH-10")
      .map((v) => `${v.packageName}: ${v.message}`) ?? [];
  expect(v10).toEqual([]);
}, 120_000);
