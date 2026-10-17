/*
<MODULE_CONTRACT>
<purpose>
Unit tests for forge plugin manifest covering forge-plugin-manifest (load verification).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the forge suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./forge-plugin-manifest.ts";

describe("forge-plugin-manifest (load verification)", () => {
  it("module loads and exports schema", () => {
    expect(mod).toBeDefined();
    expect(mod.forgePluginManifestSchema).toBeDefined();
  });
});
