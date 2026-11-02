/*
<MODULE_CONTRACT>
<purpose>flow.integrate rerun safety (RFC-1487, AC-9): when a mid-cleanup
failure leaves develop already moved but the worktree/branch/entry still
present, a second run detects the resume state and finishes cleanup without
moving develop again.</purpose>
<non-goals>
  <item>No first-pass coverage — flow-integrate.test.ts owns that.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 4 — integrate rerun test</item>
  <item>RFC-1487: step 4 — flow.integrate with lock, primary-side gate, ff-only merge and cleanup resume</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, readRegistry } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

describe("flow.integrate — rerun (AC-9)", () => {
  it("resumes cleanup after a teardown refusal without moving develop again", async () => {
    const repo = await initRepo({ prefix: "flow-int-rerun-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    await gitExec(repo, ["switch", "develop"]);

    // Teardown refuses exactly once (marker in the PRIMARY, so the session
    // worktree stays removable).
    await mkdir(join(repo, "hooks"), { recursive: true });
    await writeFile(
      join(repo, "hooks", "worktree-teardown.sh"),
      '#!/bin/sh\ntest -f "$FLOW_PRIMARY/.teardown-once" || (touch "$FLOW_PRIMARY/.teardown-once"; echo once >&2; exit 1)\n',
    );

    const session = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "rerun",
      brief: null,
      owner: null,
      dryRun: false,
      now: NOW,
    });
    dirs.push(session.worktree!);
    await writeFile(join(session.worktree!, "r.txt"), "r");
    await gitExec(session.worktree!, ["add", "r.txt"]);
    await gitExec(session.worktree!, ["commit", "-m", "add r.txt"]);

    const first = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(first.integrated).toBe(true);
    expect(first.cleanedUp).toBe(false);
    expect(first.diagnostics[0]?.ruleId).toBe("FLOW-INT-04");
    const developAfterFirst = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();

    const second = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(second.diagnostics).toEqual([]);
    expect(second.integrated).toBe(true);
    expect(second.cleanedUp).toBe(true);
    const developAfterSecond = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    expect(developAfterSecond).toBe(developAfterFirst);

    expect((await gitExec(repo, ["rev-parse", "--verify", `refs/heads/${session.branch}`])).exitCode).not.toBe(0);
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.some((b) => b.name === session.branch)).toBe(false);
  }, 25_000);
});
