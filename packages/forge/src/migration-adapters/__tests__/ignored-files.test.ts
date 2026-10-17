/*
<MODULE_CONTRACT>
<purpose>
Unit tests for ignored files covering formatSize; discoverIgnoredFiles. It also guards the documented public contract and regression-sensitive edge cases.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the module under test owns the authoritative behavior; fixtures are minimal scaffolding only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1311: Compass header sweep — declares the ignored suite's contract for test-file scaffold coverage.</item>
</CHANGE_SUMMARY>
*/

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
