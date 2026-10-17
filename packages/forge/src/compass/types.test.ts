/*
<MODULE_CONTRACT>
<purpose>
Unit tests for compass types covering compass types (load verification).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the compass suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./types.ts";

describe("compass types (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
