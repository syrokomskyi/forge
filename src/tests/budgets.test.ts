import { test, expect, describe } from "vitest";
import { computeLayerBudgets, resolveKnowledgeBudgets, DEFAULT_KNOWLEDGE_BUDGETS } from "../knowledge/budgets.ts";
import type { ParsedKnowledgeFile, KnowledgeLayer } from "../knowledge/schema.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Helper: create a minimal ParsedKnowledgeFile for testing
function makeParsedFile(
  overrides: Partial<ParsedKnowledgeFile> = {},
): ParsedKnowledgeFile {
  return {
    path: "/tmp/test/learned-principles.md",
    layer: "L2",
    preamble: "",
    entries: [],
    legacySections: [],
    parseIssues: [],
    isKnowledgeAdjacent: false,
    ...overrides,
  };
}

// Helper: create an active L2 entry
function makeActiveEntry(id: string, body: string) {
  return {
    meta: {
      id,
      layer: "L2" as KnowledgeLayer,
      created: "2026-01-01",
      lastConfirmedAt: "2026-01-10",
      confirmations: 3,
      status: "active" as const,
    },
    title: `Entry ${id}`,
    body,
    lineStart: 1,
  };
}

describe("resolveKnowledgeBudgets", () => {
  test("returns defaults when forge.yaml not found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
    try {
      const budgets = resolveKnowledgeBudgets(tmpDir);
      expect(budgets).toEqual(DEFAULT_KNOWLEDGE_BUDGETS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns defaults when no knowledge.budgets override", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  commands:\n    validateRfc: null\n",
      );
      const budgets = resolveKnowledgeBudgets(tmpDir);
      expect(budgets).toEqual(DEFAULT_KNOWLEDGE_BUDGETS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("applies override when present and valid", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    budgets:\n      hot: 2048\n      warm: 4096\n",
      );
      const budgets = resolveKnowledgeBudgets(tmpDir);
      expect(budgets).toEqual({ hot: 2048, warm: 4096 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to defaults when override values are invalid (non-positive)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    budgets:\n      hot: 0\n      warm: -1\n",
      );
      const budgets = resolveKnowledgeBudgets(tmpDir);
      expect(budgets).toEqual(DEFAULT_KNOWLEDGE_BUDGETS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to defaults when override values are non-integer", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-test-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    budgets:\n      hot: 3.5\n      warm: 8192\n",
      );
      const budgets = resolveKnowledgeBudgets(tmpDir);
      expect(budgets).toEqual({ hot: DEFAULT_KNOWLEDGE_BUDGETS.hot, warm: 8192 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("computeLayerBudgets", () => {
  test("counts only active entries", () => {
    const file = makeParsedFile({
      entries: [
        makeActiveEntry("K-0001", "Short body."),
        {
          meta: { id: "K-0002", layer: "L2", created: "2026-01-01", lastConfirmedAt: "2026-01-10", confirmations: 2, status: "stale" },
          title: "Stale entry",
          body: "This should not be counted.",
          lineStart: 10,
        },
      ],
    });
    const skillNames = new Map([["/tmp/test/learned-principles.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(1);
    // Only K-0001 (active) should be counted
    expect(reports[0].activeChars).toBeLessThan(DEFAULT_KNOWLEDGE_BUDGETS.hot);
    expect(reports[0].exceededBy).toBe(0);
  });

  test("reports exceeded budget for hot layer", () => {
    const longBody = "x".repeat(5000);
    const file = makeParsedFile({
      entries: [makeActiveEntry("K-0001", longBody)],
    });
    const skillNames = new Map([["/tmp/test/learned-principles.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(1);
    expect(reports[0].layer).toBe("L2");
    expect(reports[0].activeChars).toBeGreaterThan(DEFAULT_KNOWLEDGE_BUDGETS.hot);
    expect(reports[0].exceededBy).toBeGreaterThan(0);
  });

  test("skips files with undeterminable layer (null)", () => {
    const file = makeParsedFile({ layer: null });
    const skillNames = new Map([["/tmp/test/unknown.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(0);
  });

  test("skips L0 (cold) files — no budget by design", () => {
    const file = makeParsedFile({ layer: "L0" });
    const skillNames = new Map([["/tmp/test/qa-log.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(0);
  });

  test("skips files with parse issues", () => {
    const file = makeParsedFile({
      parseIssues: [{ line: 1, message: "Bad YAML" }],
    });
    const skillNames = new Map([["/tmp/test/learned-principles.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(0);
  });

  test("skips knowledge-adjacent files", () => {
    const file = makeParsedFile({ isKnowledgeAdjacent: true });
    const skillNames = new Map([["/tmp/test/learned-principles.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(0);
  });

  test("uses warm budget for L1 files", () => {
    const file = makeParsedFile({
      layer: "L1",
      path: "/tmp/test/fix-patterns.md",
      entries: [
        {
          meta: { id: "K-0001", layer: "L1", created: "2026-01-01", status: "active" },
          title: "Fix pattern",
          body: "x".repeat(9000),
          lineStart: 1,
        },
      ],
    });
    const skillNames = new Map([["/tmp/test/fix-patterns.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(1);
    expect(reports[0].layer).toBe("L1");
    expect(reports[0].budget).toBe(DEFAULT_KNOWLEDGE_BUDGETS.warm);
    expect(reports[0].exceededBy).toBeGreaterThan(0);
  });

  test("empty file produces zero-size report", () => {
    const file = makeParsedFile({ entries: [] });
    const skillNames = new Map([["/tmp/test/learned-principles.md", "test-skill"]]);
    const reports = computeLayerBudgets([file], DEFAULT_KNOWLEDGE_BUDGETS, skillNames);
    expect(reports).toHaveLength(1);
    expect(reports[0].activeChars).toBe(0);
    expect(reports[0].exceededBy).toBe(0);
  });
});
