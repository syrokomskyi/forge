/*
<MODULE_CONTRACT>
<purpose>
Unit tests for fs trash sync covering utils/fs-trash-sync (load verification).
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Fixtures stay inline and minimal so each case states its own setup.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the fs suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./fs-trash-sync.ts";

describe("utils/fs-trash-sync (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
