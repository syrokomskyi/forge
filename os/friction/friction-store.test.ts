/*
<MODULE_CONTRACT>
<purpose>Unit tests for friction store — loadFrictionSources — covers the friction store suite surface and its observable contract.</purpose>
<non-goals>
  <item>Not a contract source of truth — the implementation under test owns the behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { ambientIo } from "../../src/utils/io.ts";

import {
  FRICTION_DIR,
  LEGACY_FRICTION_FILE,
  FrictionDuplicateError,
  LegacyRecordMutationError,
  frictionSourceMax,
  loadFrictionSources,
  loadFrictions,
  loadFrictionsTolerant,
  updateFriction,
  writeFriction,
} from "./store.ts";
import type { FrictionEntry } from "./types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friction-store-test-"));
  await fs.mkdir(path.join(tmpDir, "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ENTRY: FrictionEntry = {
  id: "F-0001",
  created: "2026-10-29",
  session: "2026-10-29-16-20-00-3e0805",
  category: "tooling",
  friction: "validator fired late",
  signature: "validator fired late",
  measure: "move gate earlier",
  artifacts: [],
  status: "open",
  recurrences: 0,
  lastSeen: "2026-10-29",
};

async function writeRecord(e: FrictionEntry): Promise<void> {
  await writeFriction(tmpDir, e, ambientIo);
}

async function writeLegacy(entries: unknown[]): Promise<void> {
  const { stringify } = await import("yaml");
  await fs.writeFile(path.join(tmpDir, LEGACY_FRICTION_FILE), stringify(entries));
}

describe("friction store — loadFrictionSources", () => {
  test("empty checkout yields empty surfaces", async () => {
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(s.dir).toEqual([]);
    expect(s.legacy).toEqual([]);
    expect(s.legacyPresent).toBe(false);
  });

  test("dir records merge with legacy records", async () => {
    await writeRecord(ENTRY);
    await writeLegacy([{ ...ENTRY, id: "F-0002" }]);
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(s.dir).toHaveLength(1);
    expect(s.legacy).toHaveLength(1);
    const all = await loadFrictions(tmpDir, ambientIo);
    expect(all.map((f) => f.id)).toEqual(["F-0001", "F-0002"]);
  });

  test("records sort by numeric id, not write order", async () => {
    await writeRecord({ ...ENTRY, id: "F-0010" });
    await writeRecord({ ...ENTRY, id: "F-0009" });
    await writeRecord(ENTRY);
    const all = await loadFrictions(tmpDir, ambientIo);
    expect(all.map((f) => f.id)).toEqual(["F-0001", "F-0009", "F-0010"]);
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(frictionSourceMax(s)).toBe(10);
  });

  test("a same id across stores throws FrictionDuplicateError", async () => {
    await writeRecord(ENTRY);
    await writeLegacy([{ ...ENTRY, session: "other" }]);
    await expect(loadFrictions(tmpDir, ambientIo)).rejects.toBeInstanceOf(FrictionDuplicateError);
    const tolerant = await loadFrictionsTolerant(tmpDir, ambientIo);
    expect(tolerant.duplicates).toEqual(["F-0001"]);
    // The canonical per-record copy survives for best-effort readers.
    expect(tolerant.records.map((f) => f.id)).toEqual(["F-0001"]);
  });

  test("an unparseable record file surfaces as parseError, not a crash", async () => {
    await fs.mkdir(path.join(tmpDir, FRICTION_DIR), { recursive: true });
    await fs.writeFile(path.join(tmpDir, FRICTION_DIR, "F-0001.yaml"), "bad: [unclosed\n");
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(s.dir[0]?.parseError).toBeTruthy();
    expect(s.dir[0]?.fileId).toBe("F-0001");
  });

  test("empty legacy file is zero records, not a shape failure", async () => {
    await fs.writeFile(path.join(tmpDir, LEGACY_FRICTION_FILE), "");
    const s = await loadFrictionSources(tmpDir, ambientIo);
    expect(s.legacyPresent).toBe(true);
    expect(s.legacy).toEqual([]);
  });
});

describe("friction store — writes", () => {
  test("writeFriction is idempotent on identical content", async () => {
    const a = await writeFriction(tmpDir, ENTRY, ambientIo);
    const b = await writeFriction(tmpDir, ENTRY, ambientIo);
    expect(a).toBe(b);
    expect(await loadFrictions(tmpDir, ambientIo)).toHaveLength(1);
  });

  test("writeFriction refuses to clobber a different record at the same id", async () => {
    await writeRecord(ENTRY);
    await expect(
      writeFriction(tmpDir, { ...ENTRY, friction: "different" }, ambientIo),
    ).rejects.toThrow(/already exists/);
  });

  test("updateFriction mutates a per-record file in place", async () => {
    await writeRecord(ENTRY);
    await updateFriction(
      tmpDir,
      "F-0001",
      (r) => ({ ...r, recurrences: r.recurrences + 1 }),
      ambientIo,
    );
    const [r] = await loadFrictions(tmpDir, ambientIo);
    expect(r?.recurrences).toBe(1);
  });

  test("updateFriction refuses a legacy-resident id with the migrate hint", async () => {
    await writeLegacy([ENTRY]);
    await expect(updateFriction(tmpDir, "F-0001", (r) => r, ambientIo)).rejects.toBeInstanceOf(
      LegacyRecordMutationError,
    );
  });
});

// ── AC-4: the only forge sources that may name the legacy path literally ──
describe("AC-4 — legacy path literal containment", () => {
  test("docs/frictions.yaml appears only in store.ts and the migrate handler", async () => {
    const forgePkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const allowed = new Set([
      path.join("os", "friction", "store.ts"),
      path.join("os", "friction", "handlers", "friction-migrate.ts"),
    ]);
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
          await walk(abs);
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = path.relative(forgePkg, abs);
        if (allowed.has(rel)) continue;
        const body = await fs.readFile(abs, "utf8");
        if (body.includes(LEGACY_FRICTION_FILE)) offenders.push(rel);
      }
    }
    await walk(forgePkg);
    expect(offenders).toEqual([]);
  });
});
