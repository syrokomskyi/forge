/*
<MODULE_CONTRACT>
<purpose>AC-8 (RFC-1327 rerun-safety): running flow.install a second time on
an adopted repository reports every mutating step skipped, writes nothing,
adds no commit — proven by a recursive hash of hooks/ and a for-each-ref
snapshot taken before and after.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 4 — flow.install rerun-safety test</item>
  <item>RFC-1486: step 4 — flow.install two-phase adoption + rerun-safe</item>
  <item>RFC-1486: review r2 — IO-throw step trail, drift-repair and uncommitted-commit tests</item>
  <item>RFC-1490: pre-merge-commit guard mode + per-mode op vocabulary; amends the wave-1 guard RFC's backmerge escape (AC-11)</item>
</CHANGE_SUMMARY>
*/

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { executeInstall, planInstall } from "../handlers/flow-install.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Land a committed change on develop the model-normal way (RFC-1490): open a
 * session branch, write + commit inside its worktree, integrate through the
 * gate. Replaces the retired FORGE_FLOW_OP=backmerge escape.
 */
async function landThroughSession(
  repo: string,
  slug: string,
  file: string,
  content: string,
): Promise<void> {
  const data = await openFlowBranch(repo, ambientIo, {
    kind: "session",
    slug,
    brief: null,
    owner: null,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  dirs.push(data.worktree!);
  const target = join(data.worktree!, file);
  await rm(target, { force: true }).catch(() => {});
  await writeFile(target, content);
  await gitExec(data.worktree!, ["add", file]);
  const commit = await gitExec(data.worktree!, ["commit", "-m", slug]);
  expect(commit.exitCode).toBe(0);
  const integrated = await integrateFlowBranch(repo, ambientIo, {
    branch: data.branch!,
    dryRun: false,
    now: NOW,
  });
  expect(integrated.integrated).toBe(true);
}

async function hashTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(d: string): Promise<void> {
    for (const name of (await readdir(d)).sort()) {
      const p = join(d, name);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else hash.update(`${name}:${s.mode}:`).update(await readFile(p));
    }
  }
  await walk(dir);
  return hash.digest("hex");
}

async function refSnapshot(repo: string): Promise<string> {
  const r = await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  return r.stdout;
}

describe("flow.install rerun-safety (AC-8)", () => {
  it("second run skips every mutating step and changes nothing", async () => {
    const repo = await initRepo({ prefix: "flow-rerun-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');

    // First run — full adoption.
    const first = await planInstall(repo, ambientIo);
    expect(first.refusal).toBeNull();
    await executeInstall(first, ambientIo);

    const hooksHashBefore = await hashTree(join(repo, "hooks"));
    const refsBefore = await refSnapshot(repo);

    // Second run — every mutating step skipped, nothing new.
    const second = await planInstall(repo, ambientIo);
    expect(second.refusal).toBeNull();
    const outcome = await executeInstall(second, ambientIo);

    for (const stepName of ["develop", "hooksPath", "checkout", "guard", "pre-commit", "commit"] as const) {
      const step = second.steps.find((s) => s.step === stepName);
      expect(step?.status, `step ${stepName} must be skipped`).toBe("skipped");
    }
    expect(second.steps.find((s) => s.step === "detect")?.status).toBe("done");
    expect(second.steps.find((s) => s.step === "primary")?.status).toBe("done");
    expect(second.steps.find((s) => s.step === "report")?.status).toBe("done");

    // The embedded check shows no adoption errors (stray-branch FLOW-01 may
    // legitimately appear — never an adoption error).
    expect(
      outcome.checkDiagnostics.filter(
        (d) => d.severity === "error" && d.ruleId !== "FLOW-01",
      ),
    ).toEqual([]);

    expect(await hashTree(join(repo, "hooks"))).toBe(hooksHashBefore);
    expect(await refSnapshot(repo)).toBe(refsBefore);
  });

  it("repairs a drifted core.hooksPath on an adopted repo — committed adoption is the exemption signal, not working-tree state", async () => {
    const repo = await initRepo({ prefix: "flow-drift-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await executeInstall(await planInstall(repo, ambientIo), ambientIo);

    // Drift the config — the state whose remedy is "re-run flow.install".
    await gitExec(repo, ["config", "--unset", "core.hooksPath"]);

    // develop is ahead of main (the adoption commit): without the committed-
    // state exemption this refuses FLOW-ADOPT-01 — the review-r1 dead-end.
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    await executeInstall(plan, ambientIo);
    const hooksPath = await gitExec(repo, ["config", "--get", "core.hooksPath"]);
    expect(hooksPath.stdout.trim()).toBe("hooks");
  });

  it("repairs a drifted committed guard on an adopted repo", async () => {
    const repo = await initRepo({ prefix: "flow-drift-guard-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await executeInstall(await planInstall(repo, ambientIo), ambientIo);

    // Committed drift on develop — model-normal operation: the drift lands
    // through a session branch + the integration gate (RFC-1490 retires the
    // FORGE_FLOW_OP=backmerge escape).
    await landThroughSession(repo, "drift-guard", "hooks/flow-guard.sh", "# drifted\n");

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    expect(plan.guardChange).toBe("write");
    await executeInstall(plan, ambientIo);
    const content = await gitExec(repo, ["show", "develop:hooks/flow-guard.sh"]);
    expect(content.stdout).toContain("forge flow guard");
  });

  it("a third run after normal work landed on develop still skips", async () => {
    const repo = await initRepo({ prefix: "flow-rerun-ahead-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await executeInstall(await planInstall(repo, ambientIo), ambientIo);

    // Simulate model-normal state: develop ahead of main (as after
    // integrated work) — must NOT trip FLOW-ADOPT-01. Work lands through a
    // session branch + the gate (FORGE_FLOW_OP=backmerge is retired).
    await landThroughSession(repo, "integrated-work", "work.txt", "integrated\n");

    const refsBefore = await refSnapshot(repo);
    const third = await planInstall(repo, ambientIo);
    expect(third.refusal).toBeNull();
    await executeInstall(third, ambientIo);
    const dev = third.steps.find((s) => s.step === "develop");
    expect(dev?.status).toBe("skipped");
    expect(await refSnapshot(repo)).toBe(refsBefore);
  });
});
