/*
<MODULE_CONTRACT>
<purpose>
Content-addressed immutable evidence store (Werkstatt RFC-1646) — evidence records
are blobs keyed by sha256(nodeId + inputDigest + executorVersion). Write-to-temp
plus atomic rename; a record is visible only complete. Concurrent writers dedupe
by key existence — loser discards, never partial-overwrites. Store corruption on
read is cache-miss (re-execution), never trust. Schema version change starts a new
key namespace — old records are garbage-collected, never migrated.
</purpose>
<non-goals>
  <item>No verdict semantics — the evaluator decides what is worth storing.</item>
</non-goals>
<CHANGE_SUMMARY>
  <item>RFC-1646 (WP-3): initial evidence store.</item>
</CHANGE_SUMMARY>
*/

import { existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, closeSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { sha256Hex } from "./fingerprint.ts";
import type { EvidenceRecord } from "./types.ts";

export interface EvidenceStore {
  /** Read a record by key. Corrupt or unparseable content is cache-miss — never trust. */
  read(key: string): EvidenceRecord | null;
  /**
   * Write a record immutably. If the key already exists the write is a no-op
   * (loser discards) — evidence is write-once. Returns true when written.
   */
  write(record: EvidenceRecord): boolean;
  has(key: string): boolean;
  /** Artifact blob write — content-addressed, same atomicity contract. Returns the blob key. */
  writeArtifact(content: string | Buffer): string;
  readArtifact(key: string): Buffer | null;
}

function atomicWriteFileNoOverwrite(path: string, content: string | Buffer): boolean {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    const fd = openSync(tmp, "w");
    try {
      // narrowed per-branch: writeSync overloads do not distribute over string | Buffer
      if (typeof content === "string") {
        writeSync(fd, content);
      } else {
        writeSync(fd, content);
      }
    } finally {
      closeSync(fd);
    }
    if (existsSync(path)) return false; // loser discards — never partial-overwrite
    try {
      renameSync(tmp, path);
    } catch {
      // Cross-check the race: a concurrent winner's complete file is fine.
      if (!existsSync(path)) throw new Error(`atomic rename failed for ${path}`);
      return false;
    }
    return true;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed or never written — nothing to clean
    }
  }
}

/** Filesystem-backed evidence store rooted at `<rootDir>/`. */
export function createEvidenceStore(rootDir: string): EvidenceStore {
  const recordPath = (key: string): string => join(rootDir, "records", key.slice(0, 2), `${key}.json`);
  const artifactPath = (key: string): string => join(rootDir, "artifacts", key.slice(0, 2), key);

  return {
    read(key) {
      let raw: string;
      try {
        raw = readFileSync(recordPath(key), "utf8");
      } catch {
        return null; // absent is cache-miss
      }
      try {
        const parsed = JSON.parse(raw) as EvidenceRecord;
        // Key verification on read — a corrupt or misplaced record is cache-miss, never trust.
        if (parsed.schema !== "forge:evidence/v1" || parsed.key !== key) return null;
        if (!parsed.nodeId || !parsed.inputFingerprint || !parsed.verdict) return null;
        return parsed;
      } catch {
        return null; // corruption is cache-miss
      }
    },
    write(record) {
      return atomicWriteFileNoOverwrite(recordPath(record.key), JSON.stringify(record, null, 2));
    },
    has(key) {
      return existsSync(recordPath(key));
    },
    writeArtifact(content) {
      const key = sha256Hex(content);
      atomicWriteFileNoOverwrite(artifactPath(key), content);
      return key;
    },
    readArtifact(key) {
      try {
        const content = readFileSync(artifactPath(key));
        // Content-addressed — verify the key preimages the content.
        if (sha256Hex(content) !== key) return null;
        return content;
      } catch {
        return null;
      }
    },
  };
}
