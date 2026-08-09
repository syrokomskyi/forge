import { test, expect, describe } from "vitest";
import { writeFileAtomic, __setRenameImplForTests } from "../utils/fs-atomic.ts";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-atomic-"));
}

describe("writeFileAtomic", () => {
  test("writes content to the target path", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = join(dir, "output.txt");
      await writeFileAtomic(filePath, "hello world");
      const content = await readFile(filePath, "utf8");
      expect(content).toBe("hello world");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overwrites existing file", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = join(dir, "output.txt");
      await writeFileAtomic(filePath, "first");
      await writeFileAtomic(filePath, "second");
      expect(await readFile(filePath, "utf8")).toBe("second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts Uint8Array content", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = join(dir, "output.bin");
      const data = new Uint8Array([1, 2, 3]);
      await writeFileAtomic(filePath, data);
      const buf = await readFile(filePath);
      expect(new Uint8Array(buf)).toEqual(data);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries on EPERM then succeeds", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = join(dir, "output.txt");
      let calls = 0;
      const fakeRename = async (src: string, dest: string) => {
        calls++;
        if (calls < 3) {
          const err = new Error("EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        const { rename: realRename } = await import("node:fs/promises");
        return realRename(src, dest);
      };
      __setRenameImplForTests(fakeRename as never);
      try {
        await writeFileAtomic(filePath, "retried", { retries: 5 });
        expect(await readFile(filePath, "utf8")).toBe("retried");
        expect(calls).toBe(3);
      } finally {
        __setRenameImplForTests(undefined);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws non-retryable error immediately", async () => {
    const dir = await makeTempDir();
    try {
      const filePath = join(dir, "output.txt");
      const fakeRename = async () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      };
      __setRenameImplForTests(fakeRename as never);
      try {
        await expect(writeFileAtomic(filePath, "fail")).rejects.toThrow("ENOENT");
      } finally {
        __setRenameImplForTests(undefined);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
