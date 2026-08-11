/*
<MODULE_CONTRACT>
<purpose>Unit tests for note.link.validate command handler (RFC-0808).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial note.link.validate tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runNoteLinkValidate } from "../../../src/validators/note-link-validate.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-note-link-test-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("note.link.validate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects broken wikilinks", () => {
    writeFile(
      tempDir,
      "vault/note-1.md",
      "---\ntitle: Note 1\n---\nLink to [[note-2]] and [[missing-note]].",
    );
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nBack to [[note-1]].");

    const result = runNoteLinkValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(1);
    expect(result.data!.violations[0].rule).toBe("NOTE-01");
    expect(result.data!.violations[0].file).toBe("vault/note-1.md");
    expect(result.data!.violations[0].message).toContain("missing-note");
    expect(result.exitCode).toBe(1);
  });

  it("passes when all links resolve", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntitle: Note 1\n---\nLink to [[note-2]].");
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nBack to [[note-1]].");

    const result = runNoteLinkValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("resolves aliases", () => {
    writeFile(
      tempDir,
      "vault/note-1.md",
      "---\ntitle: Note 1\naliases: [alias-1]\n---\nLink to [[alias-1]].",
    );

    const result = runNoteLinkValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles empty vault", () => {
    fs.mkdirSync(path.join(tempDir, "vault"), { recursive: true });

    const result = runNoteLinkValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles missing vault directory", () => {
    const result = runNoteLinkValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("supports --path flag for scoping", () => {
    writeFile(tempDir, "vault/chapters/ch-1.md", "---\ntitle: Ch 1\n---\nLink to [[ch-2]].");
    writeFile(tempDir, "vault/chapters/ch-2.md", "---\ntitle: Ch 2\n---\nBack to [[ch-1]].");
    writeFile(tempDir, "vault/appendix/app-a.md", "---\ntitle: App A\n---\nLink to [[missing]].");

    const result = runNoteLinkValidate({ flags: { path: "chapters" } }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles link aliases with pipe and hash", () => {
    writeFile(
      tempDir,
      "vault/note-1.md",
      "---\ntitle: Note 1\n---\nLink to [[note-2|display]] and [[note-2#section]].",
    );
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nContent.");

    const result = runNoteLinkValidate({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.violations).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});
