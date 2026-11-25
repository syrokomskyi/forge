/* RFC-1646 AC-4: evidence key is sha256(nodeId + inputDigest + executorVersion);
   blobs immutable once written; corruption on read is cache-miss. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEvidenceStore } from "../src/contract/evidence-store.ts";
import { evidenceKey, sha256Hex } from "../src/contract/fingerprint.ts";
import type { EvidenceRecord } from "../src/contract/types.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "evidence-store-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function record(key: string, verdictStatus: "pass" | "fail" = "pass"): EvidenceRecord {
  return {
    schema: "forge:evidence/v1",
    key,
    nodeId: "core.test",
    inputFingerprint: { nodeId: "core.test", digest: "d".repeat(64), inputs: {}, computedAt: "t" },
    verdict: verdictStatus === "pass" ? { status: "pass" } : { status: "fail", violations: [] },
    executorVersion: "1.0.0",
    startedAt: "t",
    durationMs: 1,
    changeUnitId: "unit",
    artifactRefs: [],
  };
}

describe("evidence store — AC-4", () => {
  it("evidence key formula is sha256(nodeId + inputDigest + executorVersion), verbatim", () => {
    const digest = "a".repeat(64);
    const expected = sha256Hex(`core.x${digest}2.1.0`);
    expect(evidenceKey("core.x", digest, "2.1.0")).toBe(expected);
  });

  it("write-once: a second write of the same key is a no-op — loser discards", () => {
    const store = createEvidenceStore(tmp());
    const key = evidenceKey("core.test", "d".repeat(64), "1.0.0");
    expect(store.write(record(key))).toBe(true);
    const tampered = record(key);
    tampered.verdict = { status: "fail", violations: [{ ruleId: "X", message: "tamper", severity: "blocking" }] };
    expect(store.write(tampered)).toBe(false);
    const read = store.read(key);
    expect(read?.verdict.status).toBe("pass");
  });

  it("corruption on read is cache-miss — never trust", () => {
    const dir = tmp();
    const store = createEvidenceStore(dir);
    const key = evidenceKey("core.test", "d".repeat(64), "1.0.0");
    store.write(record(key));
    const path = join(dir, "records", key.slice(0, 2), `${key}.json`);
    writeFileSync(path, "{ not json at all");
    expect(store.read(key)).toBeNull();
    // Wrong key inside valid json — also cache-miss. (Direct writeFileSync:
    // the store is write-once and the corrupted file already occupies the key.)
    writeFileSync(path, JSON.stringify(record(key)));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as EvidenceRecord;
    parsed.key = "0".repeat(64);
    writeFileSync(path, JSON.stringify(parsed));
    expect(store.read(key)).toBeNull();
  });

  it("no partial writes are visible — temp files never surface as records", () => {
    const dir = tmp();
    const store = createEvidenceStore(dir);
    const key = evidenceKey("core.test", "d".repeat(64), "1.0.0");
    store.write(record(key));
    const shardDir = join(dir, "records", key.slice(0, 2));
    const leftovers = readdirSync(shardDir).filter((f) => f.startsWith(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(existsSync(join(shardDir, `${key}.json`))).toBe(true);
  });

  it("artifacts are content-addressed and verified on read", () => {
    const store = createEvidenceStore(tmp());
    const key = store.writeArtifact("hello evidence");
    expect(key).toBe(sha256Hex("hello evidence"));
    expect(store.readArtifact(key)?.toString()).toBe("hello evidence");
    expect(store.readArtifact("f".repeat(64))).toBeNull();
  });
});
