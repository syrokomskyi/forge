/*
<MODULE_CONTRACT>
<purpose>flow.cut rerun/resume tests (RFC-1490, AC-5): the develop tip's
`chore(release):` subject is the cut's persisted declaration — a rerun with
every named tag present reports released with no mutation; a partially
tagged tail completes exactly the named tags (fingerprints → main → tags).</purpose>
<non-goals>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Resume states are built by running a real cut and then breaking the tail (tag delete, main rewind) — the post-step-4 state is always faithful.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 4 — resume-path tests split out per the RFC file table</item>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
</CHANGE_SUMMARY>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { gitExec, initRepo, installGuard } from "./helpers.ts";
import { runOrdinaryCut } from "../handlers/flow-cut.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

/** Same adopted fixture as flow-cut.test.ts — kept local per test-file independence. */
async function adoptedRepo(): Promise<string> {
  const repo = await initRepo({ prefix: "flow-cut-rerun-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(
    join(repo, "package.json"),
    '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
  );
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);
  await gitExec(repo, ["switch", "-c", "develop"]);
  await writeFile(join(repo, "work.txt"), "work");
  await gitExec(repo, ["add", "work.txt"]);
  await gitExec(repo, ["commit", "-m", "add work.txt"]);
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  const adopt = await gitExec(repo, ["commit", "-m", "chore: adopt forge flow guard"], {
    FORGE_FLOW_OP: "install",
  });
  if (adopt.exitCode !== 0) throw new Error(`adoption commit failed: ${adopt.stderr}`);
  await gitExec(repo, ["tag", "-a", "v0.1.0", "main", "-m", "release v0.1.0"]);
  return repo;
}

describe("flow.cut — rerun/resume (AC-5)", () => {
  it("rerun after a completed cut is a no-op report (resumed, no mutation)", async () => {
    const repo = await adoptedRepo();
    await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    const tipBefore = await sha(repo, "develop");

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    // The tip subject still names v0.1.1 and the tag exists → released report.
    expect(data.released).toBe(true);
    expect(data.resumed).toBe(true);
    expect(await sha(repo, "develop")).toBe(tipBefore);
  }, 30_000);

  it("resumes the tail when the release commit is integrated but the tag is missing", async () => {
    const repo = await adoptedRepo();
    const first = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(first.released).toBe(true);
    // Break the tail: tag gone, main rewound to the baseline.
    await gitExec(repo, ["tag", "-d", "v0.1.1"]);
    await gitExec(repo, ["update-ref", "refs/heads/main", "v0.1.0"]);

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    expect(data.diagnostics).toEqual([]);
    expect(data.released).toBe(true);
    expect(data.resumed).toBe(true);
    expect(await sha(repo, "v0.1.1^{}")).toBe(await sha(repo, "develop"));
    expect(await sha(repo, "main")).toBe(await sha(repo, "develop"));
  }, 30_000);
});
