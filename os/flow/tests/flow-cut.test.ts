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
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
  <item>RFC-1502: steps 1-5 — release-prepare hook, pre-tag extract verification, ordered steps</item>
  <item>RFC-1546: derive-and-repair recoverable state across flow surfaces (AC-1..AC-5)</item>
  <item>RFC-1597: atomic cut preflight + covers-resume + worktree-bound owner regen (RFC-1597)</item>
  <history>RFC-1490</history>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import type { ForgeRuntimeContext } from "../../../src/types.ts";
import { gitExec, initRepo, installFakeRepoExtract, installGuard } from "./helpers.ts";
import { runFlowCut, runOrdinaryCut } from "../handlers/flow-cut.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { flowWorktreePath } from "../worktree-path.ts";

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

/** Kernel-shaped context for direct runFlowCut calls (dispatch tests). */
function stubContext(repo: string): ForgeRuntimeContext {
  return {
    workspaceRoot: repo,
    logger: { section() {}, info() {}, warn() {}, error() {}, success() {} },
    dryRun: false,
    outputFormat: "json",
    io: ambientIo,
  };
}

/**
 * Adopted repository: governed + develop + committed guard files + baseline
 * tag v0.1.0 + one pending work commit on develop. `packageLine` adds a
 * packages/lib release line (extract.config.yaml + package.json v2.0.0,
 * baseline tag lib@2.0.0, a pending lib-side commit).
 */
async function adoptedRepo(opts?: {
  pending?: boolean;
  packageLine?: boolean;
  /** packageLine only: seed CHANGELOG.md with the predicted [2.0.1] section (RFC-1597). */
  changelog?: boolean;
  /** Extra files committed on develop before the guard install. */
  seedFiles?: Record<string, string>;
}): Promise<string> {
  const repo = await initRepo({ prefix: "flow-cut-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await writeFile(
    join(repo, "package.json"),
    '{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n',
  );
  if (opts?.packageLine) {
    await writeFile(join(repo, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    await mkdir(join(repo, "packages/lib"), { recursive: true });
    await writeFile(
      join(repo, "packages/lib/package.json"),
      '{\n  "name": "lib",\n  "version": "2.0.0"\n}\n',
    );
    await writeFile(join(repo, "packages/lib/extract.config.yaml"), "schema: extract\n");
    if (opts?.changelog !== false) {
      // FLOW-CUT-13 (RFC-1597): the package changelog must carry the predicted
      // section — the pending lib commit bumps patch → [2.0.1].
      await writeFile(
        join(repo, "packages/lib/CHANGELOG.md"),
        "# Changelog\n\n## [2.0.1]\n\n- lib work\n\n## [2.0.0]\n\n- baseline\n",
      );
    }
  }
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "config"]);
  await gitExec(repo, ["switch", "-c", "develop"]);
  if (opts?.pending !== false) {
    await commitIn(repo, "work.txt", "work");
    if (opts?.packageLine) await commitIn(repo, "packages/lib/libfile.txt", "lib work");
  }
  for (const [file, content] of Object.entries(opts?.seedFiles ?? {})) {
    await mkdir(join(repo, file, ".."), { recursive: true });
    await writeFile(join(repo, file), content);
    await gitExec(repo, ["add", file]);
    const r = await gitExec(repo, ["commit", "-m", `seed ${file}`]);
    if (r.exitCode !== 0) throw new Error(`seed commit ${file} failed: ${r.stderr}`);
  }
  await installGuard(repo);
  await gitExec(repo, ["add", "hooks"]);
  const adopt = await gitExec(repo, ["commit", "-m", "chore: adopt forge flow guard"], {
    FORGE_FLOW_OP: "install",
  });
  if (adopt.exitCode !== 0) throw new Error(`adoption commit failed: ${adopt.stderr}`);
  // Baseline tags on main — the pending commits sit on develop.
  await gitExec(repo, ["tag", "-a", "v0.1.0", "main", "-m", "release v0.1.0"]);
  if (opts?.packageLine) {
    await gitExec(repo, ["tag", "-a", "lib@2.0.0", "main", "-m", "release lib@2.0.0"]);
    // The lib line carries extract.config.yaml — RFC-1502's pre-tag verify
    // runs repo-extract on it, so the fixture links the fake binary.
    await installFakeRepoExtract(repo, join(repo, "extract.log"));
  }
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
    expect(data.mainAfter).toBe(tip);
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

  it("cuts repo + package lines together via --lines (AC-1 shape)", async () => {
    const repo = await adoptedRepo({ packageLine: true });

    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });

    expect(data.diagnostics).toEqual([]);
    expect(data.tags).toEqual(["v0.1.1", "lib@2.0.1"]);
    expect(data.lines.map((l) => `${l.line}:${l.version}`)).toEqual(["repo:0.1.1", "lib:2.0.1"]);
    const tip = await sha(repo, "develop");
    expect(await sha(repo, "v0.1.1^{}")).toBe(tip);
    expect(await sha(repo, "lib@2.0.1^{}")).toBe(tip);
    const pkg = await gitExec(repo, ["show", "main:packages/lib/package.json"]);
    expect(pkg.stdout).toContain('"version": "2.0.1"');
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("chore(release): v0.1.1, lib@2.0.1");
  }, 30_000);

  it("refuses FLOW-INT-05 when the integration gate fails, leaving develop untouched", async () => {
    const repo = await adoptedRepo();
    // Untracked hook in the primary — runFlowScript reads it from there.
    await writeFile(join(repo, "hooks/integration-gate.sh"), "#!/bin/sh\nexit 1\n");
    const tipBefore = await sha(repo, "develop");

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    if (data.releaseBranch !== null) dirs.push(flowWorktreePath(repo, data.releaseBranch));

    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-05");
    expect(await sha(repo, "develop")).toBe(tipBefore);
  }, 30_000);

  it("refuses FLOW-CUT-08 on a failing fingerprints hook, then resumes the tail", async () => {
    const repo = await adoptedRepo();
    const hookPath = join(repo, "hooks/release-fingerprints.sh");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");

    const refused = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(refused.released).toBe(false);
    expect(refused.diagnostics[0]?.ruleId).toBe("FLOW-CUT-08");
    // The release commit already integrated — only the tail remains.
    const tip = await sha(repo, "develop");
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("chore(release): v0.1.1");

    await rm(hookPath);
    const resumed = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(resumed.diagnostics).toEqual([]);
    expect(resumed.released).toBe(true);
    expect(resumed.resumed).toBe(true);
    expect(resumed.tags).toEqual(["v0.1.1"]);
    expect(await sha(repo, "v0.1.1^{}")).toBe(tip);
    expect(await sha(repo, "main")).toBe(tip);
  }, 60_000);

  it("refuses FLOW-INT-06 when --branch names a registered non-fix entry", async () => {
    const repo = await adoptedRepo();
    const opened = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "reg-work",
      brief: null,
      owner: null,
      dryRun: false,
    });
    expect(opened.opened).toBe(true);
    dirs.push(opened.worktree!);

    const result = await runFlowCut(
      { argv: [], flags: { branch: opened.branch! } },
      stubContext(repo),
    );
    expect(result.data?.diagnostics[0]?.ruleId).toBe("FLOW-INT-06");
  }, 30_000);
});

describe("flow.cut — resume requires matching --lines (RFC-1546 AC-3)", () => {
  it("a chore(release): tip with mismatched --lines cuts fresh, not a resume", async () => {
    const repo = await adoptedRepo({ packageLine: true });
    // Leave a partial repo-line release as the develop tip (hook fails).
    const hookPath = join(repo, "hooks/release-fingerprints.sh");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    const refused = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(refused.diagnostics[0]?.ruleId).toBe("FLOW-CUT-08");
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("chore(release): v0.1.1");
    await rm(hookPath);
    // Requested set (repo+lib) differs from the tip subject's (repo only) —
    // the tip must not be adopted as a resumable tail.
    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });
    expect(data.resumed).toBe(false);
    expect(data.released).toBe(true);
    expect(data.tags).toContain("lib@2.0.1");
  }, 60_000);
});

describe("flow.cut — consolidated preflight (RFC-1597 AC-1)", () => {
  it("dry-run reports every post-discovery blocker in one payload without mutating", async () => {
    const repo = await adoptedRepo({ packageLine: true, changelog: false });
    const before = await sha(repo, "develop");
    // Third blocker: a dirty primary (tracked change).
    await writeFile(
      join(repo, "package.json"),
      '{\n  "name": "fixture",\n  "version": "0.1.1"\n}\n',
    );

    const data = await runOrdinaryCut(repo, ambientIo, {
      lines: ["lib", "nope"],
      dryRun: true,
    });

    expect(data.released).toBe(false);
    const codes = (data.preflight?.blockers ?? []).map((b) => b.code);
    // Unknown line + missing changelog + dirty primary — collected in ONE
    // report (previously three separate refused release cycles).
    expect(codes).toEqual(["FLOW-CUT-03", "FLOW-CUT-13", "FLOW-CUT-07"]);
    expect(data.preflight?.mode).toBe("refuse");
    expect(data.diagnostics.map((d) => d.ruleId)).toEqual(codes);
    // Per-line report carries the lib row with the predicted version.
    const lib = data.preflight?.lines.find((l) => l.id === "lib");
    expect(lib?.nextVersion).toBe("2.0.1");
    expect(lib?.changelogSection).toBe(false);
    // No mutation: refs and tags are untouched.
    expect(await sha(repo, "develop")).toBe(before);
    expect(
      (await gitExec(repo, ["rev-parse", "--verify", "-q", "refs/tags/v0.1.1"])).exitCode,
    ).not.toBe(0);
  }, 30_000);

  it("the real cut refuses with the same consolidated report", async () => {
    const repo = await adoptedRepo({ packageLine: true, changelog: false });
    const data = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });
    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-13");
    expect(data.preflight?.mode).toBe("refuse");
    expect(data.preflight?.blockers.map((b) => b.code)).toEqual(["FLOW-CUT-13"]);
    // The refusal preceded every mutation — no release branch lingers.
    expect((await gitExec(repo, ["branch", "--list", "auto/*"])).stdout.trim()).toBe("");
  }, 30_000);
});

describe("flow.cut — integrate-lock report (RFC-1597 AC-5)", () => {
  async function holdIntegrateLock(repo: string): Promise<void> {
    await mkdir(join(repo, ".git", "forge"), { recursive: true });
    await writeFile(
      join(repo, ".git", "forge", "integrate.lock"),
      JSON.stringify({ pid: process.pid, host: "test-host", at: new Date().toISOString() }),
    );
  }

  it("dry-run names the live lock holder without waiting", async () => {
    const repo = await adoptedRepo();
    await holdIntegrateLock(repo);
    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: true });
    expect(data.preflight?.lock?.held).toBe(true);
    expect(data.preflight?.lock?.holderPid).toBe(process.pid);
    expect(data.preflight?.lock?.alive).toBe(true);
    // A held lock does not block a clean dry-run plan.
    expect(data.preflight?.mode).toBe("fresh");
  }, 30_000);

  it("the real cut waits within --wait-lock then refuses FLOW-CUT-15 naming the holder", async () => {
    const repo = await adoptedRepo();
    await holdIntegrateLock(repo);
    const data = await runOrdinaryCut(repo, ambientIo, {
      lines: [],
      dryRun: false,
      waitLockSeconds: 0,
    });
    expect(data.released).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-CUT-15");
    expect(data.diagnostics[0]?.message).toContain(`pid ${process.pid}`);
    expect(data.preflight?.lock?.holderPid).toBe(process.pid);
  }, 30_000);
});

describe("flow.cut — primary-side heal fold-or-revert (RFC-1597 AC-3)", () => {
  it("never writes owner-command output into the primary — the regen retargets to the worktree", async () => {
    // A committed generated file makes the manifest an owner in step (3b).
    const repo = await adoptedRepo({
      seedFiles: { "docs/ecosystem.generated.yaml": "generated: 1\n" },
    });
    // Kernel-shaped invoke bound to the primary: under the old contract the
    // owner command would write docs/ecosystem.generated.yaml here as
    // uncommitted collateral (F-0273). The retarget makes this unreachable.
    let wrote = false;
    const invoke = async (commandName: string) => {
      if (commandName === "ecosystem.manifest.generate") {
        wrote = true;
        await writeFile(join(repo, "docs/ecosystem.generated.yaml"), "generated: 2\n");
      }
      return { ok: true as const, exitCode: 0 };
    };

    const data = await runOrdinaryCut(repo, ambientIo, {
      lines: [],
      dryRun: false,
      invoke,
    });

    expect(
      data.diagnostics.map((d) => `${d.ruleId}: ${d.message}`),
      "release diagnostics",
    ).toEqual([]);
    expect(data.released).toBe(true);
    expect(wrote).toBe(false);
    const status = await gitExec(repo, ["status", "--porcelain"]);
    expect(status.stdout.trim()).toBe("");
  }, 60_000);

  it("reverts generated collateral a primary-side hook writes, on every exit path", async () => {
    const repo = await adoptedRepo({
      seedFiles: { "docs/ecosystem.generated.yaml": "generated: 1\n" },
    });
    // The fingerprints hook runs with cwd=primary — collateral it leaves is
    // cut-produced and must be reverted before the command reports.
    await writeFile(
      join(repo, "hooks/release-fingerprints.sh"),
      "#!/bin/sh\necho 'generated: 2' > docs/ecosystem.generated.yaml\necho 'key: value'\n",
    );

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });

    expect(
      data.diagnostics.map((d) => `${d.ruleId}: ${d.message}`),
      "release diagnostics",
    ).toEqual([]);
    expect(data.released).toBe(true);
    expect(data.preflight?.manifestDrift).toContainEqual({
      path: "docs/ecosystem.generated.yaml",
      action: "revert",
    });
    const status = await gitExec(repo, [
      "status",
      "--porcelain",
      "--",
      "docs/ecosystem.generated.yaml",
    ]);
    expect(status.stdout.trim()).toBe("");
    const restored = await gitExec(repo, ["show", "HEAD:docs/ecosystem.generated.yaml"]);
    expect(restored.stdout).toContain("generated: 1");
  }, 60_000);
});

describe("flow.cut — covers-semantics resume (RFC-1597 AC-2)", () => {
  it("same --lines as the tip subject resumes the tail", async () => {
    const repo = await adoptedRepo();
    const hookPath = join(repo, "hooks/release-fingerprints.sh");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    const refused = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(refused.diagnostics[0]?.ruleId).toBe("FLOW-CUT-08");
    await rm(hookPath);

    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.resumed).toBe(true);
    expect(data.released).toBe(true);
    expect(data.tags).toEqual(["v0.1.1"]);
    expect(data.preflight?.mode).toBe("resume");
  }, 60_000);

  it("a subject naming a superset of requested lines still resumes", async () => {
    const repo = await adoptedRepo({ packageLine: true });
    // Land a repo+lib release commit on develop but fail before any tag —
    // the tip subject declares BOTH tags.
    const hookPath = join(repo, "hooks/release-fingerprints.sh");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    const refused = await runOrdinaryCut(repo, ambientIo, { lines: ["lib"], dryRun: false });
    expect(refused.diagnostics[0]?.ruleId).toBe("FLOW-CUT-08");
    const subject = (await gitExec(repo, ["log", "-1", "--format=%s", "develop"])).stdout.trim();
    expect(subject).toBe("chore(release): v0.1.1, lib@2.0.1");
    await rm(hookPath);

    // Request only the repo line — the subject's tag set still covers it.
    const data = await runOrdinaryCut(repo, ambientIo, { lines: [], dryRun: false });
    expect(data.resumed).toBe(true);
    expect(data.released).toBe(true);
    const tip = await sha(repo, "develop");
    expect(await sha(repo, "v0.1.1^{}")).toBe(tip);
    expect(await sha(repo, "lib@2.0.1^{}")).toBe(tip);
  }, 60_000);
});
