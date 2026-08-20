import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileIfChanged } from "../fs-idempotent.ts";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "forge-idempotent-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("writeFileIfChanged", () => {
  it("writes new file and returns 'written'", async () => {
    const filePath = join(tempDir, "new.txt");
    const result = await writeFileIfChanged(filePath, "hello");
    expect(result).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("hello");
  });

  it("returns 'unchanged' when content is identical", async () => {
    const filePath = join(tempDir, "same.txt");
    await writeFile(filePath, "same content", "utf8");
    const result = await writeFileIfChanged(filePath, "same content");
    expect(result).toBe("unchanged");
  });

  it("writes when string content differs", async () => {
    const filePath = join(tempDir, "change.txt");
    await writeFile(filePath, "old", "utf8");
    const result = await writeFileIfChanged(filePath, "new");
    expect(result).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("new");
  });

  it("writes to nested paths when parent dirs exist", async () => {
    await mkdir(join(tempDir, "sub", "dir"), { recursive: true });
    const filePath = join(tempDir, "sub", "dir", "file.txt");
    const result = await writeFileIfChanged(filePath, "nested");
    expect(result).toBe("written");
    expect(await readFile(filePath, "utf8")).toBe("nested");
  });

  it("handles Uint8Array content", async () => {
    const filePath = join(tempDir, "binary.bin");
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await writeFileIfChanged(filePath, data);
    expect(result).toBe("written");
    const buf = await readFile(filePath);
    expect(new Uint8Array(buf)).toEqual(data);
  });

  it("returns 'unchanged' for identical Uint8Array content", async () => {
    const filePath = join(tempDir, "binary.bin");
    const data = new Uint8Array([10, 20, 30]);
    await writeFileIfChanged(filePath, data);
    const result = await writeFileIfChanged(filePath, data);
    expect(result).toBe("unchanged");
  });

  it("writes when Uint8Array content differs", async () => {
    const filePath = join(tempDir, "binary.bin");
    await writeFileIfChanged(filePath, new Uint8Array([1, 2, 3]));
    const result = await writeFileIfChanged(filePath, new Uint8Array([4, 5, 6]));
    expect(result).toBe("written");
    const buf = await readFile(filePath);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([4, 5, 6]));
  });
});
