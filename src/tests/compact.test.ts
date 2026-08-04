import { test, expect, describe } from "vitest";
import {
  planCompaction,
  executeCompaction,
  resolveRetentionDays,
  resolveStaleDays,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_STALE_DAYS,
  type CompactOptions,
} from "../knowledge/compact.ts";
import { parseKnowledgeFile } from "../knowledge/parse.ts";
import { serializeKnowledgeFile } from "../knowledge/serialize.ts";
import type {
  ParsedKnowledgeFile,
  KnowledgeLayer,
  KnowledgeEntryMeta,
} from "../knowledge/schema.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDir = path.join(os.tmpdir(), "test");

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
  // L2 requires confirmations and lastConfirmedAt per schema
  if (layer === "L2") {
    base.confirmations = 1;
    base.lastConfirmedAt = "2026-01-01";
  }
  return { ...base, ...overrides };
}

function makeParsedFile(overrides: Partial<ParsedKnowledgeFile> = {}): ParsedKnowledgeFile {
  return {
    path: path.join(testDir, "learned-principles.md"),
    layer: "L2",
    preamble: "",
    entries: [],
    legacySections: [],
    parseIssues: [],
    isKnowledgeAdjacent: false,
    ...overrides,
  };
}

function makeEntry(
  id: string,
  meta: Partial<KnowledgeEntryMeta>,
  body = "Body text.",
): {
  meta: KnowledgeEntryMeta;
  title: string;
  body: string;
  lineStart: number;
} {
  return {
    meta: makeMeta({ id, ...meta }),
    title: `Entry ${id}`,
    body,
    lineStart: 1,
  };
}

function writeTempKnowledgeFile(
  content: string,
  fileName: string,
): { filePath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-test-"));
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, "utf8");
  return { filePath, dir };
}

function buildKnowledgeMarkdown(
  layer: KnowledgeLayer,
  entries: KnowledgeEntryMeta[],
  fileName: string,
): string {
  const parts: string[] = [`<!-- knowledge-layer: ${layer} -->`, `# ${fileName}`, ""];
  for (const meta of entries) {
    parts.push(`### ${meta.id}: Test entry`);
    parts.push("");
    parts.push("```knowledge-entry");
    parts.push(`id: ${meta.id}`);
    parts.push(`layer: ${meta.layer}`);
    parts.push(`created: ${meta.created}`);
    if (meta.lastConfirmedAt !== undefined)
      parts.push(`lastConfirmedAt: ${meta.lastConfirmedAt ?? "null"}`);
    if (meta.confirmations !== undefined) parts.push(`confirmations: ${meta.confirmations}`);
    if (meta.expiresAt !== undefined) parts.push(`expiresAt: ${meta.expiresAt ?? "null"}`);
    if (meta.supersedes !== undefined) parts.push(`supersedes: [${meta.supersedes.join(", ")}]`);
    if (meta.promotedTo !== undefined) parts.push(`promotedTo: ${meta.promotedTo ?? "null"}`);
    parts.push(`status: ${meta.status}`);
    parts.push("```");
    parts.push("");
    parts.push("Body text for this entry.");
    parts.push("");
  }
  return parts.join("\n");
}

const TODAY = "2026-08-03";
const DEFAULT_OPTIONS: CompactOptions = {
  retentionDays: 90,
  staleDays: 90,
  today: TODAY,
};

// ---------------------------------------------------------------------------
// planCompaction tests
// ---------------------------------------------------------------------------

describe("planCompaction", () => {
  test("returns empty plan for file with no entries", () => {
    const file = makeParsedFile({ entries: [] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans).toHaveLength(1);
    expect(plans[0].actions).toHaveLength(0);
    expect(plans[0].legacySectionCount).toBe(0);
  });

  test("skips knowledge-adjacent files", () => {
    const file = makeParsedFile({ isKnowledgeAdjacent: true });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans).toHaveLength(0);
  });

  test("archive-expired: entry with expiresAt in the past", () => {
    const entry = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-01-01",
      expiresAt: "2026-07-01",
      status: "active",
    });
    const file = makeParsedFile({ entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(1);
    expect(plans[0].actions[0].kind).toBe("archive-expired");
    expect(plans[0].actions[0].entryId).toBe("K-0001");
    expect(plans[0].actions[0].reason).toContain("expiresAt 2026-07-01");
  });

  test("does NOT archive-expired when expiresAt is today or future", () => {
    const entryToday = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-07-01",
      lastConfirmedAt: "2026-07-15",
      confirmations: 1,
      expiresAt: TODAY,
      status: "active",
    });
    const entryFuture = makeEntry("K-0002", {
      layer: "L2",
      created: "2026-07-01",
      lastConfirmedAt: "2026-07-15",
      confirmations: 1,
      expiresAt: "2026-12-31",
      status: "active",
    });
    const file = makeParsedFile({ entries: [entryToday, entryFuture] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(0);
  });

  test("archive-superseded: entry with status superseded", () => {
    const entry = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-01-01",
      status: "superseded",
    });
    const file = makeParsedFile({ entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(1);
    expect(plans[0].actions[0].kind).toBe("archive-superseded");
  });

  test("archive-l0-retention: L0 entry older than retentionDays", () => {
    const entry = makeEntry("K-0001", {
      layer: "L0",
      created: "2026-01-01",
      status: "active",
    });
    const file = makeParsedFile({ layer: "L0", entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(1);
    expect(plans[0].actions[0].kind).toBe("archive-l0-retention");
    expect(plans[0].actions[0].reason).toContain("older than 90 days");
  });

  test("does NOT archive-l0-retention when L0 entry is within retention", () => {
    const entry = makeEntry("K-0001", {
      layer: "L0",
      created: "2026-07-01",
      status: "active",
    });
    const file = makeParsedFile({ layer: "L0", entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(0);
  });

  test("mark-stale: L2 active entry with old lastConfirmedAt", () => {
    const entry = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-01-01",
      lastConfirmedAt: "2026-01-15",
      confirmations: 3,
      status: "active",
    });
    const file = makeParsedFile({ layer: "L2", entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(1);
    expect(plans[0].actions[0].kind).toBe("mark-stale");
    expect(plans[0].actions[0].reason).toContain("lastConfirmedAt 2026-01-15");
  });

  test("does NOT mark-stale when lastConfirmedAt is within staleDays", () => {
    const entry = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-01-01",
      lastConfirmedAt: "2026-07-01",
      confirmations: 3,
      status: "active",
    });
    const file = makeParsedFile({ layer: "L2", entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(0);
  });

  test("does NOT mark-stale for L1 entries (only L2)", () => {
    const entry = makeEntry("K-0001", {
      layer: "L1",
      created: "2026-01-01",
      status: "active",
    });
    const file = makeParsedFile({ layer: "L1", entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(0);
  });

  test("does NOT mark-stale when status is already stale", () => {
    const entry = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-01-01",
      lastConfirmedAt: "2026-01-15",
      confirmations: 3,
      status: "stale",
    });
    const file = makeParsedFile({ layer: "L2", entries: [entry] });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].actions).toHaveLength(0);
  });

  test("reports legacy section count", () => {
    const file = makeParsedFile({
      legacySections: [
        { text: "## Old section\n\nSome prose.", lineStart: 10 },
        { text: "## Another old section\n\nMore prose.", lineStart: 20 },
      ],
    });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].legacySectionCount).toBe(2);
  });

  test("respects custom retentionDays", () => {
    const entry = makeEntry("K-0001", {
      layer: "L0",
      created: "2026-07-01",
      status: "active",
    });
    const file = makeParsedFile({ layer: "L0", entries: [entry] });
    const plans = planCompaction([file], { ...DEFAULT_OPTIONS, retentionDays: 10 });
    expect(plans[0].actions).toHaveLength(1);
    expect(plans[0].actions[0].kind).toBe("archive-l0-retention");
  });

  test("respects custom staleDays", () => {
    const entry = makeEntry("K-0001", {
      layer: "L2",
      created: "2026-01-01",
      lastConfirmedAt: "2026-07-15",
      confirmations: 3,
      status: "active",
    });
    const file = makeParsedFile({ layer: "L2", entries: [entry] });
    const plans = planCompaction([file], { ...DEFAULT_OPTIONS, staleDays: 10 });
    expect(plans[0].actions).toHaveLength(1);
    expect(plans[0].actions[0].kind).toBe("mark-stale");
  });

  test("archiveFile path is correct for qa-log.md", () => {
    const file = makeParsedFile({ path: path.join(testDir, "qa-log.md"), layer: "L0" });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].archiveFile).toBe(path.join(testDir, "qa-log.archive.md"));
  });

  test("archiveFile path is correct for learned-principles.md", () => {
    const file = makeParsedFile({ path: path.join(testDir, "learned-principles.md"), layer: "L2" });
    const plans = planCompaction([file], DEFAULT_OPTIONS);
    expect(plans[0].archiveFile).toBe(path.join(testDir, "learned-principles.archive.md"));
  });
});

// ---------------------------------------------------------------------------
// executeCompaction tests
// ---------------------------------------------------------------------------

describe("executeCompaction", () => {
  test("dry-run produces no writes", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-01-15",
            confirmations: 3,
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      const report = executeCompaction(plans, true); // dry-run

      expect(report.status).toBe("pass");
      expect(report.dryRun).toBe(true);
      expect(report.totals.markedStale).toBe(1);
      expect(report.files[0].written).toBe(false);

      // File should be unchanged
      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toContain("status: active");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mark-stale writes updated status to live file", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-01-15",
            confirmations: 3,
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      const report = executeCompaction(plans, false); // live run

      expect(report.status).toBe("pass");
      expect(report.totals.markedStale).toBe(1);

      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toContain("status: stale");
      expect(content).not.toContain("status: active");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive-expired moves entry to archive companion", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-01-15",
            confirmations: 3,
            expiresAt: "2026-07-01",
            status: "active",
          }),
          makeMeta({
            id: "K-0002",
            layer: "L2",
            created: "2026-07-01",
            lastConfirmedAt: "2026-07-15",
            confirmations: 1,
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      const report = executeCompaction(plans, false); // live run

      expect(report.status).toBe("pass");
      expect(report.totals.archived).toBe(1);

      // Live file should only have K-0002
      const liveContent = fs.readFileSync(filePath, "utf8");
      expect(liveContent).not.toContain("K-0001");
      expect(liveContent).toContain("K-0002");

      // Archive file should have K-0001 with status: archived
      const archivePath = path.join(dir, "learned-principles.archive.md");
      expect(fs.existsSync(archivePath)).toBe(true);
      const archiveContent = fs.readFileSync(archivePath, "utf8");
      expect(archiveContent).toContain("K-0001");
      expect(archiveContent).toContain("status: archived");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive-superseded preserves status as superseded in archive", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-01-15",
            confirmations: 3,
            status: "superseded",
          }),
          makeMeta({
            id: "K-0002",
            layer: "L2",
            created: "2026-02-01",
            lastConfirmedAt: "2026-07-15",
            confirmations: 1,
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      const report = executeCompaction(plans, false);

      expect(report.totals.archived).toBe(1);

      const archivePath = path.join(dir, "learned-principles.archive.md");
      const archiveContent = fs.readFileSync(archivePath, "utf8");
      expect(archiveContent).toContain("K-0001");
      expect(archiveContent).toContain("status: superseded");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("archive-l0-retention moves L0 entries to qa-log.archive.md", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L0",
        [
          makeMeta({
            id: "K-0001",
            layer: "L0",
            created: "2026-01-01",
            status: "active",
          }),
        ],
        "qa-log.md",
      ),
      "qa-log.md",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      const report = executeCompaction(plans, false);

      expect(report.totals.archived).toBe(1);

      const archivePath = path.join(dir, "qa-log.archive.md");
      expect(fs.existsSync(archivePath)).toBe(true);
      const archiveContent = fs.readFileSync(archivePath, "utf8");
      expect(archiveContent).toContain("K-0001");
      expect(archiveContent).toContain("status: archived");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append-merge: existing archive companion receives new entries", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0003",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-01-15",
            confirmations: 3,
            expiresAt: "2026-07-01",
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    // Pre-create archive companion with an existing entry
    const archivePath = path.join(dir, "learned-principles.archive.md");
    fs.writeFileSync(
      archivePath,
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2025-01-01",
            lastConfirmedAt: "2025-01-15",
            confirmations: 5,
            status: "archived",
          }),
        ],
        "learned-principles.archive.md",
      ),
      "utf8",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      const report = executeCompaction(plans, false);

      expect(report.totals.archived).toBe(1);

      const archiveContent = fs.readFileSync(archivePath, "utf8");
      // Both old and new entries should be present
      expect(archiveContent).toContain("K-0001");
      expect(archiveContent).toContain("K-0003");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to compact file with parse issues", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-test-"));
    const filePath = path.join(dir, "learned-principles.md");
    // Write a file with a bad metadata block to trigger parse issues
    fs.writeFileSync(
      filePath,
      "<!-- knowledge-layer: L2 -->\n# learned-principles.md\n\n### K-0001: Test\n\n```knowledge-entry\nid: K-0001\nlayer: INVALID\ncreated: not-a-date\nstatus: active\n```\n\nBody.\n",
      "utf8",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      // If the parser produces parse issues, executeCompaction should refuse
      if (parsed.parseIssues.length > 0) {
        const plans = planCompaction([parsed], DEFAULT_OPTIONS);
        const report = executeCompaction(plans, false);

        expect(report.status).toBe("fail");
        expect(report.errors).toBeDefined();
        expect(report.errors!.length).toBeGreaterThan(0);
        expect(report.files[0].written).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no actions on a file produces no writes", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2026-07-01",
            lastConfirmedAt: "2026-07-15",
            confirmations: 1,
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    try {
      const originalContent = fs.readFileSync(filePath, "utf8");
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);
      expect(plans[0].actions).toHaveLength(0);

      const report = executeCompaction(plans, false);
      expect(report.status).toBe("pass");
      expect(report.totals.archived).toBe(0);
      expect(report.totals.markedStale).toBe(0);

      // File should be unchanged
      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toBe(originalContent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round-trip property: active, non-expired entries are byte-identical after a run
// ---------------------------------------------------------------------------

describe("Round-trip: active entries preserved", () => {
  test("active entry body is preserved after mark-stale on another entry", () => {
    const { filePath, dir } = writeTempKnowledgeFile(
      buildKnowledgeMarkdown(
        "L2",
        [
          makeMeta({
            id: "K-0001",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-07-15",
            confirmations: 1,
            status: "active",
          }),
          makeMeta({
            id: "K-0002",
            layer: "L2",
            created: "2026-01-01",
            lastConfirmedAt: "2026-01-15",
            confirmations: 2,
            status: "active",
          }),
        ],
        "learned-principles.md",
      ),
      "learned-principles.md",
    );

    try {
      const parsed = parseKnowledgeFile(filePath);
      const plans = planCompaction([parsed], DEFAULT_OPTIONS);

      // K-0002 should be mark-stale, K-0001 should have no action
      const k1Action = plans[0].actions.find((a) => a.entryId === "K-0001");
      const k2Action = plans[0].actions.find((a) => a.entryId === "K-0002");
      expect(k1Action).toBeUndefined();
      expect(k2Action?.kind).toBe("mark-stale");

      executeCompaction(plans, false);

      // Re-parse and check K-0001 is still active, K-0002 is stale
      const reparsed = parseKnowledgeFile(filePath);
      const k1 = reparsed.entries.find((e) => e.meta.id === "K-0001");
      const k2 = reparsed.entries.find((e) => e.meta.id === "K-0002");
      expect(k1?.meta.status).toBe("active");
      expect(k2?.meta.status).toBe("stale");
      // K-0001 body should be preserved
      expect(k1?.body).toContain("Body text for this entry.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveRetentionDays / resolveStaleDays tests
// ---------------------------------------------------------------------------

describe("resolveRetentionDays", () => {
  test("returns default when forge.yaml not found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      const days = resolveRetentionDays(tmpDir);
      expect(days).toBe(DEFAULT_RETENTION_DAYS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns default when no knowledge.retentionDays override", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  commands:\n    validateRfc: null\n",
      );
      const days = resolveRetentionDays(tmpDir);
      expect(days).toBe(DEFAULT_RETENTION_DAYS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("applies override when present and valid", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    retentionDays: 30\n",
      );
      const days = resolveRetentionDays(tmpDir);
      expect(days).toBe(30);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to default when override is invalid (non-positive)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    retentionDays: 0\n",
      );
      const days = resolveRetentionDays(tmpDir);
      expect(days).toBe(DEFAULT_RETENTION_DAYS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveStaleDays", () => {
  test("returns default when forge.yaml not found", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      const days = resolveStaleDays(tmpDir);
      expect(days).toBe(DEFAULT_STALE_DAYS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("applies override when present and valid", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    staleDays: 45\n",
      );
      const days = resolveStaleDays(tmpDir);
      expect(days).toBe(45);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("falls back to default when override is non-integer", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-compact-cfg-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "forge.yaml"),
        "schema: forge/bindings@1\nbindings:\n  knowledge:\n    staleDays: 3.5\n",
      );
      const days = resolveStaleDays(tmpDir);
      expect(days).toBe(DEFAULT_STALE_DAYS);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
