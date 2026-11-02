/*
<MODULE_CONTRACT>
<purpose>flow.install baseline-tag tests (RFC-1488: AC-5, AC-6 plus the
FLOW-ADOPT-07 refusals): a stale reachable tag never hides a higher version
file, the pickaxe finds the version-introduction commit (canonical and
whitespace-variant formatting), backwards versions refuse, and a baseline
commit outside main refuses. All tags are created only in throwaway repos
under the OS temp dir.</purpose>
<non-goals>
  <item>No rerun coverage — flow-install-baseline.rerun.test.ts owns the second-run identity.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 5 — baseline-tag plan/execute tests</item>
  <item>RFC-1488: steps 5-6 — flow.install baseline tags step, flow.check FLOW-08/FLOW-09</item>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
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

async function seedRepo(version: string): Promise<string> {
  const repo = await initRepo({ prefix: "flow-base-" });
  dirs.push(repo);
  await mkdir(join(repo, "packages/forge"), { recursive: true });
  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  await writeFile(
    join(repo, "packages/forge/extract.config.yaml"),
    "forgePlugin: true\n",
  );
  await writeFile(join(repo, "package.json"), `{ "version": "${version}" }\n`);
  await writeFile(
    join(repo, "packages/forge/package.json"),
    `{ "version": "${version}" }\n`,
  );
  await writeFile(join(repo, "forge.yaml"), "name: test\n");
  await gitExec(repo, ["add", "."]);
  await gitExec(repo, ["commit", "-m", `version ${version}`]);
  return repo;
}

async function listTags(repo: string): Promise<string[]> {
  const r = await gitExec(repo, ["tag", "--list"]);
  return r.stdout.split("\n").map((t) => t.trim()).filter(Boolean).sort();
}

async function tagTarget(repo: string, tag: string): Promise<string> {
  const r = await gitExec(repo, ["rev-list", "-n", "1", tag]);
  return r.stdout.trim();
}

describe("flow.install baseline tags", () => {
  it("AC-5: stale forge@0.15.0 + version file 9.0.0 → forge@9.0.0 at the version commit", async () => {
    const repo = await seedRepo("9.0.0");
    const versionCommit = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
    // Stale tag on an older ancestor — the audit-G1 trap.
    const stale = await gitExec(repo, ["commit", "--allow-empty", "-m", "stale era"]);
    if (stale.exitCode !== 0) throw new Error(stale.stderr);
    await gitExec(repo, ["tag", "-a", "forge@0.15.0", "-m", "release forge@0.15.0", "HEAD~1"]);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    const tagPlans = plan.tagPlans;
    expect(tagPlans.map((t) => t.tag).sort()).toEqual(["forge@9.0.0", "v9.0.0"]);
    expect(tagPlans.find((t) => t.tag === "forge@9.0.0")?.commit).toBe(versionCommit);
    expect(tagPlans.find((t) => t.tag === "forge@9.0.0")?.previous).toBe("forge@0.15.0");

    const { check } = await executeInstall(plan, ambientIo);
    expect(check).not.toBeNull();
    const tags = await listTags(repo);
    expect(tags).toContain("forge@9.0.0");
    expect(tags).toContain("v9.0.0");
    expect(await tagTarget(repo, "forge@9.0.0")).toBe(versionCommit);
    // Baseline annotation follows forge/release-tag@1.
    const message = (await gitExec(repo, ["tag", "-l", "--format=%(contents)", "forge@9.0.0"])).stdout;
    expect(message).toContain("schema: forge/release-tag@1");
    expect(message).toContain("level: baseline");
    expect(message).toContain("previous: forge@0.15.0");
  });

  it("pickaxe fallback: version file without canonical spacing still finds the commit", async () => {
    const repo = await initRepo({ prefix: "flow-base-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), "name: test\n");
    await writeFile(join(repo, "package.json"), '{"version":"3.1.4"}\n');
    await gitExec(repo, ["add", "."]);
    await gitExec(repo, ["commit", "-m", "version 3.1.4"]);
    const versionCommit = (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    expect(plan.tagPlans).toEqual([
      {
        line: "repo",
        tag: "v3.1.4",
        version: "3.1.4",
        commit: versionCommit,
        previous: null,
      },
    ]);
  });

  it("version file lower than the last tag refuses FLOW-ADOPT-07 and tags nothing", async () => {
    const repo = await seedRepo("9.0.0");
    await gitExec(repo, ["tag", "-a", "v9.5.0", "-m", "release v9.5.0"]);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-07");
    expect(plan.refusal?.message).toContain("9.0.0");
    expect(plan.refusal?.message).toContain("v9.5.0");
    // No tag was created during the refused plan.
    expect(await listTags(repo)).toEqual(["v9.5.0"]);
  });

  it("a version commit reachable only on develop refuses FLOW-ADOPT-07", async () => {
    const repo = await seedRepo("1.0.0");
    // First install: adopted, primary now on develop, v1.0.0 baselined.
    const first = await planInstall(repo, ambientIo);
    expect(first.refusal).toBeNull();
    await executeInstall(first, ambientIo);
    expect(await listTags(repo)).toContain("v1.0.0");

    // Bump the version on develop — a commit main has never seen.
    await writeFile(join(repo, "package.json"), '{ "version": "2.0.0" }\n');
    await gitExec(repo, ["add", "package.json"]);
    const bump = await gitExec(repo, ["commit", "-m", "version 2.0.0"], {
      FORGE_FLOW_OP: "install",
    });
    if (bump.exitCode !== 0) throw new Error(bump.stderr);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-07");
    expect(plan.refusal?.message).toContain("not an ancestor of main");
  });

  it("equal tag and version file → no tag plan", async () => {
    const repo = await seedRepo("1.0.0");
    await gitExec(repo, ["tag", "-a", "v1.0.0", "-m", "release v1.0.0"]);
    await gitExec(repo, ["tag", "-a", "forge@1.0.0", "-m", "release forge@1.0.0"]);

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    expect(plan.tagPlans).toEqual([]);
    const { check } = await executeInstall(plan, ambientIo);
    expect(check).not.toBeNull();
    expect(plan.steps.find((s) => s.step === "tags")?.status).toBe("skipped");
    expect(await listTags(repo)).toEqual(["forge@1.0.0", "v1.0.0"]);
  });
});
