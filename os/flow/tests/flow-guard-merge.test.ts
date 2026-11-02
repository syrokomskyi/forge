/*
<MODULE_CONTRACT>
<purpose>AC-11 (RFC-1490): the pre-merge-commit managed block refuses merge
commits on develop/main — `git merge --no-ff` into develop exits with
FLOW-GUARD-01, the same merge on a conforming auto branch succeeds, and
FORGE_FLOW_OP=install is NOT a merge escape (empty mode vocabulary →
FLOW-GUARD-04) — proven by real merges through core.hooksPath in throwaway
repos.</purpose>
<non-goals>
  <item>No port-branch orchestration — flow-backmerge tests own that.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 3 — pre-merge-commit guard coverage</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
</CHANGE_SUMMARY>
*/

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  managedBlock,
  resolveGuardAssetPath,
} from "../guard-files.ts";
import { copyFile } from "node:fs/promises";
import {
  checkoutOrCreate,
  gitExec,
  initRepo,
} from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function repoWithMergeGuard(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-merge-guard-" });
  dirs.push(dir);
  const hooksDir = join(dir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  await copyFile(resolveGuardAssetPath(), join(hooksDir, "flow-guard.sh"));
  for (const mode of ["pre-commit", "pre-merge-commit"] as const) {
    await writeFile(join(hooksDir, mode), `#!/bin/sh\n${managedBlock(mode)}`);
    await chmod(join(hooksDir, mode), 0o755);
  }
  await chmod(join(hooksDir, "flow-guard.sh"), 0o755);
  const hooksPath = await gitExec(dir, ["config", "core.hooksPath", "hooks"]);
  expect(hooksPath.exitCode).toBe(0);
  return dir;
}

/** Seed a side auto branch carrying one commit ahead of `from`. */
async function seedAutoBranch(repo: string, from: string): Promise<string> {
  await gitExec(repo, ["switch", "-c", "auto/session-260102-01-seed", from]);
  await writeFile(join(repo, "auto-seed.txt"), "seed\n");
  await gitExec(repo, ["add", "auto-seed.txt"]);
  const commit = await gitExec(repo, ["commit", "-m", "seed"]);
  expect(commit.exitCode).toBe(0);
  return "auto/session-260102-01-seed";
}

describe("pre-merge-commit guard (AC-11)", () => {
  it("refuses git merge --no-ff into develop with FLOW-GUARD-01", async () => {
    const repo = await repoWithMergeGuard();
    await checkoutOrCreate(repo, "develop");
    const side = await seedAutoBranch(repo, "develop");
    await gitExec(repo, ["switch", "develop"]);
    const merge = await gitExec(repo, ["merge", "--no-ff", "-m", "m", side]);
    expect(merge.exitCode).toBe(1);
    expect(merge.stderr).toContain("FLOW-GUARD-01:");
  });

  it("allows the same merge on a conforming auto branch", async () => {
    const repo = await repoWithMergeGuard();
    await checkoutOrCreate(repo, "develop");
    const side = await seedAutoBranch(repo, "develop");
    await gitExec(repo, ["switch", "-c", "auto/session-260102-02-port", "develop"]);
    const merge = await gitExec(repo, ["merge", "--no-ff", "-m", "m", side]);
    expect(merge.exitCode).toBe(0);
  });

  it("refuses FORGE_FLOW_OP=install git merge into develop with FLOW-GUARD-04", async () => {
    const repo = await repoWithMergeGuard();
    await checkoutOrCreate(repo, "develop");
    const side = await seedAutoBranch(repo, "develop");
    await gitExec(repo, ["switch", "develop"]);
    const merge = await gitExec(repo, ["merge", "--no-ff", "-m", "m", side], {
      FORGE_FLOW_OP: "install",
    });
    expect(merge.exitCode).toBe(1);
    expect(merge.stderr).toContain("FLOW-GUARD-04:");
  });
});
