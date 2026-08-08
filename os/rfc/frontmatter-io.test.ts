import { test, expect, describe } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listRfcFiles, readAndParseRfc, parseRfcFile } from "./frontmatter-io.ts";

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

describe("readAndParseRfc — YAML parse error handling (RFC-0755)", () => {
  test("returns error variant for malformed YAML frontmatter", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-parse-"));
    try {
      const malformedYaml =
        "---\nid: RFC-0100\ntitle: Test\n  bad: indentation: here\n---\n# Body\n";
      await fs.writeFile(path.join(tmpDir, "rfc-0100-bad.md"), malformedYaml);

      const result = await readAndParseRfc(tmpDir, "rfc-0100-bad.md");

      expect(result).toBeDefined();
      expect(result && "error" in result).toBe(true);
      if (result && "error" in result) {
        expect(result.error).toContain("YAML parse error");
        expect(result.fileName).toBe("rfc-0100-bad.md");
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns parsed variant for valid YAML frontmatter", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-parse-"));
    try {
      const validYaml = "---\nid: RFC-0100\ntitle: Test\nstatus: draft\n---\n# Body\n";
      await fs.writeFile(path.join(tmpDir, "rfc-0100-ok.md"), validYaml);

      const result = await readAndParseRfc(tmpDir, "rfc-0100-ok.md");

      expect(result).toBeDefined();
      expect(result && "parsed" in result).toBe(true);
      if (result && "parsed" in result) {
        expect(result.parsed.frontmatter["id"]).toBe("RFC-0100");
        expect(result.parsed.body).toContain("# Body");
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns error variant for non-existent file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc-parse-"));
    try {
      const result = await readAndParseRfc(tmpDir, "nonexistent.md");
      expect(result).toBeDefined();
      expect(result && "error" in result).toBe(true);
      if (result && "error" in result) {
        expect(result.error).toContain("YAML parse error");
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("parseRfcFile — basic parsing", () => {
  test("parses valid frontmatter and body", () => {
    const source = "---\nid: RFC-0100\n---\n# RFC-0100\n\nBody text.\n";
    const result = parseRfcFile(source);
    expect(result.frontmatter["id"]).toBe("RFC-0100");
    expect(result.body).toContain("Body text.");
  });

  test("returns empty frontmatter when no frontmatter block", () => {
    const source = "# Just a title\n\nNo frontmatter here.\n";
    const result = parseRfcFile(source);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(source);
  });
});
