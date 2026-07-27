/*
<MODULE_CONTRACT>
<purpose>Atomic file-write primitive — canonical forge utility. Writes to a temp
file then renames, with bounded retry for Windows EPERM/EBUSY.</purpose>
<non-goals>
  <item>Do not provide cross-process locks — convergent atomic writes are sufficient.</item>
  <item>Do not fall back to non-atomic writes — fail loudly.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Moved from @gogol/site-kernel/fs-atomic to forge as canonical source (dependency inversion).</item>
</CHANGE_SUMMARY>
*/

import { writeFile, rename as fsRename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { randomBytes } from "node:crypto";

export interface WriteFileAtomicOptions {
  retries?: number;
}

let renameImpl: typeof fsRename = fsRename;

export function __setRenameImplForTests(impl: typeof fsRename | undefined): void {
  renameImpl = impl ?? fsRename;
}

const DEFAULT_RETRIES = 10;
const RETRY_BACKOFF_MS = 50;
const RETRYABLE_CODES = new Set(["EPERM", "EBUSY"]);

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTempPath(filePath: string): string {
  const dir = dirname(filePath);
  const name = basename(filePath);
  const random = randomBytes(6).toString("hex");
  return join(dir, `${name}.${random}.tmp`);
}

export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options?: WriteFileAtomicOptions,
): Promise<void> {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const tempPath = makeTempPath(filePath);
  let tempWritten = false;

  try {
    await writeFile(tempPath, content);
    tempWritten = true;

    let attempt = 0;
    for (;;) {
      try {
        await renameImpl(tempPath, filePath);
        return;
      } catch (error) {
        if (attempt >= retries || !isRetryableError(error)) {
          throw error;
        }
        attempt += 1;
        if (existsSync(filePath)) {
          try {
            await unlink(filePath);
          } catch {
            // If unlink also fails, the retry loop will try again.
          }
        }
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  } finally {
    if (tempWritten) {
      try {
        await unlink(tempPath);
      } catch {
        // Expected in the success path (temp file already renamed away).
      }
    }
  }
}
