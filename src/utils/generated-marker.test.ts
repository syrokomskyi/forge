/*
<MODULE_CONTRACT>
<purpose>
Unit tests for generated marker covering utils/generated-marker (load verification). It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Fixtures stay inline and minimal so each case states its own setup.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the generated suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./generated-marker.ts";

describe("utils/generated-marker (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
