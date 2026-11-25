/*
Manifest-package version sync — the published plugin artifact carries
forge.plugin.yaml inside the tarball; a manifest version drifting from the
package version lies to the loader's dependency resolution. The two must
never diverge (caught live 2026-11-25: manifest 0.1.0 inside the 1.0.0
artifact).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const PLUGINS = ["forge-typescript", "forge-astro", "forge-system", "forge-repo-extract"];
const PACKAGES_ROOT = join(__dirname, "..", "..");

describe("plugin manifest version sync", () => {
  for (const plugin of PLUGINS) {
    it(`${plugin}: manifest version equals package version`, () => {
      const pkg = JSON.parse(readFileSync(join(PACKAGES_ROOT, plugin, "package.json"), "utf8")) as { version: string };
      const manifest = parseYaml(readFileSync(join(PACKAGES_ROOT, plugin, "forge.plugin.yaml"), "utf8")) as { version: string };
      expect(manifest.version).toBe(pkg.version);
    });
  }
});
