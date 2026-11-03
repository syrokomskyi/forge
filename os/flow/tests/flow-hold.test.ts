/*
<MODULE_CONTRACT>
<purpose>flow.hold / flow.unhold tests (RFC-1491, AC-7/8/9): holding item A
replays the tail so develop keeps B's work without A's; the registry holds
an entry with held.tip = A's tip and worktree null; the next digest still
attributes B through journal rewrites; FLOW-HOLD-02 on a local release tag,
FLOW-HOLD-03 on an open branch based above, FLOW-HOLD-07 on a conflicting
replay; unhold recreates the worktree and integrate lands A again; the
48-character held slug truncates correctly.</purpose>
<non-goals>
  <item>No push/publication coverage — flow-push tests own that.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 4 — flow.hold/unhold tests</item>
  <item>RFC-1491: step 4 — flow.hold replay + flow.unhold worktree restore</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1491: digest segments develop by first-parent chain; hold of the topmost item skips the empty replay

Steering-session verification of wave 2 found two outbound defects:
- flow.digest attributed items by index spans over the date-ordered tail; after a fix release and its back-merge, the fix cut record (whose range lives on main) claimed the develop integration that shared its base, so the operator saw 'feat: dev work' labelled as the fix release. Segments now follow develop's first-parent chain and item commit counts come from the base..tip range.
- flow.hold on the item at the tip of develop ran cherry-pick on an empty range and refused FLOW-HOLD-07. An empty tail now resets develop to the item's base.</item>
  <item>RFC-1501: one argv-shaped read-only git allowlist for the recording and read-only adapters (RFC-1501)

READ_ONLY_GIT_QUERIES / isReadOnlyGitQuery replace the recording adapter's
first-argument allowlist; the read-only adapter and the static scan use the same
table. The kernel forwards --dry-run into commands that declare a dry-run flag,
and flow.push / flow.hold dry-runs no longer fetch. The switch-over runbook goes
back to werkstatt run flow.install --dry-run.</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { holdFlowItem, heldBranchName } from "../handlers/flow-hold.ts";
import { unholdFlowBranch } from "../handlers/flow-unhold.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { releaseTagAnnotation, writeReleaseTag } from "../release-tags.ts";
import { commonGitDir, readRegistry } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/** Governed repo with a bare origin — fully pushed, empty tail. */
async function repoWithOrigin(): Promise<{ repo: string; origin: string }> {
  const repo = await initRepo({ prefix: "flow-hold-" });
  dirs.push(repo);
  await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(repo, ["add", "forge.yaml"]);
  await gitExec(repo, ["commit", "-m", "forge.yaml"]);
  await gitExec(repo, ["branch", "develop", "HEAD"]);

  const origin = await mkdtemp(join(tmpdir(), "flow-hold-origin-"));
  dirs.push(origin);
  await gitExec(origin, ["init", "--bare", "-b", "develop", "."]);
  await gitExec(repo, ["remote", "add", "origin", origin]);
  await gitExec(repo, ["switch", "develop"]);
  const push = await gitExec(repo, ["push", "-u", "origin", "develop", "main"]);
  if (push.exitCode !== 0) throw new Error(`initial push failed: ${push.stderr}`);
  return { repo, origin };
}

async function openSession(repo: string, slug: string) {
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
  return data;
}

async function commitIn(worktree: string, file: string, content: string): Promise<void> {
  await writeFile(join(worktree, file), content);
  await gitExec(worktree, ["add", file]);
  const r = await gitExec(worktree, ["commit", "-m", `add ${file}`]);
  if (r.exitCode !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

async function integrate(repo: string, branch: string): Promise<void> {
  const data = await integrateFlowBranch(repo, ambientIo, {
    branch,
    dryRun: false,
    now: NOW,
  });
  expect(data.diagnostics).toEqual([]);
  expect(data.integrated).toBe(true);
}

/** Two integrated branches: A adds a.txt, B adds b.txt — A below B on the tail. */
async function twoIntegrated(repo: string): Promise<{
  a: { branch: string; tip: string };
  b: { branch: string; tip: string };
}> {
  const a = await openSession(repo, "alpha");
  await commitIn(a.worktree!, "a.txt", "a\n");
  const aTip = (await gitExec(a.worktree!, ["rev-parse", "HEAD"])).stdout.trim();
  await integrate(repo, a.branch!);

  const b = await openSession(repo, "beta");
  await commitIn(b.worktree!, "b.txt", "b\n");
  const bTip = (await gitExec(b.worktree!, ["rev-parse", "HEAD"])).stdout.trim();
  await integrate(repo, b.branch!);

  return {
    a: { branch: a.branch!, tip: aTip },
    b: { branch: b.branch!, tip: bTip },
  };
}

async function digestItemFor(repo: string, branch: string) {
  const data = await collectDigest(repo, ambientIo, { fetch: false });
  const item = data.items.find((i) => i.branch === branch);
  expect(item).toBeDefined();
  return item!;
}

describe("flow.hold", () => {
  it("replays the tail without the held item; held branch keeps A's tip (AC-7, AC-8)", async () => {
    const { repo } = await repoWithOrigin();
    const { a, b } = await twoIntegrated(repo);
    const item = await digestItemFor(repo, a.branch);

    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "not ready",
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.held).toBe(true);
    expect(data.branch).toMatch(/^auto\/session-\d{6}-\d{2}-held-alpha$/);

    // AC-7: develop keeps b.txt, loses a.txt.
    const tree = await gitExec(repo, ["ls-tree", "--name-only", "develop"]);
    expect(tree.stdout).toContain("b.txt");
    expect(tree.stdout).not.toContain("a.txt");
    // The held branch still carries A's work.
    expect((await gitExec(repo, ["rev-parse", data.branch!])).stdout.trim()).toBe(a.tip);
    expect((await gitExec(repo, ["cat-file", "-e", `${data.branch}:a.txt`])).exitCode).toBe(0);

    // AC-8: registry entry — held.tip = A's tip, worktree null.
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    const held = registry.branches.find((br) => br.name === data.branch);
    expect(held?.held?.tip).toBe(a.tip);
    expect(held?.held?.reason).toBe("not ready");
    expect(held?.held?.riskCategory).toBe("other");
    expect(held?.worktree).toBeNull();

    // The next digest still attributes B through the journal rewrites.
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    const bItem = after.items.find((i) => i.branch === b.branch);
    expect(bItem).toBeDefined();
    expect(bItem!.kind).toBe("integration");
    // And A is gone from the tail.
    expect(after.items.find((i) => i.branch === a.branch)).toBeUndefined();
    expect(after.held.map((h) => h.branch)).toContain(data.branch);
  }, 90_000);

  it("--dry-run never fetches — remote-tracking refs stay unchanged (RFC-1501)", async () => {
    const { repo, origin } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    const item = await digestItemFor(repo, a.branch);
    // origin gains a commit after the repository's last fetch.
    const other = await mkdtemp(join(tmpdir(), "flow-hold-other-"));
    dirs.push(other);
    expect((await gitExec(other, ["clone", "-q", "-b", "develop", origin, "."])).exitCode).toBe(0);
    await gitExec(other, ["config", "user.email", "flow-test@example.invalid"]);
    await gitExec(other, ["config", "user.name", "flow-test"]);
    await commitIn(other, "foreign.txt", "f\n");
    expect((await gitExec(other, ["push", "-q", "origin", "develop"])).exitCode).toBe(0);

    const tracking = async () =>
      (await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]))
        .stdout;
    const before = await tracking();
    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "dry-run probe",
      dryRun: true,
      now: NOW,
    });
    expect(data.diagnostics).toEqual([]);
    expect(await tracking()).toBe(before);
  });

  it("holds the topmost item — empty tail above it — by resetting develop to its base", async () => {
    const { repo } = await repoWithOrigin();
    const { b } = await twoIntegrated(repo);
    const item = await digestItemFor(repo, b.branch);

    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "top of the tail",
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.held).toBe(true);
    expect(data.rewrites).toEqual([]);
    expect((await gitExec(repo, ["rev-parse", "develop"])).stdout.trim()).toBe(item.base);
    expect((await gitExec(repo, ["rev-parse", data.branch!])).stdout.trim()).toBe(b.tip);
  }, 90_000);

  it("refuses FLOW-HOLD-02 when a local release tag sits above the item (AC-9)", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    await writeReleaseTag(repo, ambientIo, {
      name: "v0.2.0",
      target: tip,
      annotation: releaseTagAnnotation({
        tag: "v0.2.0",
        line: "repo",
        version: "0.2.0",
        level: "minor",
        previous: "v0.1.0",
        rfcs: [],
        fingerprints: {},
      }),
    });

    const item = await digestItemFor(repo, a.branch);
    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "late",
      dryRun: false,
      now: NOW,
    });
    expect(data.held).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-02");
    expect(data.diagnostics[0]?.message).toContain("v0.2.0");
  }, 90_000);

  it("refuses FLOW-HOLD-03 while an open branch is based above the item", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    // Session C opens now — its baseSha is the current develop tip, above A's base.
    const c = await openSession(repo, "gamma");
    const item = await digestItemFor(repo, a.branch);
    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "late",
      dryRun: false,
      now: NOW,
    });
    expect(data.held).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-03");
    expect(data.diagnostics[0]?.message).toContain(c.branch);
  }, 90_000);

  it("refuses FLOW-HOLD-07 on a replay conflict — tree and refs unchanged", async () => {
    const { repo } = await repoWithOrigin();
    // A creates a.txt; B edits the same file — B cannot apply without A.
    const a = await openSession(repo, "alpha");
    await commitIn(a.worktree!, "a.txt", "from A\n");
    const aTip = (await gitExec(a.worktree!, ["rev-parse", "HEAD"])).stdout.trim();
    await integrate(repo, a.branch!);

    const b = await openSession(repo, "beta");
    await commitIn(b.worktree!, "a.txt", "from B — needs A\n");
    await integrate(repo, b.branch!);

    const developBefore = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    const item = await digestItemFor(repo, a.branch!);
    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "conflict probe",
      dryRun: false,
      now: NOW,
    });
    expect(data.held).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-07");
    expect(data.diagnostics[0]?.message).toContain("a.txt");

    // Nothing moved — develop, the branches and the tree are unchanged.
    expect((await gitExec(repo, ["rev-parse", "develop"])).stdout.trim()).toBe(developBefore);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:a.txt"])).exitCode).toBe(0);
    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    expect(registry.branches.every((br) => br.held === null)).toBe(true);
    expect(await gitExec(repo, ["worktree", "list"])).toMatchObject({ exitCode: 0 });
    expect((await gitExec(repo, ["worktree", "list"])).stdout).not.toContain("hold-worktree");
    void aTip;
  }, 90_000);

  it("refuses FLOW-HOLD-04 while the primary checkout is dirty", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    // A tracked modification — `reset --keep` refuses on it, so HOLD-04 does.
    await writeFile(join(repo, "forge.yaml"), 'schema: "forge/workspace@1"\ndirty: true\n');

    const item = await digestItemFor(repo, a.branch);
    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "dirty probe",
      dryRun: false,
      now: NOW,
    });
    expect(data.held).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-04");
  }, 90_000);

  it("refuses FLOW-HOLD-05 on an unattributed item", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    // A direct develop commit has no journal record — unattributed tail.
    await writeFile(join(repo, "loose.txt"), "loose\n");
    await gitExec(repo, ["add", "loose.txt"]);
    await gitExec(repo, ["commit", "-m", "unattributed"]);

    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const unattributed = digest.items.find((i) => i.kind === "unattributed");
    expect(unattributed).toBeDefined();
    const data = await holdFlowItem(repo, ambientIo, {
      item: unattributed!.id,
      reason: "kind probe",
      dryRun: false,
      now: NOW,
    });
    expect(data.held).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-05");
    void a;
  }, 90_000);

  it("refuses FLOW-HOLD-06 while a merge commit sits above the item", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    // A merge commit on develop above B — replay cannot reorder it.
    await gitExec(repo, ["switch", "-c", "tmp-merge", "develop~1"]);
    await writeFile(join(repo, "merge-side.txt"), "side\n");
    await gitExec(repo, ["add", "merge-side.txt"]);
    await gitExec(repo, ["commit", "-m", "merge side"]);
    await gitExec(repo, ["switch", "develop"]);
    await gitExec(repo, ["merge", "--no-ff", "-m", "merge tmp", "tmp-merge"]);

    const item = await digestItemFor(repo, a.branch);
    const data = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "merge probe",
      dryRun: false,
      now: NOW,
    });
    expect(data.held).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-06");
  }, 90_000);

  it("integrate on a held branch refuses FLOW-INT-11", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    const item = await digestItemFor(repo, a.branch);
    const held = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "pause",
      dryRun: false,
      now: NOW,
    });
    expect(held.held).toBe(true);

    const integrated = await integrateFlowBranch(repo, ambientIo, {
      branch: held.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(integrated.integrated).toBe(false);
    expect(integrated.diagnostics[0]?.ruleId).toBe("FLOW-INT-11");
    expect(integrated.diagnostics[0]?.message).toContain("pause");
  }, 120_000);

  it("unhold recreates the worktree and integrate lands A again", async () => {
    const { repo } = await repoWithOrigin();
    const { a } = await twoIntegrated(repo);
    const item = await digestItemFor(repo, a.branch);
    const held = await holdFlowItem(repo, ambientIo, {
      item: item.id,
      reason: "pause",
      dryRun: false,
      now: NOW,
    });
    expect(held.held).toBe(true);

    const unheld = await unholdFlowBranch(repo, ambientIo, {
      branch: held.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(unheld.diagnostics).toEqual([]);
    expect(unheld.unheld).toBe(true);
    expect(unheld.worktree).not.toBeNull();
    dirs.push(unheld.worktree!);

    const common = await commonGitDir(ambientIo, repo);
    const registry = await readRegistry(ambientIo, common);
    const entry = registry.branches.find((br) => br.name === held.branch);
    expect(entry?.held).toBeNull();
    expect(entry?.worktree).toBe(unheld.worktree);

    // Integrating the unheld branch brings a.txt back.
    const integrated = await integrateFlowBranch(repo, ambientIo, {
      branch: held.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(integrated.diagnostics).toEqual([]);
    expect(integrated.integrated).toBe(true);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:a.txt"])).exitCode).toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:b.txt"])).exitCode).toBe(0);
  }, 120_000);

  it("refuses FLOW-HOLD-08 on an unheld or unknown branch", async () => {
    const { repo } = await repoWithOrigin();
    const a = await openSession(repo, "alpha");
    const unheld = await unholdFlowBranch(repo, ambientIo, {
      branch: a.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(unheld.unheld).toBe(false);
    expect(unheld.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-08");

    const missing = await unholdFlowBranch(repo, ambientIo, {
      branch: "auto/session-260101-99-nope",
      dryRun: false,
      now: NOW,
    });
    expect(missing.diagnostics[0]?.ruleId).toBe("FLOW-HOLD-08");
  }, 60_000);

  it("heldBranchName truncates a 48-char slug to held-<43> and drops a dangling dash", async () => {
    const slug48 = "a".repeat(48);
    const name = heldBranchName(
      `auto/session-261102-03-${slug48}`,
      [],
      NOW,
    );
    expect(name).toBe(`auto/session-261102-01-held-${"a".repeat(43)}`);
    const parsed = (await import("../branch-name.ts")).parseFlowBranch(name!);
    expect(parsed?.slug).toHaveLength(48);

    const slugDash = `${"b".repeat(42)}-tail`; // char 43 is '-'
    expect(slugDash[42]).toBe("-");
    const dashed = heldBranchName(`auto/task-261102-02-${slugDash}`, [], NOW);
    expect(dashed).toBe(`auto/task-261102-01-held-${"b".repeat(42)}`);
  });
});
