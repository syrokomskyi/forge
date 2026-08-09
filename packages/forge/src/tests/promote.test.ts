import { test, expect, describe } from "vitest";
import { normalizeTitle, detectDuplicatePrinciples, planPromotion } from "../knowledge/promote.ts";
import type {
  ParsedKnowledgeFile,
  KnowledgeEntryMeta,
  KnowledgeEntry,
} from "../knowledge/schema.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), "test");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMeta(overrides: Partial<KnowledgeEntryMeta> = {}): KnowledgeEntryMeta {
  const layer = overrides.layer ?? "L2";
  const base: KnowledgeEntryMeta = {
    id: "K-0001",
    layer,
    created: "2026-01-01",
    status: "active",
  };
  if (layer === "L2") {
    base.confirmations = 1;
    base.lastConfirmedAt = "2026-01-01";
  }
  return { ...base, ...overrides };
}

function makeEntry(
  id: string,
  title: string,
  metaOverrides: Partial<KnowledgeEntryMeta> = {},
  body = "Body text.",
): KnowledgeEntry {
  return {
    meta: makeMeta({ id, ...metaOverrides }),
    title,
    body,
    lineStart: 1,
  };
}

function makeParsedFile(
  entries: KnowledgeEntry[],
  overrides: Partial<ParsedKnowledgeFile> = {},
): ParsedKnowledgeFile {
  return {
    path: join(testDir, "learned-principles.md"),
    layer: "L2",
    preamble: "",
    entries,
    legacySections: [],
    parseIssues: [],
    isKnowledgeAdjacent: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------

describe("normalizeTitle", () => {
  test("lowercases", () => {
    expect(normalizeTitle("Redact Sensitive Information")).toBe("redact sensitive information");
  });

  test("strips punctuation", () => {
    expect(normalizeTitle("Redact: Sensitive! Information?")).toBe("redact sensitive information");
  });

  test("strips emoji", () => {
    expect(normalizeTitle("🔒 Lock files before writing")).toBe("lock files before writing");
  });

  test("collapses whitespace", () => {
    expect(normalizeTitle("  Redact   Sensitive  Information  ")).toBe(
      "redact sensitive information",
    );
  });

  test("drops stop-words (the, a, an)", () => {
    expect(normalizeTitle("The Redact a Sensitive an Information")).toBe(
      "redact sensitive information",
    );
  });

  test("preserves 'always' and 'never'", () => {
    expect(normalizeTitle("Always verify before trusting")).toBe("always verify before trusting");
    expect(normalizeTitle("Never trust raw input")).toBe("never trust raw input");
  });

  test("empty string returns empty", () => {
    expect(normalizeTitle("")).toBe("");
  });

  test("only stop-words returns empty", () => {
    expect(normalizeTitle("the a an")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// detectDuplicatePrinciples
// ---------------------------------------------------------------------------

describe("detectDuplicatePrinciples", () => {
  test("exact match — two entries with identical normalized titles", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([makeEntry("K-0001", "Redact sensitive information")]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe("exact");
    expect(pairs[0].a.skill).toBe("fo-session-save");
    expect(pairs[0].b.skill).toBe("fo-memory-sync");
    expect(pairs[0].normalizedTitle).toBe("redact sensitive information");
  });

  test("no match — different titles", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([makeEntry("K-0001", "Redact sensitive information")]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Verify before trusting")]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("containment match — shorter is substring of longer, >= 20 chars and >= 60%", () => {
    const shortTitle = "always verify auto-extracted ids before trusting";
    const longTitle = "always verify auto-extracted ids before trusting them in production";

    const files = [
      { skill: "fo-session-save", parsed: makeParsedFile([makeEntry("K-0001", shortTitle)]) },
      { skill: "grilling", parsed: makeParsedFile([makeEntry("K-0003", longTitle)]) },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe("containment");
  });

  test("containment bounded — shorter title < 20 chars produces no match", () => {
    const shortTitle = "verify ids"; // 10 chars normalized
    const longTitle = "verify ids before trusting them in production environments";

    const files = [
      { skill: "fo-session-save", parsed: makeParsedFile([makeEntry("K-0001", shortTitle)]) },
      { skill: "grilling", parsed: makeParsedFile([makeEntry("K-0003", longTitle)]) },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("containment bounded — shorter title < 60% of longer produces no match", () => {
    const shortTitle = "always verify ids before trusting"; // 33 chars
    const longTitle =
      "always verify ids before trusting them in production environments with proper validation and care"; // 85 chars, 33/85 = 38.8%

    const files = [
      { skill: "fo-session-save", parsed: makeParsedFile([makeEntry("K-0001", shortTitle)]) },
      { skill: "grilling", parsed: makeParsedFile([makeEntry("K-0003", longTitle)]) },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("exclusion — pairs linked by promotedTo are excluded", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([
          makeEntry("K-0001", "Redact sensitive information", { promotedTo: "shared/K-0001" }),
        ]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([
          makeEntry("K-0005", "Redact sensitive information", { promotedTo: "shared/K-0001" }),
        ]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("exclusion — pairs linked by supersedes are excluded", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([
          makeEntry("K-0001", "Redact sensitive information", { supersedes: ["K-0005"] }),
        ]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("exclusion — entries with status: stale are excluded", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([
          makeEntry("K-0001", "Redact sensitive information", { status: "stale" }),
        ]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("exclusion — entries with status: archived are excluded", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([
          makeEntry("K-0001", "Redact sensitive information", { status: "archived" }),
        ]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("multiple skills — detection across 3+ skills", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([makeEntry("K-0001", "Redact sensitive information")]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")]),
      },
      {
        skill: "grilling",
        parsed: makeParsedFile([makeEntry("K-0010", "Redact sensitive information")]),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(3); // 3 pairs: (0,1), (0,2), (1,2)
    expect(pairs.every((p) => p.kind === "exact")).toBe(true);
  });

  test("knowledge-adjacent files are excluded", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([makeEntry("K-0001", "Redact sensitive information")]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")], {
          isKnowledgeAdjacent: true,
        }),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("files with parse issues are excluded", () => {
    const files = [
      {
        skill: "fo-session-save",
        parsed: makeParsedFile([makeEntry("K-0001", "Redact sensitive information")]),
      },
      {
        skill: "fo-memory-sync",
        parsed: makeParsedFile([makeEntry("K-0005", "Redact sensitive information")], {
          parseIssues: [{ line: 1, message: "bad" }],
        }),
      },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });

  test("empty normalized title is excluded", () => {
    const files = [
      { skill: "fo-session-save", parsed: makeParsedFile([makeEntry("K-0001", "the a an")]) },
      { skill: "fo-memory-sync", parsed: makeParsedFile([makeEntry("K-0005", "the a an")]) },
    ];

    const pairs = detectDuplicatePrinciples(files);
    expect(pairs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planPromotion
// ---------------------------------------------------------------------------

describe("planPromotion", () => {
  test("summed confirmations — two sources with 3 and 5 produce 8", () => {
    const sources = [
      {
        skill: "fo-session-save",
        file: "/path/a.md",
        entry: makeEntry("K-0001", "Redact sensitive information", { confirmations: 3 }),
      },
      {
        skill: "fo-memory-sync",
        file: "/path/b.md",
        entry: makeEntry("K-0005", "Redact sensitive information", { confirmations: 5 }),
      },
    ];

    const plan = planPromotion(
      sources,
      { title: "Redact sensitive information", body: "Merged body." },
      "K-0001",
      "2026-08-03",
    );

    expect(plan.sharedEntry.meta.confirmations).toBe(8);
  });

  test("promotedFrom provenance — lists all source skill/id pairs", () => {
    const sources = [
      {
        skill: "fo-session-save",
        file: "/path/a.md",
        entry: makeEntry("K-0001", "Redact sensitive information", { confirmations: 3 }),
      },
      {
        skill: "fo-memory-sync",
        file: "/path/b.md",
        entry: makeEntry("K-0005", "Redact sensitive information", { confirmations: 5 }),
      },
    ];

    const plan = planPromotion(
      sources,
      { title: "Redact sensitive information", body: "Merged body." },
      "K-0001",
      "2026-08-03",
    );

    expect(plan.sharedEntry.meta.promotedFrom).toEqual([
      "fo-session-save/K-0001",
      "fo-memory-sync/K-0005",
    ]);
  });

  test("pointer list — one pointer per source entry", () => {
    const sources = [
      {
        skill: "fo-session-save",
        file: "/path/a.md",
        entry: makeEntry("K-0001", "Redact sensitive information", { confirmations: 3 }),
      },
      {
        skill: "fo-memory-sync",
        file: "/path/b.md",
        entry: makeEntry("K-0005", "Redact sensitive information", { confirmations: 5 }),
      },
    ];

    const plan = planPromotion(
      sources,
      { title: "Redact sensitive information", body: "Merged body." },
      "K-0001",
      "2026-08-03",
    );

    expect(plan.localPointers).toHaveLength(2);
    expect(plan.localPointers[0]).toEqual({
      skill: "fo-session-save",
      file: "/path/a.md",
      entryId: "K-0001",
    });
    expect(plan.localPointers[1]).toEqual({
      skill: "fo-memory-sync",
      file: "/path/b.md",
      entryId: "K-0005",
    });
  });

  test("shared entry metadata — status active, created today, lastConfirmedAt today", () => {
    const sources = [
      {
        skill: "fo-session-save",
        file: "/path/a.md",
        entry: makeEntry("K-0001", "Redact sensitive information", { confirmations: 3 }),
      },
    ];

    const plan = planPromotion(
      sources,
      { title: "Redact sensitive information", body: "Merged body." },
      "K-0001",
      "2026-08-03",
    );

    expect(plan.sharedEntry.meta.status).toBe("active");
    expect(plan.sharedEntry.meta.created).toBe("2026-08-03");
    expect(plan.sharedEntry.meta.lastConfirmedAt).toBe("2026-08-03");
    expect(plan.sharedEntry.meta.layer).toBe("L2");
    expect(plan.sharedEntry.meta.id).toBe("K-0001");
  });

  test("shared entry carries merged title and body", () => {
    const sources = [
      {
        skill: "fo-session-save",
        file: "/path/a.md",
        entry: makeEntry("K-0001", "Redact sensitive information", { confirmations: 3 }),
      },
    ];

    const plan = planPromotion(
      sources,
      { title: "Redact sensitive information", body: "Merged body." },
      "K-0001",
      "2026-08-03",
    );

    expect(plan.sharedEntry.title).toBe("Redact sensitive information");
    expect(plan.sharedEntry.body).toBe("Merged body.");
  });

  test("single source — confirmations from one entry", () => {
    const sources = [
      {
        skill: "grilling",
        file: "/path/a.md",
        entry: makeEntry("K-0001", "Test principle", { confirmations: 7 }),
      },
    ];

    const plan = planPromotion(
      sources,
      { title: "Test principle", body: "Body." },
      "K-0001",
      "2026-08-03",
    );

    expect(plan.sharedEntry.meta.confirmations).toBe(7);
    expect(plan.localPointers).toHaveLength(1);
  });
});
