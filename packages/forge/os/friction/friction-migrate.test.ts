/*
<MODULE_CONTRACT>
<purpose>Unit tests for friction.migrate — legacy split (AC-5) — covers the friction migrate suite surface and its observable contract.</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1639: step 5-6 — acceptance tests, system-hub reference, regenerated manifests</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

import type { ForgeFlagValue, ForgeRuntimeContext } from "../../src/types.ts";
import { initRepo } from "../flow/tests/helpers.ts";
import { runFrictionMigrate } from "./handlers/friction-migrate.ts";
import { LEGACY_FRICTION_FILE, loadFrictions, loadFrictionSources } from "./store.ts";
import { ambientIo } from "../../src/utils/io.ts";
import type { FrictionEntry } from "./types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friction-migrate-test-"));
  await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function ctxFor(
  root: string,
  flags: Record<string, ForgeFlagValue> = {},
): {
  input: { argv: string[]; flags: Record<string, ForgeFlagValue> };
  context: ForgeRuntimeContext;
} {
  return {
    input: { argv: [], flags },
    context: {
      workspaceRoot: root,
      dryRun: false,
      outputFormat: "json",
      logger: {
        section: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        success: () => {},
      },
    },
  };
}

function ctx(flags: Record<string, ForgeFlagValue> = {}) {
  return ctxFor(tmpDir, flags);
}

const LEGACY_RECORDS: FrictionEntry[] = [1, 2, 3].map((n) => ({
  id: `F-000${n}`,
  created: "2026-10-29",
  session: "s-x",
  category: "tooling",
  friction: `friction ${n}`,
  signature: `sig ${n}`,
  measure: `measure ${n}`,
  artifacts: n === 2 ? ["docs/x.md"] : [],
  status: "open",
  recurrences: n - 1,
  lastSeen: "2026-10-29",
}));

async function writeLegacyFile(): Promise<void> {
  await fs.writeFile(path.join(tmpDir, LEGACY_FRICTION_FILE), YAML.stringify(LEGACY_RECORDS));
}

async function fileExistsAbs(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(rel: string): Promise<boolean> {
  try {
    await fs.stat(path.join(tmpDir, rel));
    return true;
  } catch {
    return false;
  }
}

describe("friction.migrate — legacy split (AC-5)", () => {
  test("N legacy records become N per-record files with equal content; legacy removed", async () => {
    await writeLegacyFile();
    const { input, context } = ctx();
    const result = await runFrictionMigrate(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.migrated).toBe(3);
    expect(result.data?.files).toHaveLength(3);
    expect(result.data?.legacyRemoved).toBe(true);
    expect(await fileExists(LEGACY_FRICTION_FILE)).toBe(false);

    const after = await loadFrictions(tmpDir, ambientIo);
    expect(after).toHaveLength(3);
    // Loaded records equal the legacy records exactly.
    expect(after).toEqual(LEGACY_RECORDS);
  });

  test("a second run is a no-op — idempotent", async () => {
    await writeLegacyFile();
    const first = ctx();
    await runFrictionMigrate(first.input, first.context);
    const second = ctx();
    const r2 = await runFrictionMigrate(second.input, second.context);
    expect(r2.exitCode).toBe(0);
    expect(r2.data?.migrated).toBe(0);
    expect(await loadFrictions(tmpDir, ambientIo)).toHaveLength(3);
  });

  test("--dry-run lists the files without writing or removing", async () => {
    await writeLegacyFile();
    const { input, context } = ctx({ "dry-run": true });
    const result = await runFrictionMigrate(input, context);
    expect(result.exitCode).toBe(0);
    expect(result.data?.files).toHaveLength(3);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.legacyRemoved).toBe(false);
    expect(await fileExists(LEGACY_FRICTION_FILE)).toBe(true);
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(s.dir).toEqual([]);
    expect(s.legacy).toHaveLength(3);
  });

  test("a legacy entry with no readable id refuses without splitting", async () => {
    await fs.writeFile(
      path.join(tmpDir, LEGACY_FRICTION_FILE),
      YAML.stringify([...LEGACY_RECORDS, { category: "tooling" }]),
    );
    const { input, context } = ctx();
    const result = await runFrictionMigrate(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors.some((e) => e.ruleId === "FRICTION-01")).toBe(true);
    expect(await fileExists(LEGACY_FRICTION_FILE)).toBe(true);
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(s.dir).toEqual([]);
  });
});

describe("friction.migrate --from — external ingest (RFC-1639 AC-4)", () => {
  test("ingests external entries with provenance and removes the source", async () => {
    const repo = await initRepo({ prefix: "friction-ingest-", branch: "develop" });
    try {
      const src = await fs.mkdtemp(path.join(os.tmpdir(), "friction-src-"));
      const srcFile = path.join(src, "docs", "frictions.yaml");
      await fs.mkdir(path.dirname(srcFile), { recursive: true });
      await fs.writeFile(srcFile, YAML.stringify({ entries: LEGACY_RECORDS }));
      const { input, context } = ctxFor(repo, { from: srcFile, session: "s-ingest" });
      const result = await runFrictionMigrate(input, context);
      expect(result.exitCode).toBe(0);
      expect(result.data?.migrated).toBe(3);
      expect(await fileExistsAbs(srcFile)).toBe(false);

      const recs = await loadFrictions(repo, ambientIo);
      expect(recs).toHaveLength(3);
      // Legacy ids renumber onto the shared ledger sequence; provenance is
      // stamped on every record.
      expect(recs.map((r) => r.migratedFrom)).toEqual(["F-0001", "F-0002", "F-0003"]);
      expect(recs.map((r) => r.origin)).toEqual([
        path.basename(src),
        path.basename(src),
        path.basename(src),
      ]);
      expect(recs.map((r) => r.level)).toEqual(["folder", "folder", "folder"]);
      expect(recs.map((r) => r.id)).toEqual(["F-0001", "F-0002", "F-0003"]);

      // Re-run is deterministic — recreating the removed source (a
      // crash-before-removal shape) skips provenance-marked records.
      await fs.writeFile(srcFile, YAML.stringify({ entries: LEGACY_RECORDS }));
      const rerun = await runFrictionMigrate(input, context);
      expect(rerun.exitCode).toBe(0);
      expect(rerun.data?.migrated).toBe(0);
      expect(rerun.data?.skipped).toHaveLength(3);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  test("--from inside the workspace refuses", async () => {
    const { input, context } = ctx({ from: "docs/frictions.yaml" });
    const result = await runFrictionMigrate(input, context);
    expect(result.exitCode).toBe(1);
    expect(result.data?.errors.some((e) => e.ruleId === "FRICTION-01")).toBe(true);
  });
});
