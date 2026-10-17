/*
<MODULE_CONTRACT>
<purpose>
Unit tests for schema covering knowledgeEntryMetaSchema. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the schema suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

// @vitest-environment node

import { describe, expect, it } from "vitest";

import { knowledgeEntryMetaSchema } from "./schema.ts";

describe("knowledgeEntryMetaSchema", () => {
  it("parses a valid L0 entry", () => {
    const result = knowledgeEntryMetaSchema.safeParse({
      id: "K-0001",
      layer: "L0",
      created: "2026-01-01",
      status: "active",
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid L2 entry with confirmations and lastConfirmedAt", () => {
    const result = knowledgeEntryMetaSchema.safeParse({
      id: "K-0002",
      layer: "L2",
      created: "2026-01-01",
      lastConfirmedAt: "2026-06-01",
      confirmations: 3,
      status: "active",
    });
    expect(result.success).toBe(true);
  });

  it("rejects L0 entries with confirmations", () => {
    const result = knowledgeEntryMetaSchema.safeParse({
      id: "K-0003",
      layer: "L0",
      created: "2026-01-01",
      confirmations: 1,
      status: "active",
    });
    expect(result.success).toBe(false);
  });

  it("rejects L2 entries without confirmations", () => {
    const result = knowledgeEntryMetaSchema.safeParse({
      id: "K-0004",
      layer: "L2",
      created: "2026-01-01",
      status: "active",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid id format", () => {
    const result = knowledgeEntryMetaSchema.safeParse({
      id: "K-001",
      layer: "L0",
      created: "2026-01-01",
      status: "active",
    });
    expect(result.success).toBe(false);
  });
});
