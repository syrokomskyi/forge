/*
<MODULE_CONTRACT>
<purpose>Unit tests for the append-only knowledge sync (syncKnowledgeFile / planKnowledgeSync) — covers copy, merge by entry-ID union, conflict handling, skip semantics, and directory recursion.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>2026-09-24: initial tests for append-only knowledge sync.</item>
</CHANGE_SUMMARY>
*/

import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planKnowledgeSync, syncKnowledgeFile } from "../sync.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "forge-knowledge-sync-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function entry(id: string, title: string, body: string, layer = "L0"): string {
  const confirmations =
    layer === "L2" ? `lastConfirmedAt: 2026-08-03\nconfirmations: 1\n` : "";
  return `### ${id}: ${title}\n\n\`\`\`knowledge-entry\nid: ${id}\nlayer: ${layer}\ncreated: 2026-08-03\n${confirmations}status: active\n\`\`\`\n\n${body}\n`;
}

function knowledgeFile(layer: string, entries: string[]): string {
  return `<!-- knowledge-layer: ${layer} -->\n\n# Knowledge (${layer})\n\n${entries.join("\n")}`;
}

test("copies file when destination does not exist", () => {
  const src = join(tempDir, "src", "qa-log.md");
  const dest = join(tempDir, "dest", "qa-log.md");
  mkdirSync(join(tempDir, "src"), { recursive: true });
  const content = knowledgeFile("L0", [entry("K-0001", "First", "Body one.")]);
  writeFileSync(src, content, "utf8");

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("copied");
  expect(readFileSync(dest, "utf8")).toBe(content);
});

test("unchanged when contents are identical", () => {
  const src = join(tempDir, "qa-log.md");
  const dest = join(tempDir, "dest.md");
  const content = knowledgeFile("L0", [entry("K-0001", "First", "Body one.")]);
  writeFileSync(src, content, "utf8");
  writeFileSync(dest, content, "utf8");

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("unchanged");
});

test("merges: local entries preserved, new source entries appended", () => {
  const src = join(tempDir, "qa-log.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(
    src,
    knowledgeFile("L0", [
      entry("K-0001", "First", "Package body."),
      entry("K-0002", "Second", "New package entry."),
    ]),
    "utf8",
  );
  writeFileSync(
    dest,
    knowledgeFile("L0", [
      entry("K-0001", "First", "Locally edited body."),
      entry("K-0057", "Local accumulation", "Project-specific record."),
    ]),
    "utf8",
  );

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("merged");
  expect(result.appended).toEqual(["K-0002"]);
  expect(result.conflicts).toEqual(["K-0001"]);

  const merged = readFileSync(dest, "utf8");
  // Local version of the conflicting entry wins
  expect(merged).toContain("Locally edited body.");
  expect(merged).not.toContain("Package body.");
  // Local accumulated entry preserved
  expect(merged).toContain("K-0057");
  expect(merged).toContain("Project-specific record.");
  // New source entry appended
  expect(merged).toContain("K-0002");
  expect(merged).toContain("New package entry.");
});

test("merge into empty template appends all source entries", () => {
  const src = join(tempDir, "qa-log.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(
    src,
    knowledgeFile("L0", [entry("K-0001", "First", "Body one.")]),
    "utf8",
  );
  // Destination is the shipped empty template (layer marker, no entries)
  writeFileSync(dest, `<!-- knowledge-layer: L0 -->\n\n# Q&A Log (L0)\n`, "utf8");

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("merged");
  expect(result.appended).toEqual(["K-0001"]);
  expect(readFileSync(dest, "utf8")).toContain("K-0001");
});

test("unchanged when source has no new entries (conflicts only)", () => {
  const src = join(tempDir, "qa-log.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(src, knowledgeFile("L0", [entry("K-0001", "First", "Package body.")]), "utf8");
  writeFileSync(
    dest,
    knowledgeFile("L0", [
      entry("K-0001", "First", "Locally edited body."),
      entry("K-0002", "Local extra", "Local only."),
    ]),
    "utf8",
  );

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("unchanged");
  expect(result.conflicts).toEqual(["K-0001"]);
  // File untouched — local content preserved byte-for-byte
  expect(readFileSync(dest, "utf8")).toContain("Locally edited body.");
});

test("skips divergent non-cumulative destination (knowledge-adjacent)", () => {
  const src = join(tempDir, "forge-about.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(src, "# Forge\n\nNew package template text.\n", "utf8");
  const localContent = "# Forge\n\nLocally filled-in project description.\n";
  writeFileSync(dest, localContent, "utf8");

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("skipped");
  expect(readFileSync(dest, "utf8")).toBe(localContent);
});

test("skips when destination is cumulative but source is not", () => {
  const src = join(tempDir, "notes.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(src, "# Plain notes\n\nPackage rewrite.\n", "utf8");
  const localContent = knowledgeFile("L0", [entry("K-0001", "First", "Local body.")]);
  writeFileSync(dest, localContent, "utf8");

  const result = syncKnowledgeFile(src, dest);

  expect(result.action).toBe("skipped");
  expect(readFileSync(dest, "utf8")).toBe(localContent);
});

test("recurses into declared directories", () => {
  const srcDir = join(tempDir, "gallery");
  const destDir = join(tempDir, "dest-gallery");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "a.md"), "A package\n", "utf8");
  writeFileSync(join(srcDir, "b.md"), "B package\n", "utf8");
  mkdirSync(destDir, { recursive: true });
  writeFileSync(join(destDir, "b.md"), "B local edits\n", "utf8");

  const result = syncKnowledgeFile(srcDir, destDir);

  expect(result.action).toBe("copied");
  expect(readFileSync(join(destDir, "a.md"), "utf8")).toBe("A package\n");
  // Existing local file preserved (non-cumulative → skipped)
  expect(readFileSync(join(destDir, "b.md"), "utf8")).toBe("B local edits\n");
});

test("planKnowledgeSync reports merged without writing", () => {
  const src = join(tempDir, "qa-log.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(
    src,
    knowledgeFile("L0", [
      entry("K-0001", "First", "Body one."),
      entry("K-0002", "Second", "Body two."),
    ]),
    "utf8",
  );
  const localContent = knowledgeFile("L0", [entry("K-0001", "First", "Body one.")]);
  writeFileSync(dest, localContent, "utf8");

  const plan = planKnowledgeSync(src, dest);

  expect(plan.action).toBe("merged");
  expect(plan.appended).toEqual(["K-0002"]);
  expect(plan.content).not.toBeNull();
  // No write happened
  expect(readFileSync(dest, "utf8")).toBe(localContent);
});

test("planKnowledgeSync reports unchanged for locally accumulated file", () => {
  const src = join(tempDir, "qa-log.md");
  const dest = join(tempDir, "dest.md");
  writeFileSync(src, knowledgeFile("L0", [entry("K-0001", "First", "Body one.")]), "utf8");
  writeFileSync(
    dest,
    knowledgeFile("L0", [
      entry("K-0001", "First", "Body one."),
      entry("K-0002", "Local", "Accumulated locally."),
    ]),
    "utf8",
  );

  const plan = planKnowledgeSync(src, dest);

  // Local superset — nothing to merge, not stale
  expect(plan.action).toBe("unchanged");
});

test("missing source returns unchanged", () => {
  const result = syncKnowledgeFile(join(tempDir, "nope.md"), join(tempDir, "dest.md"));
  expect(result.action).toBe("unchanged");
  expect(existsSync(join(tempDir, "dest.md"))).toBe(false);
});
