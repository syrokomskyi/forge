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
  <item>RFC-1487: close rfc-1487 review findings — dirty-check parity with git worktree remove, ownership-verified lock release, FLOW-07 registry-error mapping, residual RFC-1462 docs removed

The dirty gate for session worktrees now uses full porcelain status
(untracked files included) because it predicts 'git worktree remove';
the primary-clean gate keeps tracked-only semantics because it predicts
'merge --ff-only'. Lock release verifies the held payload before
unlinking. Registry/journal failures map to FLOW-07 in every handler.
The final branch-name collision reports FLOW-OPEN-04, flow.discard
propagates its teardown result and predicts FLOW-DIS-03 on --dry-run,
and integrate exposes teardown as its own field.</item>
  <item>RFC-1490: step 2 — registry fix/port widening, FORGE_FLOW_COMMIT gitCommit helper, verified version-files writes</item>
  <item>RFC-1491: step 1 — journal base/rewrites + held registry widening, W1-1 discard tip, FLOW-INT-11</item>
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
  flowRegistryEntrySchema,
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
    port: null,
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
    tempDirs.push(linked);
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

describe("flowRegistryEntrySchema held/worktree (RFC-1491)", () => {
  const heldPayload = {
    heldAt: "2026-11-02T00:00:00Z",
    riskCategory: "other" as const,
    reason: "hold it",
    tip: "1".repeat(40),
  };

  it("accepts a held entry with worktree: null", () => {
    const e = { ...entry("auto/session-261102-01-held-x"), worktree: null, held: heldPayload };
    expect(flowRegistryEntrySchema.safeParse(e).success).toBe(true);
  });

  it("rejects a held entry that still names a worktree", () => {
    const e = { ...entry("auto/session-261102-01-held-y"), held: heldPayload };
    expect(flowRegistryEntrySchema.safeParse(e).success).toBe(false);
  });

  it("rejects an unheld entry with worktree: null", () => {
    const e = { ...entry("auto/session-261102-01-plain"), worktree: null };
    expect(flowRegistryEntrySchema.safeParse(e).success).toBe(false);
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
