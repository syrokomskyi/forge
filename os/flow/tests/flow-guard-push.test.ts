/*
<MODULE_CONTRACT>
<purpose>pre-push guard tests (RFC-1491, AC-4): a plain git push in an adopted
repository is refused with FLOW-GUARD-05 naming the digest remedy;
FORGE_FLOW_OP=push passes; FORGE_FLOW_OP=push on a commit path refuses with
FLOW-GUARD-04 (per-mode closed vocabulary).</purpose>
<non-goals>
  <item>No digest/push command coverage — flow-digest/flow-push tests own that.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 2 — pre-push guard tests</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitExec, initRepo, installGuard } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/** Adopted repo with a bare origin — pushes are hook-guarded. */
async function adoptedWithOrigin(): Promise<{ repo: string; origin: string }> {
  const repo = await initRepo({ prefix: "flow-push-guard-" });
  dirs.push(repo);
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  const adopt = await gitExec(repo, ["commit", "-m", "adopt"], {
    FORGE_FLOW_OP: "install",
  });
  if (adopt.exitCode !== 0) throw new Error(`adopt commit failed: ${adopt.stderr}`);
  await gitExec(repo, ["switch", "-c", "develop"]);

  const origin = await mkdtemp(join(tmpdir(), "flow-push-origin-"));
  dirs.push(origin);
  const bare = await gitExec(origin, ["init", "--bare", "-b", "develop", "."]);
  if (bare.exitCode !== 0) throw new Error(`bare init failed: ${bare.stderr}`);
  await gitExec(repo, ["remote", "add", "origin", origin]);
  return { repo, origin };
}

describe("flow-guard pre-push (RFC-1491)", () => {
  it("refuses a plain git push with FLOW-GUARD-05 and the digest remedy (AC-4)", async () => {
    const { repo } = await adoptedWithOrigin();
    const push = await gitExec(repo, ["push", "origin", "develop"], {
      FORGE_FLOW_OP: "",
    });
    expect(push.exitCode).not.toBe(0);
    expect(push.stderr).toContain("FLOW-GUARD-05");
    expect(push.stderr).toContain("flow.digest");
  }, 30_000);

  it("accepts the push under FORGE_FLOW_OP=push", async () => {
    const { repo, origin } = await adoptedWithOrigin();
    const push = await gitExec(repo, ["push", "-u", "origin", "develop"], {
      FORGE_FLOW_OP: "push",
    });
    expect(push.exitCode, push.stderr).toBe(0);
    const remote = await gitExec(origin, ["rev-parse", "refs/heads/develop"]);
    const local = await gitExec(repo, ["rev-parse", "develop"]);
    expect(remote.stdout.trim()).toBe(local.stdout.trim());
  }, 30_000);

  it("refuses FORGE_FLOW_OP=push on the commit path with FLOW-GUARD-04", async () => {
    const { repo } = await adoptedWithOrigin();
    const commit = await gitExec(repo, ["commit", "--allow-empty", "-m", "x"], {
      FORGE_FLOW_OP: "push",
    });
    expect(commit.exitCode).not.toBe(0);
    expect(commit.stderr).toContain("FLOW-GUARD-04");
  }, 30_000);

  it("exempts a repository carrying forge.generated.yaml at its root", async () => {
    const { repo, origin } = await adoptedWithOrigin();
    // The extract marker at the top level marks a generator-owned repository.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(repo, "forge.generated.yaml"),
      "schema: forge/generated@1\ngenerator: repo-extract\n",
    );
    await gitExec(repo, ["add", "forge.generated.yaml"]);
    await gitExec(repo, ["commit", "-m", "marker"], { FORGE_FLOW_OP: "install" });
    const push = await gitExec(repo, ["push", "origin", "develop:refs/heads/develop"], {
      FORGE_FLOW_OP: "",
    });
    expect(push.exitCode, push.stderr).toBe(0);
    void origin;
  }, 30_000);
});
