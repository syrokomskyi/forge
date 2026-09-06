// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./forge-plugin-manifest.ts";

describe("forge-plugin-manifest (load verification)", () => {
  it("module loads and exports schema", () => {
    expect(mod).toBeDefined();
    expect(mod.forgePluginManifestSchema).toBeDefined();
  });
});
