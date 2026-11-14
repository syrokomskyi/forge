import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

import type { ForgeFlagValue, ForgeRuntimeContext } from "../../src/types.ts";
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

function ctx(flags: Record<string, ForgeFlagValue> = {}): {
  input: { argv: string[]; flags: Record<string, ForgeFlagValue> };
  context: ForgeRuntimeContext;
} {
  return {
    input: { argv: [], flags },
    context: {
      workspaceRoot: tmpDir,
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
