/*
<MODULE_CONTRACT>
<purpose>Canonical Compass scan-root resolution for all Compass commands.
Moved from @warpgogol/site-kernel to @warpgogol/forge for full autonomous mode (RFC-0556).</purpose>
<non-goals>
  <item>Do not implement Compass scanning or file processing logic here.</item>
  <item>Do not register commands or modify runtime context.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0556: moved canonical implementation from @warpgogol/site-kernel to @warpgogol/forge for autonomous mode.</item>
  <item>RFC-0617: added --workpiece flag for mission workpiece directory scanning.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — engine package clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. engine package now 0 diagnostics.</item>
  <item>RFC-1097: AC-4 banned literal in os/compass handlers

compass-migrate-handler hint used a consumer-specific run command — switched to generic 'pnpm exec forge run' convention. Reworded recorded CHANGE_SUMMARY items in 3 handlers to drop the consumer-specific literal. compass-policy AC-4 test green (65/65).</item>
</CHANGE_SUMMARY>
*/

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

export function resolveCompassScanRoot(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): string | undefined {
  const hasPackages = input.flags["packages"] === true;
  const workpiecePath = input.flags["workpiece"];
  const hasWorkpiece = typeof workpiecePath === "string" && workpiecePath.length > 0;

  if (hasWorkpiece && hasPackages) {
    throw new Error(
      "[compass] --workpiece and --packages are mutually exclusive. Use one or the other.",
    );
  }

  if (hasWorkpiece && context.siteExplicit) {
    throw new Error(
      "[compass] --workpiece and --site are mutually exclusive. Use one or the other.",
    );
  }

  if (hasWorkpiece) {
    const resolved = resolve(context.workspaceRoot, workpiecePath as string);
    if (!existsSync(resolved)) {
      throw new Error(`[compass] workpiece path not found: ${workpiecePath}`);
    }
    return resolved;
  }

  if (context.siteExplicit && hasPackages) {
    throw new Error(
      "[compass] --site and --packages are mutually exclusive. Use one or the other.",
    );
  }

  if (!hasPackages) {
    return context.site ? context.site.directory : undefined;
  }

  const packageName = input.flags["package"];
  if (!packageName || typeof packageName !== "string") {
    return resolve(context.workspaceRoot, "packages");
  }

  const candidates = [
    resolve(context.workspaceRoot, "packages", "os", packageName),
    resolve(context.workspaceRoot, "packages", packageName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const srcPath = resolve(candidate, "src");
      return existsSync(srcPath) ? srcPath : candidate;
    }
  }

  throw new Error(
    `[compass] Package "${packageName}" not found. Tried:\n${candidates.map((c) => `  ${c}`).join("\n")}`,
  );
}
