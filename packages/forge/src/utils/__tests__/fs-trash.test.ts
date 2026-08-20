import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { trashPath } from "../fs-trash.ts";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-trash-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("trashPath", () => {
  it("does not throw when path does not exist", async () => {
    const nonExistent = join(tempDir, "nope.txt");
    expect(existsSync(nonExistent)).toBe(false);
    await expect(trashPath(nonExistent)).resolves.toBeUndefined();
  });

  it("trashes a file", async () => {
    const filePath = join(tempDir, "to-trash.txt");
    await writeFile(filePath, "content", "utf8");
    expect(existsSync(filePath)).toBe(true);

    await trashPath(filePath);

    expect(existsSync(filePath)).toBe(false);
  });

  it("trashes a directory", async () => {
    const dirPath = join(tempDir, "to-trash-dir");
    await mkdir(dirPath, { recursive: true });
    await writeFile(join(dirPath, "inner.txt"), "inner", "utf8");
    expect(existsSync(dirPath)).toBe(true);

    await trashPath(dirPath);

    expect(existsSync(dirPath)).toBe(false);
  });
});
