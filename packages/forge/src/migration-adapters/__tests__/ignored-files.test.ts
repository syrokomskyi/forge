import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverIgnoredFiles, formatSize } from "../ignored-files.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-ignored-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 5)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("discoverIgnoredFiles", () => {
  it("returns empty array when no .git directory exists", async () => {
    const result = discoverIgnoredFiles(tempDir);
    expect(result).toEqual([]);
  });

  it("returns empty array when .git exists but no ignored files", async () => {
    await mkdir(join(tempDir, ".git"), { recursive: true });
    await writeFile(join(tempDir, "file.txt"), "content", "utf8");
    const result = discoverIgnoredFiles(tempDir);
    expect(result).toEqual([]);
  });
});
