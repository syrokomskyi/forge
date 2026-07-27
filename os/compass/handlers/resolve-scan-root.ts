/*
<MODULE_CONTRACT>
<purpose>Canonical Compass scan-root resolution for all Compass commands.
Moved from @warpgogol/site-kernel to @webgogol/forge for full autonomous mode (RFC-0556).</purpose>
<non-goals>
  <item>Do not implement Compass scanning or file processing logic here.</item>
  <item>Do not register commands or modify runtime context.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Introduced as part of RFC-0015 to extend Compass commands to packages/.</item>
  <item>RFC-0556: moved canonical implementation from @warpgogol/site-kernel to @webgogol/forge for autonomous mode.</item>
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
