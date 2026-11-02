/*
<MODULE_CONTRACT>
<purpose>version-files tests (RFC-1490 step 2): verified textual writes keep
formatting and key order, a nested-first `"version"` key throws
VersionWriteError, forge.yaml syncedVersion keeps indentation, and the
widened registry schema accepts kind fix + base main while rejecting
session + main.</purpose>
<non-goals>
  <item>No cut orchestration — flow-cut tests own that.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 2 — version-files + registry-schema coverage</item>
  <item>RFC-1490: step 2 — registry fix/port widening, FORGE_FLOW_COMMIT gitCommit helper, verified version-files writes</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { flowRegistryEntrySchema } from "../registry.ts";
import type { ReleaseLine } from "../release-lines.ts";
import {
  VersionWriteError,
  writeLineVersion,
  writeSyncedForgeVersion,
} from "../version-files.ts";
import { initRepo } from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function lineWith(versionFile: string | null): ReleaseLine {
  return {
    id: "repo",
    tagPrefix: "v",
    versionFile,
    paths: [],
    packages: [],
  } as ReleaseLine;
}

async function repo(): Promise<string> {
  const dir = await initRepo({ prefix: "ver-files-" });
  dirs.push(dir);
  return dir;
}

const ENTRY = {
  name: "auto/fix-260102-01-x",
  baseSha: "a".repeat(40),
  worktree: "/tmp/wt",
  owner: { kind: "session", id: "s1" },
  brief: null,
  openedAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  held: null,
  port: null,
};

describe("writeLineVersion", () => {
  it("replaces the version field preserving formatting and key order", async () => {
    const dir = await repo();
    const doc = '{\n\t"name": "x",\n\t"version": "1.2.0",\n\t"license": "MIT"\n}\n';
    await writeFile(join(dir, "package.json"), doc);
    await writeLineVersion(dir, lineWith("package.json"), "1.3.0", ambientIo);
    const after = await ambientIo.readFile(join(dir, "package.json"));
    expect(after).toBe(doc.replace('"version": "1.2.0"', '"version": "1.3.0"'));
    expect(after).toContain("\t");
  });

  it("a nested-first version key fails verification as VersionWriteError", async () => {
    const dir = await repo();
    await writeFile(
      join(dir, "package.json"),
      '{ "engines": { "version": ">=18" }, "version": "1.2.0" }\n',
    );
    await expect(
      writeLineVersion(dir, lineWith("package.json"), "1.3.0", ambientIo),
    ).rejects.toBeInstanceOf(VersionWriteError);
  });

  it("throws VersionWriteError when the line has no version file", async () => {
    const dir = await repo();
    await expect(
      writeLineVersion(dir, lineWith(null), "1.3.0", ambientIo),
    ).rejects.toBeInstanceOf(VersionWriteError);
  });
});

describe("writeSyncedForgeVersion", () => {
  it("replaces syncedVersion keeping indentation", async () => {
    const dir = await repo();
    await mkdir(join(dir, "sub"), { recursive: true });
    const yaml = "forge:\n  syncedVersion: 9.1.1\n  other: keep\n";
    await writeFile(join(dir, "forge.yaml"), yaml);
    await writeSyncedForgeVersion(dir, "9.2.0", ambientIo);
    expect(await ambientIo.readFile(join(dir, "forge.yaml"))).toBe(
      "forge:\n  syncedVersion: 9.2.0\n  other: keep\n",
    );
  });
});

describe("flowRegistryEntrySchema (RFC-1490 widening)", () => {
  it("accepts kind fix with base main", () => {
    const parsed = flowRegistryEntrySchema.safeParse({ ...ENTRY, kind: "fix", base: "main" });
    expect(parsed.success).toBe(true);
  });

  it("rejects kind session with base main", () => {
    const parsed = flowRegistryEntrySchema.safeParse({
      ...ENTRY,
      kind: "session",
      base: "main",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects kind fix with base develop", () => {
    const parsed = flowRegistryEntrySchema.safeParse({
      ...ENTRY,
      kind: "fix",
      base: "develop",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a port object on any kind", () => {
    const parsed = flowRegistryEntrySchema.safeParse({
      ...ENTRY,
      kind: "session",
      base: "develop",
      port: { mainSha: "b".repeat(40), tags: ["v1.3.1"] },
    });
    expect(parsed.success).toBe(true);
  });
});
