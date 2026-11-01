/*
<MODULE_CONTRACT>
<purpose>AC-2/AC-3/AC-4: the installed POSIX guard refuses commits on
develop/main (FLOW-GUARD-01), non-conforming names (FLOW-GUARD-02), detached
HEAD outside rebase/cherry-pick (FLOW-GUARD-03) and unknown FORGE_FLOW_OP
values (FLOW-GUARD-04); it allows conforming auto branches, generated repos,
the closed FORGE_FLOW_OP vocabulary and the unborn develop — proven by real
`git commit` runs through core.hooksPath in throwaway repos.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 2 — guard behavior tests</item>
  <item>RFC-1486: step 2 — POSIX guard asset + behavior/parity tests</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeFile } from "node:fs/promises";

import {
  gitExec,
  initRepo,
  installGuard,
  tryCommit,
} from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function repoWithGuard(opts?: {
  branch?: string;
  seedCommit?: boolean;
}): Promise<string> {
  const dir = await initRepo(opts);
  dirs.push(dir);
  await installGuard(dir);
  return dir;
}

function expectRefusal(result: { exitCode: number | null; stderr: string }, rule: string) {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`${rule}:`);
  expect(result.stderr).toContain("remedy:");
}

describe("flow-guard.sh via core.hooksPath", () => {
  it("refuses a commit on develop with FLOW-GUARD-01 (AC-2)", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "-c", "develop"]);
    expectRefusal(await tryCommit(repo, { FORGE_FLOW_OP: "" }), "FLOW-GUARD-01");
  });

  it("refuses a commit on main with FLOW-GUARD-01", async () => {
    const repo = await repoWithGuard();
    expectRefusal(await tryCommit(repo, { FORGE_FLOW_OP: "" }), "FLOW-GUARD-01");
  });

  it("refuses a commit on feature/x with FLOW-GUARD-02 (AC-3)", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "-c", "feature/x"]);
    expectRefusal(await tryCommit(repo, { FORGE_FLOW_OP: "" }), "FLOW-GUARD-02");
  });

  it("allows a commit on a conforming auto branch", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "-c", "auto/session-261101-01-guard-test"]);
    const result = await tryCommit(repo, { FORGE_FLOW_OP: "" });
    expect(result.exitCode).toBe(0);
  });

  it("refuses a commit on a detached HEAD with FLOW-GUARD-03", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "--detach"]);
    expectRefusal(await tryCommit(repo, { FORGE_FLOW_OP: "" }), "FLOW-GUARD-03");
  });

  it("allows a detached HEAD while a rebase is in progress", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "--detach"]);
    // A rebase-merge directory inside the git dir marks an in-flight rebase.
    const gitDir = join(repo, ".git", "rebase-merge");
    await mkdir(gitDir, { recursive: true });
    const result = await tryCommit(repo, { FORGE_FLOW_OP: "" });
    expect(result.exitCode).toBe(0);
  });

  it("allows the adoption commit: FORGE_FLOW_OP=install on develop", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "-c", "develop"]);
    const result = await tryCommit(repo, { FORGE_FLOW_OP: "install" });
    expect(result.exitCode).toBe(0);
  });

  it("allows the release back-merge: FORGE_FLOW_OP=backmerge on develop", async () => {
    const repo = await repoWithGuard();
    await gitExec(repo, ["switch", "-c", "develop"]);
    const result = await tryCommit(repo, { FORGE_FLOW_OP: "backmerge" });
    expect(result.exitCode).toBe(0);
  });

  it("refuses an unknown FORGE_FLOW_OP with FLOW-GUARD-04, before branch checks", async () => {
    const repo = await repoWithGuard();
    // On main — a bogus op must surface FLOW-GUARD-04, not FLOW-GUARD-01.
    expectRefusal(await tryCommit(repo, { FORGE_FLOW_OP: "bogus" }), "FLOW-GUARD-04");
  });

  it("exempts a repository carrying forge.generated.yaml (AC-4)", async () => {
    const repo = await repoWithGuard();
    await writeFile(
      join(repo, "forge.generated.yaml"),
      'schema: "forge/generated@1"\ngenerator: "extract"\nsource: "werkstatt"\n',
    );
    const result = await tryCommit(repo, { FORGE_FLOW_OP: "" });
    expect(result.exitCode).toBe(0);
  });

  it("allows the repository's first commit on an unborn develop", async () => {
    const repo = await repoWithGuard({ branch: "develop", seedCommit: false });
    const result = await tryCommit(repo, { FORGE_FLOW_OP: "" });
    expect(result.exitCode).toBe(0);
  });

  it("still refuses the first commit on an unborn main", async () => {
    const repo = await repoWithGuard({ branch: "main", seedCommit: false });
    expectRefusal(await tryCommit(repo, { FORGE_FLOW_OP: "" }), "FLOW-GUARD-01");
  });
});
