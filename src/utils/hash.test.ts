/*
<MODULE_CONTRACT>
<purpose>
Unit tests for hash covering byteHash. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Fixtures stay inline and minimal so each case states its own setup.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the hash suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { byteHash } from "./hash.ts";

describe("byteHash", () => {
  it("produces a sha256-prefixed hex digest for a string", () => {
    const hash = byteHash("test");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("produces a sha256-prefixed hex digest for bytes", () => {
    const hash = byteHash(new Uint8Array([1, 2, 3]));
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", () => {
    expect(byteHash("abc")).toBe(byteHash("abc"));
  });

  it("produces different hashes for different inputs", () => {
    expect(byteHash("abc")).not.toBe(byteHash("abd"));
  });
});
