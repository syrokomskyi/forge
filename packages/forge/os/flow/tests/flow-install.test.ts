/*
<MODULE_CONTRACT>
<purpose>AC-6/AC-7/AC-11 + refusal paths of flow.install: develop behind main
fast-forwards with exactly one new commit (the adoption commit), a diverged
develop refuses FLOW-ADOPT-01 leaving refs and hooks/ untouched, a dirty
primary refuses FLOW-ADOPT-03, a master-only repo refuses FLOW-ADOPT-06, a
custom pre-commit gains the block right after its shebang, --dry-run mutates
nothing, and a fresh adoption ends on develop with the two committed hook
files.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 4 — flow.install behavior tests</item>
  <item>RFC-1486: step 4 — flow.install two-phase adoption + rerun-safe</item>
  <item>RFC-1486: review r2 — IO-throw step trail, drift-repair and uncommitted-commit tests</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
</CHANGE_SUMMARY>
*/

import { stat, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ForgeRuntimeContext } from "../../../src/types.ts";
import { ambientIo } from "../../../src/utils/io.ts";
import {
  executeInstall,
  planInstall,
  runFlowInstall,
} from "../handlers/flow-install.ts";
import { ADOPTION_COMMIT_SUBJECT, MANAGED_BLOCK } from "../guard-files.ts";
import { gitExec, initRepo } from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function governedRepo(opts?: { branch?: string; seedCommit?: boolean }): Promise<string> {
  const dir = await initRepo({ prefix: "flow-install-", ...opts });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  return dir;
}

async function sha(repo: string, ref: string): Promise<string> {
  const r = await gitExec(repo, ["rev-parse", ref]);
  return r.stdout.trim();
}

async function commitOn(repo: string, file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  const r = await gitExec(repo, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

function context(workspaceRoot: string, dryRun = false): ForgeRuntimeContext {
  const logs: string[] = [];
  return {
    workspaceRoot,
    dryRun,
    outputFormat: "json",
    logger: {
      section: (m: string) => logs.push(m),
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      success: (m: string) => logs.push(m),
    },
  };
}

describe("flow.install — adoption", () => {
  it("fast-forwards a develop 3 commits behind main, adding only the adoption commit (AC-6)", async () => {
    const repo = await governedRepo();
    // develop at the seed commit; main advances 3 commits.
    await gitExec(repo, ["branch", "develop", "HEAD"]);
    await commitOn(repo, "a.txt", "a");
    await commitOn(repo, "b.txt", "b");
    await commitOn(repo, "c.txt", "c");
    const mainSha = await sha(repo, "main");
    const developBefore = await sha(repo, "develop");
    expect(developBefore).not.toBe(mainSha);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    await executeInstall(plan, ambientIo);

    const developAfter = await sha(repo, "develop");
    expect(developAfter).not.toBe(developBefore);
    // develop == main + exactly the adoption commit.
    const ahead = await gitExec(repo, ["rev-list", "--count", "main..develop"]);
    expect(ahead.stdout.trim()).toBe("1");
    const behind = await gitExec(repo, ["rev-list", "--count", "develop..main"]);
    expect(behind.stdout.trim()).toBe("0");
    // ...and that commit is the adoption commit.
    const subject = await gitExec(repo, ["log", "-1", "--format=%s", "develop"]);
    expect(subject.stdout.trim()).toBe(ADOPTION_COMMIT_SUBJECT);
  });

  it("refuses FLOW-ADOPT-01 when develop has commits not in main (AC-7)", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["switch", "-c", "develop"]);
    await commitOn(repo, "dev-only.txt", "work");
    await gitExec(repo, ["switch", "main"]);
    const refsBefore = (
      await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])
    ).stdout;
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-01");
    expect(plan.refusal?.message).toContain("1 commit");
    const refused = plan.steps.find((s) => s.status === "refused");
    expect(refused?.step).toBe("develop");
    const refsAfter = (
      await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])
    ).stdout;
    expect(refsAfter).toBe(refsBefore);
    expect(await ambientIo.exists(join(repo, "hooks", "flow-guard.sh"))).toBe(false);
    expect(await ambientIo.exists(join(repo, "hooks", "pre-commit"))).toBe(false);
  });

  it("fresh adoption: adoption commit on develop, exactly the two hook files, primary on develop (AC-11)", async () => {
    const repo = await governedRepo();
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    await executeInstall(plan, ambientIo);

    const subject = await gitExec(repo, ["log", "-1", "--format=%s", "develop"]);
    expect(subject.stdout.trim()).toBe(ADOPTION_COMMIT_SUBJECT);

    const show = await gitExec(repo, ["show", "--stat", "--format=", "HEAD"]);
    const files = show.stdout.trim().split("\n").filter((l) => l.includes("|"));
    expect(files.map((l) => l.split("|")[0]!.trim())).toEqual([
      "hooks/flow-guard.sh",
      "hooks/pre-commit",
      "hooks/pre-merge-commit",
    ]);

    const branch = await gitExec(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    expect(branch.stdout.trim()).toBe("develop");

    // Committed mode bits: both hooks executable (100755).
    const modes = await gitExec(repo, ["ls-files", "-s", "hooks"]);
    for (const line of modes.stdout.trim().split("\n")) {
      expect(line.startsWith("100755")).toBe(true);
    }
    const hooksPath = await gitExec(repo, ["config", "--get", "core.hooksPath"]);
    expect(hooksPath.stdout.trim()).toBe("hooks");
    // The guard file on disk is executable too.
    const st = await stat(join(repo, "hooks", "flow-guard.sh"));
    expect(st.mode & 0o111).not.toBe(0);
  });

  it("refuses FLOW-ADOPT-03 on a dirty tracked file and changes nothing", async () => {
    const repo = await governedRepo();
    await writeFile(join(repo, "seed.txt"), "dirty\n");
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-03");
    expect(plan.refusal?.message).toContain("seed.txt");
    expect((await gitExec(repo, ["branch", "--list", "develop"])).stdout.trim()).toBe("");
    expect(await ambientIo.exists(join(repo, "hooks"))).toBe(false);
  });

  it("refuses FLOW-ADOPT-06 on a master-only repository", async () => {
    const repo = await governedRepo({ branch: "master" });
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-06");
    expect(plan.refusal?.message).toContain("main");
  });

  it("refuses FLOW-ADOPT-05 on a generated (exempt) repository", async () => {
    const repo = await governedRepo();
    await writeFile(
      join(repo, "forge.generated.yaml"),
      'schema: "forge/generated@1"\ngenerator: "extract"\nsource: "werkstatt"\n',
    );
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-05");
  });

  it("refuses FLOW-ADOPT-02 when core.hooksPath carries a foreign value", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["config", "core.hooksPath", ".githooks"]);
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-02");
    expect(plan.refusal?.message).toContain(".githooks");
  });

  it("refuses FLOW-ADOPT-08 when the primary is on a foreign branch", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "develop", "main"]);
    await gitExec(repo, ["switch", "-c", "feature/x"]);
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-08");
    expect(plan.refusal?.message).toContain("feature/x");
  });

  it("inserts the managed block right after the shebang of a custom pre-commit, body unchanged", async () => {
    const repo = await governedRepo();
    const { mkdir, chmod } = await import("node:fs/promises");
    await mkdir(join(repo, "hooks"));
    const custom = "#!/bin/sh\necho custom\nexit 0\n";
    await writeFile(join(repo, "hooks", "pre-commit"), custom);
    await chmod(join(repo, "hooks", "pre-commit"), 0o755);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.preCommitChange).toBe("insert");
    await executeInstall(plan, ambientIo);

    const after = await ambientIo.readFile(join(repo, "hooks", "pre-commit"));
    expect(after).toBe(`#!/bin/sh\n${MANAGED_BLOCK}echo custom\nexit 0\n`);
  });

  it("byte-exact but uncommitted hook files still land the adoption commit", async () => {
    const repo = await governedRepo();
    // Working tree already carries the exact hook bytes but they were never
    // committed — the committedness gate must still plan the adoption commit
    // (RFC-1487 worktrees check out committed content only).
    const { mkdir, chmod } = await import("node:fs/promises");
    const { readGuardAsset } = await import("../guard-files.ts");
    await mkdir(join(repo, "hooks"));
    await writeFile(join(repo, "hooks", "flow-guard.sh"), readGuardAsset());
    await writeFile(join(repo, "hooks", "pre-commit"), `#!/bin/sh\n${MANAGED_BLOCK}`);
    await chmod(join(repo, "hooks", "flow-guard.sh"), 0o755);
    await chmod(join(repo, "hooks", "pre-commit"), 0o755);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    await executeInstall(plan, ambientIo);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:hooks/flow-guard.sh"])).exitCode).toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:hooks/pre-commit"])).exitCode).toBe(0);
  });

  it("adopts an unborn repository: first commit lands on develop", async () => {
    const repo = await governedRepo({ branch: "main", seedCommit: false });
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    await executeInstall(plan, ambientIo);
    const subject = await gitExec(repo, ["log", "-1", "--format=%s", "develop"]);
    expect(subject.stdout.trim()).toBe(ADOPTION_COMMIT_SUBJECT);
    const branch = await gitExec(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    expect(branch.stdout.trim()).toBe("develop");
  });
});

describe("runFlowInstall — dry run and refusal surface", () => {
  it("--dry-run plans every step and changes nothing", async () => {
    const repo = await governedRepo();
    const before = (
      await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])
    ).stdout;
    const result = await runFlowInstall({ argv: [], flags: {} }, context(repo, true));
    expect(result.exitCode).toBe(0);
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.steps.some((s) => s.step === "develop")).toBe(true);
    const after = (
      await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])
    ).stdout;
    expect(after).toBe(before);
    expect(await ambientIo.exists(join(repo, "hooks"))).toBe(false);
    expect((await gitExec(repo, ["config", "--get", "core.hooksPath"])).exitCode).toBe(1);
  });

  it("a refused plan surfaces exitCode 1 with the steps trail", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["config", "core.hooksPath", ".githooks"]);
    const result = await runFlowInstall({ argv: [], flags: {} }, context(repo, false));
    expect(result.exitCode).toBe(1);
    expect(result.data?.steps.some((s) => s.status === "refused" && s.step === "hooksPath")).toBe(
      true,
    );
  });
});
