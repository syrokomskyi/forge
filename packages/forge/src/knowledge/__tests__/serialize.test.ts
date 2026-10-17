/*
<MODULE_CONTRACT>
<purpose>
Unit tests for serialize covering serializeKnowledgeFile. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the serialize suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect } from "vitest";
import { serializeKnowledgeFile } from "../serialize.ts";
import type { ParsedKnowledgeFile, KnowledgeEntryMeta } from "../schema.ts";

function makeMeta(overrides: Partial<KnowledgeEntryMeta> = {}): KnowledgeEntryMeta {
  return {
    id: "entry-001",
    layer: "L1",
    created: "2026-01-01",
    lastConfirmedAt: "2026-01-01",
    confirmations: 1,
    status: "active",
    ...overrides,
  };
}

describe("serializeKnowledgeFile", () => {
  it("serializes empty parsed file to single newline", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    expect(serializeKnowledgeFile(parsed)).toBe("\n");
  });

  it("serializes preamble only", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "# My Knowledge File",
      entries: [],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    expect(serializeKnowledgeFile(parsed)).toBe("# My Knowledge File\n");
  });

  it("serializes a single entry with meta and body", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [
        {
          meta: makeMeta(),
          title: "First Principle",
          body: "This is the body text.",
          lineStart: 0,
        },
      ],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).toContain("### entry-001: First Principle");
    expect(result).toContain("```knowledge-entry");
    expect(result).toContain("id: entry-001");
    expect(result).toContain("layer: L1");
    expect(result).toContain("status: active");
    expect(result).toContain("This is the body text.");
    expect(result).toContain("```");
  });

  it("omits undefined meta fields", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [
        {
          meta: makeMeta({ supersedes: undefined, promotedTo: undefined, expiresAt: undefined }),
          title: "Minimal",
          body: "",
          lineStart: 0,
        },
      ],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).not.toContain("supersedes");
    expect(result).not.toContain("promotedTo");
    expect(result).not.toContain("expiresAt");
  });

  it("serializes array meta values as inline arrays", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [
        {
          meta: makeMeta({ supersedes: ["old-001", "old-002"] }),
          title: "Merged",
          body: "",
          lineStart: 0,
        },
      ],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).toContain("supersedes: [old-001, old-002]");
  });

  it("serializes empty array as []", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [
        {
          meta: makeMeta({ supersedes: [] }),
          title: "Empty",
          body: "",
          lineStart: 0,
        },
      ],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).toContain("supersedes: []");
  });

  it("serializes null meta value as null", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [
        {
          meta: makeMeta({ promotedTo: null }),
          title: "Null",
          body: "",
          lineStart: 0,
        },
      ],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).toContain("promotedTo: null");
  });

  it("serializes legacy sections", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "",
      entries: [],
      legacySections: [{ text: "## Old Section\n\nSome content", lineStart: 0 }],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).toContain("## Old Section");
    expect(result).toContain("Some content");
  });

  it("collapses excessive newlines to max two", () => {
    const parsed: ParsedKnowledgeFile = {
      path: "test.md",
      layer: "L1",
      preamble: "preamble",
      entries: [
        {
          meta: makeMeta(),
          title: "Title",
          body: "body",
          lineStart: 0,
        },
      ],
      legacySections: [],
      isKnowledgeAdjacent: false,
      parseIssues: [],
    };
    const result = serializeKnowledgeFile(parsed);
    expect(result).not.toMatch(/\n{3,}/);
  });
});
