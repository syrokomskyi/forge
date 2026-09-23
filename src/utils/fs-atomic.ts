/*
<MODULE_CONTRACT>
<purpose>Atomic file-write primitive — canonical forge utility. Writes to a temp
file then renames, with bounded retry for Windows EPERM/EBUSY.</purpose>
<non-goals>
  <item>Do not provide cross-process locks — convergent atomic writes are sufficient.</item>
  <item>Do not fall back to non-atomic writes — fail loudly.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Writes go through temp-file plus rename so readers never observe partial content.</item>
  <item>Bounded retry covers only Windows EPERM/EBUSY — every other failure is loud and immediate.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — packages/forge + services clean

Sweep batch 2: real KEY_DECISIONS on 10 files, expanded purposes (CONTRACT-02/PURPOSE-02), headers on mission/index + gen-upstreams, sanitizeItemText in summary.record (literal Compass tags corrupted history), excludedPaths for wrangler types, test-fixtures testPattern. forge+services now 0 diagnostics under --mode error.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
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
  const random = Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, "0")).join("");
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
