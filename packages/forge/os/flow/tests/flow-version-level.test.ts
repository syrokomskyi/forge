/*
<MODULE_CONTRACT>
<purpose>Pending-level tests (RFC-1488: AC-3): commits carrying X-RFC
trailers are resolved through the canonical RFC reader against the temp
repo's docs/rfcs, the highest declared versionBump wins, missing bumps fall
back to patch, and a missing RFC file reports FLOW-VER-03 while still
counting patch.</purpose>
<non-goals>
  <item>No tag selection — flow-version.test.ts owns the derived-version math.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1488: step 4 — pending-level tests (X-RFC + versionBump)</item>
  <item>RFC-1488: steps 2-4 — release tags, pending level (X-RFC + versionBump), flow.version command</item>
  <item>RFC-1488: review r1 — parse guard, door/rules metadata, id-exact RFC binding, refname precision, FLOW-09 top-level anchor, test cleanup</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectFlowVersion } from "../handlers/flow-version.ts";
import { gitExec, initRepo } from "./helpers.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function rfc(repo: string, id: string, versionBump: string): Promise<void> {
  const file = `docs/rfcs/${id.toLowerCase()}-test.md`;
  await mkdir(join(repo, "docs/rfcs"), { recursive: true });
  await writeFile(
    join(repo, file),
    `---\nid: ${id}\ntitle: test\nstatus: accepted\nversionBump: ${versionBump}\n---\n\n# ${id}\n`,
  );
}

async function commitWithTrailer(repo: string, message: string, rfcId: string | null): Promise<void> {
  const args = ["commit", "--allow-empty", "-m", message];
  if (rfcId !== null) args.push("--trailer", `X-RFC: ${rfcId}`);
  const result = await gitExec(repo, args);
  if (result.exitCode !== 0) throw new Error(`commit failed: ${result.stderr}`);
}

async function repoWithTag(): Promise<string> {
  const repo = await initRepo({ prefix: "flow-lvl-" });
  dirs.push(repo);
  await writeFile(join(repo, "package.json"), '{ "version": "1.0.0" }\n');
  await gitExec(repo, ["add", "package.json"]);
  await gitExec(repo, ["commit", "-m", "version 1.0.0"]);
  const tag = await gitExec(repo, ["tag", "-a", "v1.0.0", "-m", "release v1.0.0"]);
  if (tag.exitCode !== 0) throw new Error(tag.stderr);
  return repo;
}

describe("pending level via flow.version", () => {
  it("AC-3: patch + minor trailers report level minor and the bumped nextVersion", async () => {
    const repo = await repoWithTag();
    await rfc(repo, "RFC-1486", "patch");
    await rfc(repo, "RFC-1488", "minor");
    await gitExec(repo, ["add", "docs/rfcs"]);
    await gitExec(repo, ["commit", "-m", "rfcs"]);
    await commitWithTrailer(repo, "patch change", "RFC-1486");
    await commitWithTrailer(repo, "minor change", "RFC-1488");

    const { data, diagnostics } = await collectFlowVersion(repo, ambientIo, "repo");
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const line = data.lines[0];
    expect(line?.level).toBe("minor");
    expect(line?.nextVersion).toBe("1.1.0");
    expect(line?.rfcs).toEqual([
      { id: "RFC-1486", versionBump: "patch" },
      { id: "RFC-1488", versionBump: "minor" },
    ]);
  });

  it("commits without usable trailers fall back to patch", async () => {
    const repo = await repoWithTag();
    await commitWithTrailer(repo, "no trailer", null);

    const { data } = await collectFlowVersion(repo, ambientIo, "repo");
    expect(data.lines[0]?.level).toBe("patch");
    expect(data.lines[0]?.nextVersion).toBe("1.0.1");
  });

  it("a major trailer beats minor and patch", async () => {
    const repo = await repoWithTag();
    await rfc(repo, "RFC-1400", "major");
    await gitExec(repo, ["add", "docs/rfcs"]);
    await gitExec(repo, ["commit", "-m", "rfcs"]);
    await commitWithTrailer(repo, "breaking", "RFC-1400");

    const { data } = await collectFlowVersion(repo, ambientIo, "repo");
    expect(data.lines[0]?.level).toBe("major");
    expect(data.lines[0]?.nextVersion).toBe("2.0.0");
  });

  it("a trailer naming a missing RFC warns FLOW-VER-03 and still counts patch", async () => {
    const repo = await repoWithTag();
    await commitWithTrailer(repo, "ghost", "RFC-9999");

    const { data, diagnostics } = await collectFlowVersion(repo, ambientIo, "repo");
    const ver03 = diagnostics.filter((d) => d.ruleId === "FLOW-VER-03");
    expect(ver03).toHaveLength(1);
    expect(ver03[0]?.message).toContain("RFC-9999");
    expect(data.lines[0]?.level).toBe("patch");
    expect(data.lines[0]?.rfcs).toEqual([{ id: "RFC-9999", versionBump: null }]);
  });
});
