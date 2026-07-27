import { test, expect, describe } from "vitest";
import { collectFiles, fileExists } from "../utils/fs.ts";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-test-"));
}

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = join(dir, "test.txt");
      await writeFile(filePath, "hello");
      expect(await fileExists(filePath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns false for missing file", async () => {
    expect(await fileExists(join(tmpdir(), "nonexistent-12345.txt"))).toBe(false);
  });

  test("returns true for a directory", async () => {
    const dir = await makeTempDir();
    try {
      expect(await fileExists(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collectFiles", () => {
  test("collects all files recursively", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "a.ts"), "");
      await writeFile(join(dir, "sub", "b.ts"), "");
      await writeFile(join(dir, "c.md"), "");
      const files = await collectFiles(dir);
      expect(files.length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("filters by extension", async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir, "a.ts"), "");
      await writeFile(join(dir, "b.md"), "");
      await writeFile(join(dir, "c.ts"), "");
      const files = await collectFiles(dir, { extensions: [".ts"] });
      expect(files.length).toBe(2);
      expect(files.every((f) => f.endsWith(".ts"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips ignored names", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, "old-stuff"));
      await writeFile(join(dir, "old-stuff", "old.ts"), "");
      await writeFile(join(dir, "-draft.ts"), "");
      await writeFile(join(dir, "keep.ts"), "");
      const files = await collectFiles(dir);
      const names = files.map((f) => f.split(/[/\\]/).pop());
      expect(names).toContain("keep.ts");
      expect(names).not.toContain("old.ts");
      expect(names).not.toContain("-draft.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes directories when withDirs is true", async () => {
    const dir = await makeTempDir();
    try {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "a.ts"), "");
      await writeFile(join(dir, "sub", "b.ts"), "");
      const files = await collectFiles(dir, { withDirs: true });
      const names = files.map((f) => f.split(/[/\\]/).pop());
      expect(names).toContain("sub");
      expect(names).toContain("a.ts");
      expect(names).toContain("b.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns empty for nonexistent directory", async () => {
    const files = await collectFiles(join(tmpdir(), "nonexistent-xyz-999"));
    expect(files).toEqual([]);
  });
});
