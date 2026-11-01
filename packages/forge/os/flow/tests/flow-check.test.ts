/*
<MODULE_CONTRACT>
<purpose>AC-9: collectFlowCheck reports FLOW-01 (stray branch), FLOW-02
(missing develop), FLOW-03 (guard not installed), FLOW-04 (owed back-merge)
and FLOW-05 (invalid marker) in governed repositories, and returns an exempt
verdict with no diagnostics for a valid forge.generated.yaml — all in
throwaway repos.</purpose>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1486: step 3 — flow.check handler tests</item>
  <item>RFC-1486: step 3 — flow.check with FLOW-01..05 + managed-block helpers</item>
</CHANGE_SUMMARY>
*/

import { writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectFlowCheck } from "../handlers/flow-check.ts";
import {
  gitExec,
  initRepo,
  installGuard,
  MANAGED_BLOCK,
} from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-check-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  return dir;
}

const VALID_MARKER =
  'schema: "forge/generated@1"\ngenerator: "extract"\nsource: "werkstatt"\n';

describe("collectFlowCheck", () => {
  it("reports FLOW-01 naming a stray local branch (AC-9)", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "develop"]);
    await gitExec(repo, ["branch", "introduce-axiom-system"]);
    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    const flow01 = diagnostics.filter((d) => d.ruleId === "FLOW-01");
    expect(flow01.length).toBe(1);
    expect(flow01[0]!.severity).toBe("error");
    expect(flow01[0]!.message).toContain("introduce-axiom-system");
    expect(flow01[0]!.fixHint).toContain("git branch -d introduce-axiom-system");
  });

  it("reports FLOW-02 when develop does not exist", async () => {
    const repo = await governedRepo();
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(diagnostics.some((d) => d.ruleId === "FLOW-02")).toBe(true);
    expect(data.branches.protected).toEqual(["main"]);
    expect(data.mainAheadOfDevelop).toBeNull();
  });

  it("reports FLOW-03 when the guard is not installed", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "develop"]);
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    const flow03 = diagnostics.filter((d) => d.ruleId === "FLOW-03");
    expect(flow03.length).toBeGreaterThanOrEqual(2);
    expect(flow03.some((d) => d.message.includes("core.hooksPath"))).toBe(true);
    expect(flow03.some((d) => d.message.includes("pre-commit"))).toBe(true);
    expect(flow03.some((d) => d.message.includes("flow-guard.sh"))).toBe(true);
    expect(data.guardInstalled).toBe(false);
  });

  it("reports FLOW-04 as a warning when main is ahead of develop", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "develop"]);
    await writeFile(join(repo, "ahead.txt"), "ahead\n");
    await gitExec(repo, ["add", "ahead.txt"]);
    await gitExec(repo, ["commit", "-m", "on main"]);
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    const flow04 = diagnostics.filter((d) => d.ruleId === "FLOW-04");
    expect(flow04.length).toBe(1);
    expect(flow04[0]!.severity).toBe("warning");
    expect(flow04[0]!.message).toContain("1 commit");
    expect(data.mainAheadOfDevelop).toBe(1);
  });

  it("reports FLOW-05 for a marker missing source (no exemption)", async () => {
    const repo = await governedRepo();
    await writeFile(
      join(repo, "forge.generated.yaml"),
      'schema: "forge/generated@1"\ngenerator: "extract"\n',
    );
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    const flow05 = diagnostics.filter((d) => d.ruleId === "FLOW-05");
    expect(flow05.length).toBe(1);
    expect(flow05[0]!.severity).toBe("error");
    expect(flow05[0]!.message).toContain("source");
    expect(data.repoKind).toBe("governed");
    expect(data.exempt).toBe(false);
  });

  it("returns an exempt verdict with the parsed marker and no diagnostics", async () => {
    const repo = await initRepo({ prefix: "flow-check-exempt-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.generated.yaml"), VALID_MARKER);
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(data.repoKind).toBe("exempt");
    expect(data.exempt).toBe(true);
    expect(data.marker).toEqual({
      schema: "forge/generated@1",
      generator: "extract",
      source: "werkstatt",
    });
    expect(diagnostics).toEqual([]);
  });

  it("reports an ungoverned repo without diagnostics", async () => {
    const repo = await initRepo({ prefix: "flow-check-ungoverned-" });
    dirs.push(repo);
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(data.repoKind).toBe("ungoverned");
    expect(diagnostics).toEqual([]);
  });

  it("passes clean on a fully adopted repository", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "develop"]);
    await gitExec(repo, ["switch", "develop"]);
    await installGuard(repo);
    // Land the hook files via the adoption path (FORGE_FLOW_OP=install).
    await gitExec(repo, ["add", "hooks/flow-guard.sh", "hooks/pre-commit"]);
    const adopt = await gitExec(
      repo,
      ["commit", "-m", "chore(flow): install the fixed branch model guard"],
      { FORGE_FLOW_OP: "install" },
    );
    expect(adopt.exitCode).toBe(0);
    const { data, diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(data.guardInstalled).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("detects a stale managed block inside hooks/pre-commit", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "develop"]);
    await installGuard(repo);
    // Corrupt the managed block: remove the invoke line.
    const preCommitPath = join(repo, "hooks", "pre-commit");
    const content = await ambientIo.readFile(preCommitPath);
    const corrupt = content.replace(
      'sh "$(git rev-parse --show-toplevel)/hooks/flow-guard.sh" pre-commit || exit 1\n',
      "",
    );
    expect(corrupt).not.toContain("flow-guard.sh");
    await writeFile(preCommitPath, corrupt);
    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(diagnostics.some((d) => d.ruleId === "FLOW-03")).toBe(true);
    // Sanity for the shared constant shape.
    expect(MANAGED_BLOCK).toContain(">>> forge flow guard");
  });
});
