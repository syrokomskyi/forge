/*
<MODULE_CONTRACT>
<purpose>Unit tests for note.frontmatter.validate command handler (RFC-0808).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial note.frontmatter.validate tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runNoteFrontmatterValidate } from "../../../src/validators/note-frontmatter-validate.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-note-frontmatter-test-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("note.frontmatter.validate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects missing title field", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntags: [a]\n---\nNo title here.");
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nHas title.");

    const result = runNoteFrontmatterValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(1);
    expect(result.data!.violations[0].rule).toBe("NOTE-02");
    expect(result.data!.violations[0].file).toBe("vault/note-1.md");
    expect(result.data!.violations[0].field).toBe("title");
    expect(result.exitCode).toBe(1);
  });

  it("falls back to first H1 for title", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntags: [a]\n---\n# My Title\nContent.");

    const result = runNoteFrontmatterValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("flags files without frontmatter", () => {
    writeFile(tempDir, "vault/note-1.md", "No frontmatter here.");

    const result = runNoteFrontmatterValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(1);
    expect(result.data!.violations[0].message).toContain("no frontmatter");
    expect(result.exitCode).toBe(1);
  });

  it("passes when title is present", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntitle: Note 1\n---\nContent.");

    const result = runNoteFrontmatterValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles empty vault", () => {
    fs.mkdirSync(path.join(tempDir, "vault"), { recursive: true });

    const result = runNoteFrontmatterValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles missing vault directory", () => {
    const result = runNoteFrontmatterValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});
