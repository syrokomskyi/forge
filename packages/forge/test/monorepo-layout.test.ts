/*
<MODULE_CONTRACT>
<purpose>Monorepo layout contract node (Werkstatt RFC-1649 AC-2): exactly the five
RFC-1645 packages exist with independent semver lines and correct npm identities.
</purpose>
</MODULE_CONTRACT>
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MONOREPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const EXPECTED: Record<string, string> = {
  forge: "@warpgogol/forge",
  "forge-typescript": "@warpgogol/forge-typescript",
  "forge-astro": "@warpgogol/forge-astro",
  "forge-repo-extract": "@warpgogol/forge-repo-extract",
  "forge-system": "@warpgogol/forge-system",
};

describe("monorepo-layout (RFC-1649 AC-2)", () => {
  it("packages/ contains exactly the five RFC-1645 packages", () => {
    const packagesDir = join(MONOREPO_ROOT, "packages");
    const actual = readdirSync(packagesDir)
      .filter((e) => statSync(join(packagesDir, e)).isDirectory())
      .sort();
    expect(actual).toEqual(Object.keys(EXPECTED).sort());
  });

  it("each package carries its fixed npm identity and an independent version", () => {
    for (const [dir, name] of Object.entries(EXPECTED)) {
      const manifest = join(MONOREPO_ROOT, "packages", dir, "package.json");
      const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as {
        name?: string;
        version?: string;
      };
      expect(parsed.name, `${dir} name`).toBe(name);
      expect(parsed.version, `${dir} version`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
