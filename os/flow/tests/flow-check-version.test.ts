/*
<MODULE_CONTRACT>
<purpose>flow.check release-line diagnostics (RFC-1488: AC-7 plus FLOW-09):
a version file diverging from its line's last tag — or a never-baselined
line — reports FLOW-08 naming both values and pointing at flow.install when
the file is higher; an extract.config.yaml declaring versionBump reports
the FLOW-09 warning.</purpose>
<non-goals>
  <item>No FLOW-01..05 coverage — flow-check.test.ts owns the branch-model rules.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 6 — FLOW-08/FLOW-09 tests</item>
  <item>RFC-1488: steps 5-6 — flow.install baseline tags step, flow.check FLOW-08/FLOW-09</item>
</CHANGE_SUMMARY>
*/

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectFlowCheck } from "../handlers/flow-check.ts";
import { gitExec, initRepo } from "./helpers.ts";

async function governedRepo(): Promise<string> {
  const repo = await initRepo({ prefix: "flow-chk-ver-" });
  await writeFile(join(repo, "forge.yaml"), "name: test\n");
  await writeFile(join(repo, "package.json"), '{ "version": "1.0.0" }\n');
  await gitExec(repo, ["add", "."]);
  await gitExec(repo, ["commit", "-m", "seed governed repo"]);
  return repo;
}

const flow08 = (d: { ruleId: string }) => d.ruleId === "FLOW-08";
const flow09 = (d: { ruleId: string }) => d.ruleId === "FLOW-09";

describe("collectFlowCheck — release lines", () => {
  it("AC-7: version file higher than the last tag reports FLOW-08 naming both", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["tag", "-a", "v1.0.0", "-m", "release v1.0.0"]);
    await writeFile(join(repo, "package.json"), '{ "version": "1.1.0" }\n');
    await gitExec(repo, ["add", "package.json"]);
    await gitExec(repo, ["commit", "-m", "version 1.1.0"]);

    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    const hits = diagnostics.filter(flow08);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("error");
    expect(hits[0]?.message).toContain("1.1.0");
    expect(hits[0]?.message).toContain("v1.0.0");
    expect(hits[0]?.fixHint).toContain("flow.install");
  });

  it("version file lower than the last tag reports FLOW-08 without the install hint", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["tag", "-a", "v2.0.0", "-m", "release v2.0.0"]);

    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    const hits = diagnostics.filter(flow08);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toContain("1.0.0");
    expect(hits[0]?.message).toContain("v2.0.0");
    expect(hits[0]?.fixHint ?? "").not.toContain("flow.install");
  });

  it("a never-baselined line with a version file reports FLOW-08", async () => {
    const repo = await governedRepo();
    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    const hits = diagnostics.filter(flow08);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toContain("1.0.0");
    expect(hits[0]?.message).toContain("never baselined");
    expect(hits[0]?.fixHint).toContain("flow.install");
  });

  it("matching tag and version file report no FLOW-08", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["tag", "-a", "v1.0.0", "-m", "release v1.0.0"]);

    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(diagnostics.filter(flow08)).toEqual([]);
  });

  it("a version file without a version field does not fire FLOW-08", async () => {
    const repo = await governedRepo();
    await writeFile(join(repo, "package.json"), '{ "name": "noversion" }\n');
    await gitExec(repo, ["add", "package.json"]);
    await gitExec(repo, ["commit", "-m", "drop version"]);

    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(diagnostics.filter(flow08)).toEqual([]);
  });

  it("FLOW-09 warns when an extract.config.yaml declares versionBump", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "packages/pbp"), { recursive: true });
    await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writeFile(join(repo, "packages/pbp/package.json"), '{ "version": "2.1.0" }\n');
    await writeFile(
      join(repo, "packages/pbp/extract.config.yaml"),
      "forgePlugin: false\nversionBump: minor\n",
    );
    await gitExec(repo, ["add", "."]);
    await gitExec(repo, ["commit", "-m", "pbp package"]);

    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    const hits = diagnostics.filter(flow09);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.severity).toBe("warning");
    expect(hits[0]?.message).toContain("pbp");
    expect(hits[0]?.message).toContain("versionBump");
  });

  it("a package line without versionBump reports no FLOW-09", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "packages/pbp"), { recursive: true });
    await writeFile(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    await writeFile(join(repo, "packages/pbp/package.json"), '{ "version": "2.1.0" }\n');
    await writeFile(join(repo, "packages/pbp/extract.config.yaml"), "forgePlugin: false\n");
    await gitExec(repo, ["add", "."]);
    await gitExec(repo, ["commit", "-m", "pbp package"]);

    const { diagnostics } = await collectFlowCheck(repo, ambientIo);
    expect(diagnostics.filter(flow09)).toEqual([]);
  });
});
