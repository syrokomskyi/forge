import { describe, it, expect } from "vitest";
import { normalizeTitle, detectDuplicatePrinciples, planPromotion } from "../promote.ts";
import type {
  ParsedKnowledgeFile,
  KnowledgeEntry,
  KnowledgeEntryMeta,
  ParseIssue,
} from "../schema.ts";

function makeMeta(overrides: Partial<KnowledgeEntryMeta> = {}): KnowledgeEntryMeta {
  return {
    id: "K-0001",
    layer: "L1",
    created: "2026-01-01",
    lastConfirmedAt: "2026-01-01",
    confirmations: 1,
    status: "active",
    ...overrides,
  };
}

function makeEntry(title: string, meta?: Partial<KnowledgeEntryMeta>): KnowledgeEntry {
  return { meta: makeMeta(meta), title, body: "", lineStart: 0 };
}

function makeParsedFile(entries: KnowledgeEntry[], issues: ParseIssue[] = []): ParsedKnowledgeFile {
  return {
    path: "qa-log.md",
    layer: "L1",
    preamble: "",
    entries,
    legacySections: [],
    isKnowledgeAdjacent: false,
    parseIssues: issues,
  };
}

describe("normalizeTitle", () => {
  it("lowercases and removes punctuation", () => {
    expect(normalizeTitle("Hello, World!")).toBe("hello world");
  });

  it("strips stop words", () => {
    expect(normalizeTitle("The Quick Brown Fox")).toBe("quick brown fox");
    expect(normalizeTitle("A Cat on a Mat")).toBe("cat on mat");
  });

  it("collapses whitespace", () => {
    expect(normalizeTitle("  Multiple   Spaces  ")).toBe("multiple spaces");
  });

  it("handles unicode letters", () => {
    expect(normalizeTitle("Übergröße Straße")).toBe("übergröße straße");
  });

  it("returns empty for all-stop-word input", () => {
    expect(normalizeTitle("the a an")).toBe("");
  });
});

describe("detectDuplicatePrinciples", () => {
  it("detects exact title matches across skills", () => {
    const files = [
      { skill: "skill-a", parsed: makeParsedFile([makeEntry("Always Check Types")]) },
      { skill: "skill-b", parsed: makeParsedFile([makeEntry("Always Check Types")]) },
    ];
    const dupes = detectDuplicatePrinciples(files);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].kind).toBe("exact");
  });

  it("skips stale and archived entries", () => {
    const files = [
      {
        skill: "skill-a",
        parsed: makeParsedFile([makeEntry("Same Title", { id: "K-0001", status: "stale" })]),
      },
      {
        skill: "skill-b",
        parsed: makeParsedFile([makeEntry("Same Title", { id: "K-0002", status: "archived" })]),
      },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });

  it("skips already-promoted entries", () => {
    const files = [
      {
        skill: "skill-a",
        parsed: makeParsedFile([makeEntry("Title", { id: "K-0001", promotedTo: "shared/K-0002" })]),
      },
      { skill: "skill-b", parsed: makeParsedFile([makeEntry("Title", { id: "K-0002" })]) },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });

  it("skips linked pairs via supersedes", () => {
    const files = [
      {
        skill: "skill-a",
        parsed: makeParsedFile([makeEntry("Same Title", { supersedes: ["K-0002"] })]),
      },
      { skill: "skill-b", parsed: makeParsedFile([makeEntry("Same Title", { id: "K-0002" })]) },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });

  it("skips knowledge-adjacent files", () => {
    const parsed = makeParsedFile([makeEntry("Title", { id: "K-0001" })]);
    parsed.isKnowledgeAdjacent = true;
    const files = [
      { skill: "skill-a", parsed },
      { skill: "skill-b", parsed: makeParsedFile([makeEntry("Title", { id: "K-0002" })]) },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });

  it("skips files with parse issues", () => {
    const files = [
      {
        skill: "skill-a",
        parsed: makeParsedFile(
          [makeEntry("Title", { id: "K-0001" })],
          [{ line: 1, message: "bad" }],
        ),
      },
      { skill: "skill-b", parsed: makeParsedFile([makeEntry("Title", { id: "K-0002" })]) },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });

  it("detects containment when shorter title is substring of longer", () => {
    const files = [
      {
        skill: "skill-a",
        parsed: makeParsedFile([
          makeEntry("Always validate input before processing", { id: "K-0001" }),
        ]),
      },
      {
        skill: "skill-b",
        parsed: makeParsedFile([
          makeEntry("Always validate input before processing and after", { id: "K-0002" }),
        ]),
      },
    ];
    const dupes = detectDuplicatePrinciples(files);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].kind).toBe("containment");
  });

  it("does not detect containment for very short titles", () => {
    const files = [
      { skill: "skill-a", parsed: makeParsedFile([makeEntry("Check types", { id: "K-0001" })]) },
      {
        skill: "skill-b",
        parsed: makeParsedFile([makeEntry("Check types and more", { id: "K-0002" })]),
      },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });

  it("returns empty for no duplicates", () => {
    const files = [
      { skill: "skill-a", parsed: makeParsedFile([makeEntry("Unique Title A", { id: "K-0001" })]) },
      { skill: "skill-b", parsed: makeParsedFile([makeEntry("Unique Title B", { id: "K-0002" })]) },
    ];
    expect(detectDuplicatePrinciples(files)).toHaveLength(0);
  });
});

describe("planPromotion", () => {
  it("creates shared entry with summed confirmations", () => {
    const sources = [
      {
        skill: "skill-a",
        file: "qa-log.md",
        entry: makeEntry("Shared Principle", { id: "K-0001", confirmations: 3 }),
      },
      {
        skill: "skill-b",
        file: "qa-log.md",
        entry: makeEntry("Shared Principle", { id: "K-0002", confirmations: 5 }),
      },
    ];
    const plan = planPromotion(
      sources,
      { title: "Merged", body: "Combined body" },
      "K-0099",
      "2026-08-20",
    );
    expect(plan.sharedEntry.meta.id).toBe("K-0099");
    expect(plan.sharedEntry.meta.layer).toBe("L2");
    expect(plan.sharedEntry.meta.confirmations).toBe(8);
    expect(plan.sharedEntry.meta.promotedFrom).toEqual(["skill-a/K-0001", "skill-b/K-0002"]);
    expect(plan.sharedEntry.title).toBe("Merged");
    expect(plan.sharedEntry.body).toBe("Combined body");
  });

  it("creates local pointers for each source", () => {
    const sources = [
      { skill: "skill-a", file: "qa-log.md", entry: makeEntry("Title", { id: "K-0001" }) },
      { skill: "skill-b", file: "learned.md", entry: makeEntry("Title", { id: "K-0002" }) },
    ];
    const plan = planPromotion(sources, { title: "M", body: "B" }, "K-0099", "2026-01-01");
    expect(plan.localPointers).toEqual([
      { skill: "skill-a", file: "qa-log.md", entryId: "K-0001" },
      { skill: "skill-b", file: "learned.md", entryId: "K-0002" },
    ]);
  });

  it("handles undefined confirmations as zero", () => {
    const sources = [
      { skill: "s", file: "f.md", entry: makeEntry("T", { confirmations: undefined }) },
    ];
    const plan = planPromotion(sources, { title: "M", body: "B" }, "K-0099", "2026-01-01");
    expect(plan.sharedEntry.meta.confirmations).toBe(0);
  });
});
