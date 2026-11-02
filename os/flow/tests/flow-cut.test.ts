/*
<MODULE_CONTRACT>
<purpose>flow.cut ordinary-path tests (RFC-1490): an adopted throwaway
repository (guard installed, baseline tag, pending commits) gets a release —
release branch opened through flow.open, version files verified-written,
chore(release) commit integrated into develop under the gate, main
compare-and-swapped to the develop tip, release tags annotated at the tip.
Covers every plan-phase refusal (FLOW-CUT-01..07, FLOW-CUT-11) plus the
resume path (AC-5: subject-named tags missing → tail re-runs).</purpose>
<non-goals>
  <item>No fix-mode cuts — flow.fix tests cover that path.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The adoption commit lands on develop BEFORE the guard install — pending work commits precede it so level calculation sees them; the hooks commit runs under FORGE_FLOW_OP=install exactly like flow.install's.</item>
  <item>Resume is exercised by deleting the cut's tag and rewinding main — cheaper and more faithful than hand-building the intermediate state.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1490: step 4 — flow.cut happy path, refusals, and resume tests</item>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { gitExec, initRepo, installGuard } from "./helpers.ts";
import { runOrdinaryCut } from "../handlers/flow-cut.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function commitIn(repo: string, file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  const r = await gitExec(repo, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit in ${repo} failed: ${r.stderr}`);
}

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

/**
 * Adopted repository: governed + develop + committed guard files + baseline
 * tag v0.1.0 + one pending work commit on develop.
 */
async function adoptedRepo(opts?: { pending?: boolean }): Promise<string> {
  const repo = await initRepo({ prefix: "flow-cut-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(
    join(repo, "package.json"),
    '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
  );
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);
  await gitExec(repo, ["switch", "-c", "develop"]);
  if (opts?.pending !== false) await commitIn(repo, "work.txt", "work");
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  const adopt = await gitExec(repo, ["commit", "-m", "chore: adopt forge flow guard"], {
    FORGE_FLOW_OP: "install",
  });
  if (adopt.exitCode !== 0) throw new Error(`adoption commit failed: ${adopt.stderr}`);
  // Baseline tag on main — the pending commits sit on develop.
  await gitExec(repo, ["tag", "-a", "v0.1.0", "main", "-m", "release v0.1.0"]);
  return repo;
}

describe("flow.cut — ordinary path", () => {
  it("cuts a patch release: branch, versions, gate, main move, tag (AC-1/2/8)", async () => {
    const repo = await adoptedRepo();

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    expect(data.diagnostics).toEqual([]);
    expect(data.released).toBe(true);
    expect(data.tags).toEqual(["v0.1.1"]);
    expect(data.versions["repo"]).toBe("0.1.1");
    const tip = await sha(repo, "develop");
    expect(data.mainTip).toBe(tip);
    expect(await sha(repo, "main")).toBe(tip);
    expect(await sha(repo, "v0.1.1^{}")).toBe(tip);
    // Version file actually written on the released commit.
    const pkg = await gitExec(repo, ["show", "main:package.json"]);
    expect(pkg.stdout).toContain('"version": "0.1.1"');
    // Release commit subject carries the tag.
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout;
    expect(subject.trim()).toBe("chore(release): v0.1.1");
    // Release branch + worktree are gone.
    expect((await gitExec(repo, ["rev-parse", "--verify", "-q", "refs/heads/auto/session-0-1-1-release-0-1-1"])).exitCode).not.toBe(0);
  }, 30_000);

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

  it("resumes the tail when the release commit is integrated but the tag is missing (AC-5)", async () => {
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

  it("refuses FLOW-CUT-01 in an unadopted repository", async () => {
    const repo = await initRepo({ prefix: "flow-cut-" });
    dirs.push(repo);
    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-01");
  });

  it("refuses FLOW-CUT-02 when main carries an unmerged release", async () => {
    const repo = await adoptedRepo();
    // Plumbing-commit main ahead of develop without touching worktrees.
    const tree = (await gitExec(repo, ["rev-parse", "main^{tree}"])).stdout.trim();
    const hot = (await gitExec(repo, ["commit-tree", tree, "-p", "main", "-m", "main-hot"])).stdout.trim();
    await gitExec(repo, ["update-ref", "refs/heads/main", hot]);

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-02");
  });

  it("refuses FLOW-CUT-03 for an unknown package line", async () => {
    const repo = await adoptedRepo();
    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["nope"], dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-03");
  });

  it("refuses FLOW-CUT-04 when nothing is pending", async () => {
    const repo = await adoptedRepo();
    // Tag the current develop tip → zero pending commits.
    await gitExec(repo, ["tag", "-a", "v0.1.0", "-f", "develop", "-m", "release v0.1.0"]);

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-04");
  });

  it("refuses FLOW-CUT-05 on a major bump without ALLOW_MAJOR_BUMP", async () => {
    const repo = await initRepo({ prefix: "flow-cut-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    await writeFile(join(repo, "package.json"), '{ "version": "0.1.0" }\n');
    await mkdir(join(repo, "docs/rfcs"), { recursive: true });
    await writeFile(
      join(repo, "docs/rfcs/rfc-1400-test.md"),
      "---\nid: RFC-1400\ntitle: test\nstatus: accepted\nversionBump: major\n---\n\n# RFC-1400\n",
    );
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "config"]);
    await gitExec(repo, ["tag", "-a", "v0.1.0", "-m", "release v0.1.0"]);
    await gitExec(repo, ["switch", "-c", "develop"]);
    await writeFile(join(repo, "break.txt"), "x");
    await gitExec(repo, ["add", "break.txt"]);
    await gitExec(repo, ["commit", "-m", "breaking", "--trailer", "X-RFC: RFC-1400"]);
    await installGuard(repo);
    await gitExec(repo, ["add", "hooks"]);
    await gitExec(repo, ["commit", "-m", "adopt"], { FORGE_FLOW_OP: "install" });

    const refused = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(refused.diagnostics[0]?.ruleId).toBe("FLOW-CUT-05");

    vi.stubEnv("ALLOW_MAJOR_BUMP", "1");
    const allowed = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(allowed.released).toBe(true);
    expect(allowed.tags).toEqual(["v1.0.0"]);
  }, 30_000);

  it("refuses FLOW-CUT-06 when the target tag already exists", async () => {
    const repo = await adoptedRepo();
    await gitExec(repo, ["tag", "v0.1.1"]);
    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-06");
  });

  it("refuses FLOW-CUT-07 on a dirty primary", async () => {
    const repo = await adoptedRepo();
    await writeFile(join(repo, "dirty.txt"), "uncommitted");
    await gitExec(repo, ["add", "dirty.txt"]);
    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-07");
  });

  it("maps a version-file write failure to FLOW-CUT-11 and removes the release branch", async () => {
    const repo = await initRepo({ prefix: "flow-cut-" });
    dirs.push(repo);
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    // Nested-only version — no top-level key for writeLineVersion.
    await writeFile(join(repo, "package.json"), '{\n  "meta": { "version": "0.1.0" }\n}\n');
    await gitExec(repo, ["add", "-A"]);
    await gitExec(repo, ["commit", "-m", "config"]);
    await gitExec(repo, ["tag", "-a", "v0.1.0", "-m", "release v0.1.0"]);
    await gitExec(repo, ["switch", "-c", "develop"]);
    await commitIn(repo, "work.txt", "work");
    await installGuard(repo);
    await gitExec(repo, ["add", "hooks"]);
    await gitExec(repo, ["commit", "-m", "adopt"], { FORGE_FLOW_OP: "install" });

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-11");
    const branches = (await gitExec(repo, ["branch", "--list", "auto/*"])).stdout.trim();
    expect(branches).toBe("");
  }, 30_000);

  it("dry-run reports the plan without mutating refs or tags", async () => {
    const repo = await adoptedRepo();
    const before = await sha(repo, "develop");
    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: true });
    expect(data.diagnostics).toEqual([]);
    expect(data.released).toBe(false);
    expect(data.tags).toEqual(["v0.1.1"]);
    expect(await sha(repo, "develop")).toBe(before);
    expect((await gitExec(repo, ["rev-parse", "--verify", "-q", "refs/tags/v0.1.1"])).exitCode).not.toBe(0);
  }, 20_000);
});
