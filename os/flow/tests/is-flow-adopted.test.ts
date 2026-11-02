/*
<MODULE_CONTRACT>
<purpose>isFlowAdopted (RFC-1494 step 1): the public adoption test moved to
os/flow/index.ts — governed + develop exists + the pre-commit managed block
committed on develop. A worktree-local or uncommitted block does not count.</purpose>
<non-goals>
  <item>No flow.cut behavior — flow-cut.test.ts owns the command.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1494: step 1 — isFlowAdopted public export tests</item>
  <item>RFC-1494: step 1 — isFlowAdopted public export</item>
</CHANGE_SUMMARY>
*/

import { describe, expect, it } from "vitest";

import { isFlowAdopted } from "../index.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import { gitExec, initRepo, installGuard } from "./helpers.ts";

const io = ambientIo;

describe("isFlowAdopted (RFC-1494)", () => {
  it("returns false for an ungoverned repository", async () => {
    const repo = await initRepo();
    expect(await isFlowAdopted(repo, io)).toBe(false);
  });

  it("returns false for a governed repository without develop", async () => {
    const repo = await initRepo();
    await gitExec(repo, ["config", "user.email", "flow-test@example.invalid"]);
    await ambientIo.writeFile(
      `${repo}/forge.yaml`,
      'schema: "forge/workspace@1"\n',
    );
    expect(await isFlowAdopted(repo, io)).toBe(false);
  });

  it("returns false when develop exists but the managed block is not committed", async () => {
    const repo = await initRepo();
    await ambientIo.writeFile(
      `${repo}/forge.yaml`,
      'schema: "forge/workspace@1"\n',
    );
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-m", "forge config"]);
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    // Guard installed in the worktree only — never committed to develop.
    await installGuard(repo);
    expect(await isFlowAdopted(repo, io)).toBe(false);
  });

  it("returns true when develop carries the committed managed block", async () => {
    const repo = await initRepo();
    await ambientIo.writeFile(
      `${repo}/forge.yaml`,
      'schema: "forge/workspace@1"\n',
    );
    await gitExec(repo, ["add", "forge.yaml"]);
    await gitExec(repo, ["commit", "-m", "forge config"]);
    await installGuard(repo);
    await gitExec(repo, ["add", "hooks"]);
    const adopt = await gitExec(repo, ["commit", "-m", "chore: adopt forge flow guard"], {
      FORGE_FLOW_OP: "install",
    });
    if (adopt.exitCode !== 0) throw new Error(`adoption commit failed: ${adopt.stderr}`);
    await gitExec(repo, ["branch", "-f", "develop", "HEAD"]);
    expect(await isFlowAdopted(repo, io)).toBe(true);
  });
});
