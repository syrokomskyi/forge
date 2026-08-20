import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runNoteOrphanDetect } from "../note-orphan-detect.ts";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-orphan-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function createVaultFile(vaultDir: string, relPath: string, content: string) {
  const fullPath = join(vaultDir, relPath);
  const dir = join(fullPath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

describe("runNoteOrphanDetect", () => {
  it("returns empty when vault directory not found", () => {
    const result = runNoteOrphanDetect(
      { flags: { "vault-dir": "nonexistent" } },
      { workspaceRoot: tempDir },
    );
    expect(result.data?.count).toBe(0);
    expect(result.data?.orphans).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("detects orphan note with zero inbound links", async () => {
    const vaultDir = join(tempDir, "vault");
    await mkdir(vaultDir, { recursive: true });
    await createVaultFile(vaultDir, "linked.md", "# Linked\n\n[[target]]");
    await createVaultFile(vaultDir, "target.md", "# Target");
    await createVaultFile(vaultDir, "orphan.md", "# Orphan — nobody links to me");

    const result = runNoteOrphanDetect(
      { flags: { "vault-dir": "vault" } },
      { workspaceRoot: tempDir },
    );

    const orphanFiles = result.data?.orphans.map((o) => o.file) ?? [];
    expect(orphanFiles).toContain("vault/orphan.md");
    expect(orphanFiles).not.toContain("vault/target.md");
  });

  it("does not flag notes that are linked via alias", async () => {
    const vaultDir = join(tempDir, "vault");
    await mkdir(vaultDir, { recursive: true });
    await createVaultFile(vaultDir, "note.md", "---\naliases: [MyAlias]\n---\n# Note");
    await createVaultFile(vaultDir, "linker.md", "# Linker\n\n[[MyAlias]]");

    const result = runNoteOrphanDetect(
      { flags: { "vault-dir": "vault" } },
      { workspaceRoot: tempDir },
    );

    const orphanFiles = result.data?.orphans.map((o) => o.file) ?? [];
    expect(orphanFiles).not.toContain("note.md");
  });

  it("counts self-links correctly (self-link does not count as inbound)", async () => {
    const vaultDir = join(tempDir, "vault");
    await mkdir(vaultDir, { recursive: true });
    await createVaultFile(vaultDir, "self.md", "# Self\n\n[[self]]");

    const result = runNoteOrphanDetect(
      { flags: { "vault-dir": "vault" } },
      { workspaceRoot: tempDir },
    );

    const orphanFiles = result.data?.orphans.map((o) => o.file) ?? [];
    expect(orphanFiles).toContain("vault/self.md");
  });

  it("always returns exitCode 0 (warnings, not errors)", async () => {
    const vaultDir = join(tempDir, "vault");
    await mkdir(vaultDir, { recursive: true });
    await createVaultFile(vaultDir, "orphan.md", "# Orphan");

    const result = runNoteOrphanDetect(
      { flags: { "vault-dir": "vault" } },
      { workspaceRoot: tempDir },
    );

    expect(result.exitCode).toBe(0);
    expect(result.data?.count).toBeGreaterThan(0);
  });
});
