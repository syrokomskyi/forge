/*
<MODULE_CONTRACT>
<purpose>Unit tests for note.orphan.detect command handler (RFC-0808).</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0808: initial note.orphan.detect tests.</item>
</CHANGE_SUMMARY>
*/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runNoteOrphanDetect } from "../../../src/validators/note-orphan-detect.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-note-orphan-test-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

describe("note.orphan.detect", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects orphan notes with zero inbound links", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntitle: Note 1\n---\nLink to [[note-2]].");
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nBack to [[note-1]].");
    writeFile(tempDir, "vault/orphan.md", "---\ntitle: Orphan\n---\nNobody links to me.");

    const result = runNoteOrphanDetect({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.orphans).toHaveLength(1);
    expect(result.data!.orphans[0].file).toBe("vault/orphan.md");
    expect(result.data!.orphans[0].inboundLinks).toBe(0);
    expect(result.data!.orphans[0].severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("does not report notes with inbound links", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntitle: Note 1\n---\nLink to [[note-2]].");
    writeFile(tempDir, "vault/note-2.md", "---\ntitle: Note 2\n---\nBack to [[note-1]].");

    const result = runNoteOrphanDetect({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.orphans).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles empty vault", () => {
    fs.mkdirSync(path.join(tempDir, "vault"), { recursive: true });

    const result = runNoteOrphanDetect({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.orphans).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("handles missing vault directory", () => {
    const result = runNoteOrphanDetect({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.orphans).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("always exits zero (warnings, not errors)", () => {
    writeFile(tempDir, "vault/orphan.md", "---\ntitle: Orphan\n---\nNobody links to me.");

    const result = runNoteOrphanDetect({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.orphans).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });

  it("does not count self-links as inbound", () => {
    writeFile(tempDir, "vault/note-1.md", "---\ntitle: Note 1\n---\nLink to [[note-1]].");

    const result = runNoteOrphanDetect({ flags: {} }, { workspaceRoot: tempDir });

    expect(result.data!.orphans).toHaveLength(1);
    expect(result.data!.orphans[0].file).toBe("vault/note-1.md");
  });
});
