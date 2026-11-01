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
</CHANGE_SUMMARY>
*/

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { executeInstall, planInstall } from "../handlers/flow-install.ts";
import { gitExec, initRepo } from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

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

  it("a third run after normal work landed on develop still skips", async () => {
    const repo = await initRepo({ prefix: "flow-rerun-ahead-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await executeInstall(await planInstall(repo, ambientIo), ambientIo);

    // Simulate model-normal state: develop ahead of main (as after
    // integrated work) — must NOT trip FLOW-ADOPT-01.
    await writeFile(join(repo, "work.txt"), "integrated\n");
    await gitExec(repo, ["add", "work.txt"]);
    const work = await gitExec(repo, ["commit", "-m", "work"], {
      FORGE_FLOW_OP: "backmerge",
    });
    expect(work.exitCode).toBe(0);

    const refsBefore = await refSnapshot(repo);
    const third = await planInstall(repo, ambientIo);
    expect(third.refusal).toBeNull();
    await executeInstall(third, ambientIo);
    const dev = third.steps.find((s) => s.step === "develop");
    expect(dev?.status).toBe("skipped");
    expect(await refSnapshot(repo)).toBe(refsBefore);
  });
});
