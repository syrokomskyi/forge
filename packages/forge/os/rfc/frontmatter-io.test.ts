import { test, expect, describe } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listRfcFiles } from "./frontmatter-io.ts";

describe("listRfcFiles — recursive scanning (RFC-0491)", () => {
  test("scans archive/ subdirectories recursively", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-test-"));
    try {
      // Create top-level RFC files
      await fs.writeFile(
        path.join(tmpDir, "rfc-0100-active.md"),
        "---\nid: RFC-0100\n---\n# RFC-0100\n",
      );
      // Create archive subdirectory with a higher-numbered RFC
      await fs.mkdir(path.join(tmpDir, "archive", "implemented"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "archive", "implemented", "rfc-0500-archived.md"),
        "---\nid: RFC-0500\n---\n# RFC-0500\n",
      );

      const files = await listRfcFiles(tmpDir);

      // Both the top-level and archived RFC must be found
      expect(files).toContain("rfc-0100-active.md");
      expect(files).toContain("archive/implemented/rfc-0500-archived.md");
      expect(files.length).toBe(2);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty array when directory does not exist", async () => {
    const files = await listRfcFiles(path.join(os.tmpdir(), "nonexistent-rfc-dir-xyz"));
    expect(files).toEqual([]);
  });

  test("excludes rfc-0000 template and README.md", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-test-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "rfc-0000-template.md"),
        "---\nid: RFC-0000\n---\n# RFC-0000\n",
      );
      await fs.writeFile(path.join(tmpDir, "README.md"), "# RFC docs\n");
      await fs.writeFile(
        path.join(tmpDir, "rfc-0100-real.md"),
        "---\nid: RFC-0100\n---\n# RFC-0100\n",
      );

      const files = await listRfcFiles(tmpDir);

      expect(files).toContain("rfc-0100-real.md");
      expect(files).not.toContain("rfc-0000-template.md");
      expect(files).not.toContain("README.md");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
