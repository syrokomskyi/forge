/*
<MODULE_CONTRACT>
<purpose>flow.install markers step tests (RFC-1491, AC-10): adoption writes
forge.generated.yaml (generator: repo-extract) into every package-line
directory in the adoption commit; a rerun with all markers present creates
no commit; deleting a marker flips flow.check to FLOW-10.</purpose>
<non-goals>
  <item>No baseline-tag coverage — flow-install-baseline tests own that.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 2 — markers step + FLOW-10 tests</item>
  <item>RFC-1491: step 2 — pre-push guard mode, install steps pre-push + markers, FLOW-10</item>
  <item>RFC-1498: step 2 — network-only marker source

markerSource accepts only network-shaped origins — http/https/ssh/git schemes or the scp user-at-host form — and returns { source, rejectedOrigin }. A local path or file:// URL falls back to the repository directory basename with rejectedOrigin naming the kind (local-path or file-url), so no machine-local path is ever written into an extract repository marker; embedded credentials are still stripped from network URLs. flow.install resolves the source at plan time, stores it on the plan for the execute phase, and the markers step warns origin rejected (kind) — using the directory name, never printing the path. Tests AC-3 (local path and file:// rejected, basename used, path absent from the step detail) and AC-4 (scp URL kept verbatim, https credentials stripped). Also carries the KEY_DECISIONS compass notes for step 1's stray-branch rule.</item>
</CHANGE_SUMMARY>
*/

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectFlowCheck } from "../handlers/flow-check.ts";
import { executeInstall, planInstall } from "../handlers/flow-install.ts";
import { MARKER_FILE, markerSource } from "../markers.ts";
import { gitExec, initRepo } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/** Governed repo with one package line packages/lib + a bare origin. */
async function repoWithPackageLine(): Promise<{ repo: string; origin: string }> {
  const repo = await initRepo({ prefix: "flow-markers-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(
    join(repo, "package.json"),
    '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
  );
  await mkdir(join(repo, "packages", "lib"), { recursive: true });
  await writeFile(
    join(repo, "packages", "lib", "package.json"),
    '{\n  "name": "lib",\n  "version": "0.1.0"\n}\n',
  );
  await writeFile(
    join(repo, "packages", "lib", "extract.config.yaml"),
    "standalone: true\n",
  );
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);

  const origin = await mkdtemp(join(tmpdir(), "flow-markers-origin-"));
  dirs.push(origin);
  await gitExec(origin, ["init", "--bare", "-b", "develop", "."]);
  await gitExec(repo, ["remote", "add", "origin", origin]);
  return { repo, origin };
}

describe("flow.install markers step (RFC-1491)", () => {
  it("writes packages/lib/forge.generated.yaml into the adoption commit (AC-10)", async () => {
    const { repo } = await repoWithPackageLine();
    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    expect(plan.markerPlans.map((m) => m.dir)).toEqual(["packages/lib"]);
    expect(plan.steps.find((s) => s.step === "markers")?.status).toBe("planned");
    await executeInstall(plan, ambientIo);
    expect(plan.steps.find((s) => s.step === "markers")?.status).toBe("done");

    // The marker is committed content — worktrees must check it out.
    const committed = await gitExec(repo, [
      "show",
      `develop:packages/lib/${MARKER_FILE}`,
    ]);
    expect(committed.stdout).toContain("schema: forge/generated@1");
    expect(committed.stdout).toContain("generator: repo-extract");
    // And the source names the line directory.
    expect(committed.stdout).toContain("#packages/lib");
  }, 40_000);

  it("a rerun with all markers present creates no commit", async () => {
    const { repo } = await repoWithPackageLine();
    await executeInstall(await planInstall(repo, ambientIo), ambientIo);
    const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();

    const plan = await planInstall(repo, ambientIo);
    expect(plan.refusal).toBeNull();
    expect(plan.markerPlans).toEqual([]);
    await executeInstall(plan, ambientIo);
    expect(plan.steps.find((s) => s.step === "markers")?.status).toBe("skipped");
    expect((await gitExec(repo, ["rev-parse", "develop"])).stdout.trim()).toBe(tip);
  }, 40_000);

  it("RFC-1498 AC-3: a local-path origin falls back to the directory basename", async () => {
    const { repo, origin } = await repoWithPackageLine();
    const result = await markerSource(repo, ambientIo);
    expect(result.rejectedOrigin).toBe("local-path");
    expect(result.source).toBe(basename(repo));
    // The plan step warns — naming the kind, never the path itself.
    const plan = await planInstall(repo, ambientIo);
    const detail = plan.steps.find((s) => s.step === "markers")?.detail ?? "";
    expect(detail).toContain("origin rejected (local-path)");
    expect(detail).not.toContain(origin);
  }, 40_000);

  it("RFC-1498 AC-3: a file:// origin is rejected as file-url", async () => {
    const { repo, origin } = await repoWithPackageLine();
    await gitExec(repo, ["remote", "set-url", "origin", `file://${origin}`]);
    const result = await markerSource(repo, ambientIo);
    expect(result.rejectedOrigin).toBe("file-url");
    expect(result.source).toBe(basename(repo));
    expect(result.source).not.toContain(origin);
  }, 40_000);

  it("RFC-1498 AC-4: scp-style and credential-bearing origins stay usable", async () => {
    const { repo } = await repoWithPackageLine();
    await gitExec(repo, [
      "remote",
      "set-url",
      "origin",
      "git@github.com:owner/repo.git",
    ]);
    const scp = await markerSource(repo, ambientIo);
    expect(scp.source).toBe("git@github.com:owner/repo.git");
    expect(scp.rejectedOrigin).toBeNull();

    await gitExec(repo, [
      "remote",
      "set-url",
      "origin",
      "https://alice:secret-token@github.com/owner/repo.git",
    ]);
    const cred = await markerSource(repo, ambientIo);
    expect(cred.source).toBe("https://github.com/owner/repo.git");
    expect(cred.rejectedOrigin).toBeNull();
    expect(cred.source).not.toContain("secret-token");
  }, 40_000);

  it("flow.check reports FLOW-10 after a marker is deleted", async () => {
    const { repo } = await repoWithPackageLine();
    await executeInstall(await planInstall(repo, ambientIo), ambientIo);
    const { diagnostics: clean } = await collectFlowCheck(repo, ambientIo);
    expect(clean.filter((d) => d.ruleId === "FLOW-10")).toEqual([]);

    await gitExec(repo, ["rm", `packages/lib/${MARKER_FILE}`]);
    await gitExec(repo, ["commit", "-m", "drop marker"], { FORGE_FLOW_OP: "install" });
    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    const flow10 = diagnostics.filter((d) => d.ruleId === "FLOW-10");
    expect(flow10).toHaveLength(1);
    expect(flow10[0]?.message).toContain("packages/lib");
  }, 40_000);
});
