/*
<MODULE_CONTRACT>
<purpose>Registry contract tests (RFC-1487 step 1): the registry resolves to
the same file from every worktree (AC-8), a schema-invalid file throws
FlowRegistrySchemaError and is never rewritten, and concurrent updateRegistry
calls serialize under the lock.</purpose>
<non-goals>
  <item>No lifecycle coverage — flow.open/integrate/discard tests own that.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 1 — registry tests</item>
  <item>RFC-1487: step 1 — worktree path contracts, O_EXCL locks, branch registry and journal</item>
</CHANGE_SUMMARY>
*/

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import {
  commonGitDir,
  emptyRegistry,
  FlowRegistrySchemaError,
  readRegistry,
  registryPath,
  updateRegistry,
  type FlowRegistryEntry,
} from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

function entry(name: string): FlowRegistryEntry {
  return {
    name,
    kind: "session",
    base: "develop",
    baseSha: "0".repeat(40),
    worktree: `/tmp/${name.replaceAll("/", "-")}`,
    owner: { kind: "session", id: "test" },
    brief: null,
    openedAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    held: null,
  };
}

const tempDirs: string[] = [];
async function repo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-registry-test-" });
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("commonGitDir", () => {
  it("resolves the same directory from the primary and a linked worktree (AC-8)", async () => {
    const dir = await repo();
    const linked = `${dir}-linked`;
    const add = await gitExec(dir, ["worktree", "add", "-b", "probe-linked", linked]);
    expect(add.exitCode, add.stderr).toBe(0);

    const fromPrimary = await commonGitDir(ambientIo, dir);
    const fromLinked = await commonGitDir(ambientIo, linked);
    expect(fromPrimary).toBe(fromLinked);
    expect(registryPath(fromPrimary)).toBe(join(fromPrimary, "forge", "registry.yaml"));
  });
});

describe("readRegistry", () => {
  it("returns the empty registry when the file is absent", async () => {
    const dir = await repo();
    const common = await commonGitDir(ambientIo, dir);
    expect(await readRegistry(ambientIo, common)).toEqual(emptyRegistry());
  });

  it("throws FlowRegistrySchemaError on a schema-invalid file and never rewrites it", async () => {
    const dir = await repo();
    const common = await commonGitDir(ambientIo, dir);
    const file = registryPath(common);
    const bad = "schema: forge/flow-registry@1\nbranches: [{ name: 7 }]\n";
    await mkdir(join(common, "forge"), { recursive: true });
    await writeFile(file, bad);

    await expect(readRegistry(ambientIo, common)).rejects.toThrow(FlowRegistrySchemaError);
    expect(await readFile(file, "utf8")).toBe(bad);
  });
});

describe("updateRegistry", () => {
  it("serializes concurrent updates — five writers leave five entries", async () => {
    const dir = await repo();
    const common = await commonGitDir(ambientIo, dir);
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((name) =>
        updateRegistry(ambientIo, common, (r) => ({
          ...r,
          branches: [...r.branches, entry(`auto/session-261101-0${name.length}-x${name}`)],
        })),
      ),
    );
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches).toHaveLength(5);
    expect(registry.branches.map((b) => b.name)).toEqual(
      [...registry.branches.map((b) => b.name)].sort(),
    );
  });
});
