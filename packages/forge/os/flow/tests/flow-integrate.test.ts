/*
<MODULE_CONTRACT>
<purpose>flow.integrate tests (RFC-1487 step 4, AC-3/4/5): a clean registered
branch lands on develop as a linear fast-forward with no merge commit,
rebase conflicts refuse FLOW-INT-02 leaving develop untouched, the primary's
gate script (not the branch's) refuses FLOW-INT-05, a dirty primary refuses
FLOW-INT-03 after the rebase, an unregistered branch refuses FLOW-INT-06,
and a held integration lock is waited out.</purpose>
<non-goals>
  <item>No discard/status coverage — separate files.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1598: refuse-before-staging index guard + checked-out-side generated-conflict resolver (RFC-1598)</item>
  <item>RFC-1600: require declaration context in the integrate dup-id scan and resolve real friction ids (F-0286)</item>
  <item>RFC-1600: ignore generated projections in the FLOW-INT-19 duplicate-id scan</item>
  <item>RFC-1600: keep FLOW-INT-19 fixture ids outside the live rule range (RFC-1600)</item>
  <item>RFC-1616: close RFC-1616 r3 trust-boundary counterexamples</item>
  <history>ADR-0128, RFC-1487, RFC-1515, RFC-1528, RFC-1537, RFC-1538, RFC-1543, RFC-1544, RFC-1545, RFC-1546, RFC-1574, RFC-1597, RFC-1599, RFC-1600</history>
</CHANGE_SUMMARY>
*/

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { collectFlowStatus } from "../handlers/flow-status.ts";
import { commonGitDir, INTEGRATE_LOCK_RELATIVE_PATH, readJournal } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-int-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  await gitExec(dir, ["switch", "develop"]);
  return dir;
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
  if (r.exitCode !== 0) throw new Error(`commit in ${worktree} failed: ${r.stderr}`);
}

async function sha(repo: string, ref: string): Promise<string> {
  return (await gitExec(repo, ["rev-parse", ref])).stdout.trim();
}

describe("flow.integrate", () => {
  it("fast-forwards develop with no merge commit (AC-3)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "alpha");
    await commitIn(session.worktree!, "a.txt", "a");
    await commitIn(session.worktree!, "b.txt", "b");
    await commitIn(repo, "c.txt", "c"); // develop moves ahead
    const developBefore = await sha(repo, "develop");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.rebased).toBe(true);
    expect(data.cleanedUp).toBe(true);
    const merges = await gitExec(repo, ["rev-list", "--merges", `${developBefore}..develop`]);
    expect(merges.stdout.trim()).toBe("");
    expect((await gitExec(repo, ["cat-file", "-e", "develop:a.txt"])).exitCode).toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:c.txt"])).exitCode).toBe(0);
    expect(
      (await gitExec(repo, ["rev-parse", "--verify", `refs/heads/${session.branch}`])).exitCode,
    ).not.toBe(0);
  }, 20_000);

  it("refuses FLOW-INT-02 on a rebase conflict and leaves both refs unchanged (AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "conflict");
    await commitIn(session.worktree!, "seed.txt", "session-edit\n");
    const branchTip = await sha(repo, session.branch!);
    await commitIn(repo, "seed.txt", "develop-edit\n");
    const developSha = await sha(repo, "develop");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    expect(data.diagnostics[0]?.message).toContain("seed.txt");
    expect(data.integrated).toBe(false);
    expect(await sha(repo, "develop")).toBe(developSha);
    expect(await sha(repo, session.branch!)).toBe(branchTip);
    // rebase aborted — the session worktree is back to a clean branch tip.
    const wt = await gitExec(session.worktree!, ["status", "--porcelain"]);
    expect(wt.stdout.trim()).toBe("");
  }, 20_000);

  it("names the cause when the rebase fails without unmerged paths (ADR-0128, F-0188)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "blocked");
    // the session branch needs a unique commit so the integrate actually
    // reaches the rebase stage; without it the branch fast-forwards trivially.
    await commitIn(session.worktree!, "session.txt", "session work\n");
    // develop-only path whose worktree twin is tolerated dirt — the dirty
    // preflight lets it through (FORGE_STATE_FILES) but the rebase checkout
    // refuses on it before any unmerged path exists.
    await mkdir(join(repo, ".forge"), { recursive: true });
    await commitIn(repo, ".forge/knowledge-conflicts.txt", "develop content\n");
    await mkdir(join(session.worktree!, ".forge"), { recursive: true });
    await writeFile(
      join(session.worktree!, ".forge/knowledge-conflicts.txt"),
      "session-local state\n",
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    const message = data.diagnostics[0]?.message ?? "";
    expect(message).toContain("failed without unmerged paths");
    expect(message).toContain("knowledge-conflicts.txt");
    expect(data.diagnostics[0]?.fixHint).toContain("clean the listed worktree state");
    const details = (data.diagnostics[0] as { data?: Record<string, unknown> }).data;
    expect(details?.conflictedPaths).toEqual([]);
    expect((details?.rebaseStderrTail as string[]).join("\n")).toContain("knowledge-conflicts.txt");
    expect((details?.statusPorcelain as string[]).join("\n")).toContain(".forge/");
  }, 20_000);

  it("caps the conflicted path list at 20 and reports the remainder (ADR-0128, F-0188)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "many");
    // 22 files conflict in ONE commit each side — the rebase stops with all
    // of them unmerged at once.
    for (let i = 0; i < 22; i++) {
      await writeFile(join(session.worktree!, `f${String(i).padStart(2, "0")}.txt`), "session\n");
    }
    await gitExec(session.worktree!, ["add", "."]);
    await gitExec(session.worktree!, ["commit", "-m", "session adds 22 files"]);
    for (let i = 0; i < 22; i++) {
      await writeFile(join(repo, `f${String(i).padStart(2, "0")}.txt`), "develop\n");
    }
    await gitExec(repo, ["add", "."]);
    await gitExec(repo, ["commit", "-m", "develop edits 22 files"]);

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    const message = data.diagnostics[0]?.message ?? "";
    expect(message).toContain("(+2 more)");
    expect(message).not.toContain("f21.txt");
    const details = (data.diagnostics[0] as { data?: Record<string, unknown> }).data;
    expect((details?.conflictedPaths as string[]).length).toBe(22);
  }, 20_000);

  it("refuses FLOW-INT-05 when the primary gate fails though the branch's copy passes (AC-5)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "gate");
    // the branch writes its own permissive gate — develop's version gates.
    await mkdir(join(session.worktree!, "hooks"), { recursive: true });
    await commitIn(session.worktree!, "hooks/integration-gate.sh", "#!/bin/sh\nexit 0\n");
    await mkdir(join(repo, "hooks"), { recursive: true });
    await writeFile(
      join(repo, "hooks", "integration-gate.sh"),
      "#!/bin/sh\necho gated >&2\nexit 1\n",
    );
    const developSha = await sha(repo, "develop");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-05");
    expect(data.integrated).toBe(false);
    expect(await sha(repo, "develop")).toBe(developSha);
  }, 20_000);

  it("refuses FLOW-INT-03 before the rebase when the primary is dirty", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "dirty-primary");
    await commitIn(session.worktree!, "x.txt", "x");
    await commitIn(repo, "y.txt", "y");
    const developSha = await sha(repo, "develop");
    await writeFile(join(repo, "seed.txt"), "dirty\n"); // tracked modification in primary

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    // RFC-1528: the preflight's early primary check refuses before the rebase.
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-03");
    expect(data.rebased).toBe(false);
    expect(await sha(repo, "develop")).toBe(developSha);
    await gitExec(repo, ["checkout", "--", "seed.txt"]);
  }, 20_000);

  it("refuses FLOW-INT-01 on an untracked-only session worktree — the dirty check matches `git worktree remove`", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "untracked");
    await commitIn(session.worktree!, "u.txt", "u");
    await writeFile(join(session.worktree!, "scratch.log"), "scratch\n");
    const developSha = await sha(repo, "develop");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-01");
    expect(data.integrated).toBe(false);
    expect(await sha(repo, "develop")).toBe(developSha);
    await rm(join(session.worktree!, "scratch.log"));
  }, 20_000);

  it("refuses FLOW-INT-06 on an unregistered branch", async () => {
    const repo = await governedRepo();
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: "auto/session-261102-01-ghost",
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-06");
  }, 15_000);

  it("waits for a held integration lock and completes after release", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "waiter");
    await commitIn(session.worktree!, "w.txt", "w");
    const common = await commonGitDir(ambientIo, repo);
    const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);
    await mkdir(join(common, "forge"), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, host: "test", at: new Date().toISOString() }),
    );

    const progress: string[] = [];
    const result = integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      onProgress: (m) => progress.push(m),
    });
    await new Promise((r) => setTimeout(r, 600));
    await rm(lockPath, { force: true });
    const data = await result;
    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:w.txt"])).exitCode).toBe(0);
  }, 20_000);
});

describe("flow.integrate — RFC-1515 lifecycle hardening", () => {
  it("tolerates FORGE_STATE_FILES-only untracked state — journaled, never FLOW-INT-01 (AC-2)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "tolerated");
    await commitIn(session.worktree!, "t.txt", "t");
    await mkdir(join(session.worktree!, ".forge", "task"), { recursive: true });
    await writeFile(join(session.worktree!, ".forge", "knowledge-conflicts.txt"), "conflict\n");
    await writeFile(join(session.worktree!, ".forge", "task", "notes.md"), "n\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.toleratedState).toEqual(
      expect.arrayContaining([".forge/knowledge-conflicts.txt", ".forge/task/notes.md"]),
    );
    expect(data.integrated).toBe(true);
    // The tolerated paths are declared-disposable: cleanup deleted them so
    // `git worktree remove` could complete — no FLOW-INT-04 wedge.
    expect(data.cleanedUp).toBe(true);
    expect(await ambientIo.exists(session.worktree!)).toBe(false);
    expect((await gitExec(repo, ["rev-parse", "--verify", session.branch!])).exitCode).not.toBe(0);
  }, 20_000);

  it("still refuses FLOW-INT-01 on non-allowlisted untracked paths — including other .forge entries (AC-7)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "mixed-dirt");
    await commitIn(session.worktree!, "u.txt", "u");
    await mkdir(join(session.worktree!, ".forge"), { recursive: true });
    await writeFile(join(session.worktree!, ".forge", "knowledge-conflicts.txt"), "conflict\n");
    await writeFile(join(session.worktree!, ".forge", "other-state.yaml"), "s\n");
    await writeFile(join(session.worktree!, "scratch.log"), "scratch\n");
    const developSha = await sha(repo, "develop");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    const diag = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-01");
    expect(diag).toBeDefined();
    expect(diag?.message).toContain("scratch.log");
    expect(diag?.message).toContain("other-state.yaml");
    // The allowlisted path is journal data on the diagnostic — never a
    // suppressed blocker and never inside entries[].
    expect(diag?.data?.["toleratedState"]).toEqual([".forge/knowledge-conflicts.txt"]);
    expect(diag?.message).toContain("tolerated forge-local state: .forge/knowledge-conflicts.txt");
    expect(data.integrated).toBe(false);
    expect(await sha(repo, "develop")).toBe(developSha);
  }, 20_000);

  it("journals every refusal as integrate-refusal {branch, rule, summary, at} — flow.status exposes lastRefusal/orphaned (RFC-1537 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "refused");
    await commitIn(session.worktree!, "k.txt", "k");
    await writeFile(join(session.worktree!, "scratch.log"), "scratch\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-01");

    const common = await commonGitDir(ambientIo, repo);
    const journal = await readJournal(ambientIo, common);
    const refusal = [...journal]
      .reverse()
      .find((e) => e.event === "integrate-refusal" && e.branch === session.branch);
    expect(refusal).toBeDefined();
    expect(refusal?.rule).toBe("FLOW-INT-01");
    expect(refusal?.sha).toBe(await sha(repo, session.branch!));
    expect(refusal?.detail).toContain("scratch.log");
    expect(refusal?.at).toBeDefined();

    const status = await collectFlowStatus(repo, ambientIo);
    const b = status.data.branches.find((x) => x.name === session.branch);
    expect(b?.orphaned).toBe(true);
    expect(b?.lastRefusal?.rule).toBe("FLOW-INT-01");
    expect(b?.lastRefusal?.summary).toContain("scratch.log");
  }, 20_000);

  it("a later non-refusal event clears orphaned while lastRefusal stays (RFC-1537)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "later");
    await commitIn(session.worktree!, "k.txt", "k");
    await writeFile(join(session.worktree!, "scratch.log"), "scratch\n");
    await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    const common = await commonGitDir(ambientIo, repo);
    await (
      await import("../registry.ts")
    ).appendJournal(ambientIo, common, {
      event: "hold",
      branch: session.branch!,
      sha: await sha(repo, session.branch!),
      detail: "held",
    });

    const status = await collectFlowStatus(repo, ambientIo);
    const b = status.data.branches.find((x) => x.name === session.branch);
    expect(b?.orphaned).toBe(false);
    expect(b?.lastRefusal?.rule).toBe("FLOW-INT-01");
  }, 20_000);

  it("a held-lock refusal carries the holder payload — pid, host, at, heldMs, disposition (AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "locked");
    await commitIn(session.worktree!, "w.txt", "w");
    const common = await commonGitDir(ambientIo, repo);
    const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);
    await mkdir(join(common, "forge"), { recursive: true });
    const at = new Date().toISOString();
    // A live holder on this host — pid is this process so holderIsDead
    // reports live and the wait budget must elapse to refuse.
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at }));

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      lockWaitMs: 300,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-08");
    expect(data.lock).toMatchObject({
      pid: process.pid,
      host: hostname(),
      at,
      disposition: "live",
    });
    expect(typeof data.lock?.heldMs).toBe("number");
    expect(data.integrated).toBe(false);
    await rm(lockPath, { force: true });
  }, 20_000);

  it("a vanished worktree with an unmerged branch still refuses — with the vanished classification and the flow.discard hint (AC-6)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "ghost");
    await commitIn(session.worktree!, "gone.txt", "gone");
    await rm(session.worktree!, { recursive: true, force: true });

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-15");
    expect(data.diagnostics[0]?.message).toContain("vanished");
    expect(data.diagnostics[0]?.data?.["vanished"]).toBe(true);
    expect(data.diagnostics[0]?.fixHint).toContain("flow.discard");
  }, 20_000);

  it("a dry-run classify a vanished worktree without touching it — same FLOW-07 shape (RFC-1515)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "ghost-dry");
    await commitIn(session.worktree!, "gone.txt", "gone");
    await rm(session.worktree!, { recursive: true, force: true });

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: true,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-07");
    expect(data.diagnostics[0]?.data?.["vanished"]).toBe(true);
    expect(data.diagnostics[0]?.fixHint).toContain("flow.discard");
  }, 20_000);

  it("a held-lock refusal with an unreadable holder file reports holder unknown (RFC-1515 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "unknown-holder");
    await commitIn(session.worktree!, "w.txt", "w");
    const common = await commonGitDir(ambientIo, repo);
    const lockPath = join(common, INTEGRATE_LOCK_RELATIVE_PATH);
    await mkdir(join(common, "forge"), { recursive: true });
    await writeFile(lockPath, "not-json{{");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      lockWaitMs: 300,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-08");
    expect(data.diagnostics[0]?.message).toContain("holder unknown");
    expect(data.lock).toBeUndefined();
    expect(data.integrated).toBe(false);
    await rm(lockPath, { force: true });
  }, 20_000);
});

describe("flow.integrate — RFC-1538 post-lock revalidation, session engine, auto-resolve", () => {
  it("a second integrate on an already-integrated branch exits idempotently (AC-1/AC-5)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "again");
    await commitIn(session.worktree!, "a.txt", "a");

    const first = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(first.integrated).toBe(true);

    const second = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(second.disposition).toBe("already-integrated");
    expect(second.integrated).toBe(true);
    expect(second.diagnostics).toEqual([]);
    expect(second.cleanedUp).toBe(true);
    expect(await ambientIo.exists(session.worktree!)).toBe(false);
  }, 20_000);

  it("an unregistered branch never contained still refuses FLOW-INT-06", async () => {
    const repo = await governedRepo();
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: "auto/session-261108-99-never",
      dryRun: false,
      now: NOW,
    });
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-06");
    expect(data.disposition).toBeUndefined();
  }, 20_000);

  it("an unregistered branch fully contained in develop reports already-integrated — nothing to do", async () => {
    const repo = await governedRepo();
    await gitExec(repo, ["branch", "auto/session-261108-99-merged"]);
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: "auto/session-261108-99-merged",
      dryRun: false,
      now: NOW,
    });
    expect(data.disposition).toBe("already-integrated");
    expect(data.integrated).toBe(true);
    expect(data.diagnostics).toEqual([]);
  }, 20_000);

  it("the gate binds the session engine build when the worktree has node_modules (AC-2)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "engine");
    await commitIn(session.worktree!, "e.txt", "e");
    await mkdir(join(session.worktree!, "node_modules"), { recursive: true });

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });
    expect(data.integrated).toBe(true);
    expect(data.gateEngine).toBe("session");
  }, 20_000);

  it("a generated-only conflict auto-resolves via the owner command and lands (AC-3)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "genconf");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    const sessionIndex = "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n";
    const developIndex = "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n";
    await commitIn(session.worktree!, "docs/rfcs/index.yaml", sessionIndex);
    await commitIn(repo, "docs/rfcs/index.yaml", developIndex);

    const resolved = "command: rfc.index.generate\ngeneratedAt: 2026-11-09\ncount: 10\n";
    const invoked: string[] = [];
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      // RFC-1598: the generator port binds to the checked-out conflict side
      // the resolver materializes — the stub writes there, never into the
      // mixed mid-rebase worktree (F-0243).
      sideInvoke: (sideDir) => async (name, flags) => {
        invoked.push(`${name} ${JSON.stringify(flags ?? {})}`);
        await writeFile(join(sideDir, "docs/rfcs/index.yaml"), resolved);
        return { ok: true, exitCode: 0 };
      },
    });

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.autoResolved).toEqual(["docs/rfcs/index.yaml"]);
    expect(invoked).toEqual(['rfc.index.generate {"write":true}']);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:docs/rfcs/index.yaml"])).exitCode).toBe(
      0,
    );
  }, 20_000);

  it("a generated-only conflict without an invoke port engages the standalone adapter — spawn failure escalates FLOW-INT-02 (RFC-1545 AC-2/AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "standalone");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n",
    );
    await commitIn(
      repo,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n",
    );

    // No invoke port — the adapter spawns `pnpm exec werkstatt run …` in the
    // bare fixture worktree where no werkstatt binary resolves; the failure
    // escalates as FLOW-INT-02, proving the standalone path engaged.
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    expect(data.diagnostics[0]?.message).toContain("auto-resolve of generated conflict");
  }, 20_000);

  it("a failing generator escalates to FLOW-INT-02 with its stderr in diagnostics (RFC-1545 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "genfail");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n",
    );
    await commitIn(
      repo,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n",
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      sideInvoke: () => async () => ({
        ok: false,
        exitCode: 1,
        summary: "rfc.index.generate crashed: schema error at docs/rfcs/rfc-0001.md",
      }),
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    expect(data.diagnostics[0]?.message).toContain("auto-resolve of generated conflict");
    expect(data.diagnostics[0]?.message).toContain("schema error");
  }, 20_000);

  it("a generator that leaves residual conflict markers escalates to FLOW-INT-02 (RFC-1545 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "genmarkers");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n",
    );
    await commitIn(
      repo,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n",
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      sideInvoke: (sideDir) => async () => {
        // A "successful" regen that writes marker-laden output must not land.
        await writeFile(
          join(sideDir, "docs/rfcs/index.yaml"),
          "command: rfc.index.generate\n<<<<<<< HEAD\ncount: 9\n=======\ncount: 2\n>>>>>>> branch\n",
        );
        return { ok: true, exitCode: 0 };
      },
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    expect(data.diagnostics[0]?.message).toContain("conflict markers");
  }, 20_000);

  it("the auto-resolve generator runs inside a checked-out side, never the mixed mid-rebase index (RFC-1598 F-0243)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "sidegen");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n",
    );
    await commitIn(
      repo,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n",
    );

    const sideDirs: string[] = [];
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      // A generator whose output derives from the tree it runs in — the
      // F-0243 class. It reads the conflicting file's bytes on the side it
      // was invoked against and emits derived output; on the mixed
      // mid-rebase index it would see neither coherent side.
      sideInvoke: (sideDir) => async () => {
        sideDirs.push(sideDir);
        const base = await readFile(join(sideDir, "docs/rfcs/index.yaml"));
        await writeFile(join(sideDir, "docs/rfcs/index.yaml"), `${base}resolvedOn: side\n`);
        return { ok: true, exitCode: 0 };
      },
    });

    expect(data.integrated).toBe(true);
    expect(data.autoResolved).toEqual(["docs/rfcs/index.yaml"]);
    expect(data.autoResolveDeferred).toBeUndefined();
    // The generator ran in a checked-out side, not the mid-rebase worktree.
    expect(sideDirs.length).toBeGreaterThan(0);
    expect(sideDirs[0]).not.toBe(session.worktree);
    // `theirs` is preferred — the derived output carries the session side.
    const blob = await gitExec(repo, ["show", "develop:docs/rfcs/index.yaml"]);
    expect(blob.stdout).toContain("count: 2");
    expect(blob.stdout).toContain("resolvedOn: side");
  }, 20_000);

  it("when no conflict side can be checked out, auto-resolve takes theirs and defers to the post-rebase fold (RFC-1598 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "defer");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n",
    );
    await commitIn(
      repo,
      "docs/rfcs/index.yaml",
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n",
    );

    // A session-PATH shim refuses `git worktree add` only — neither side
    // can be checked out, so the resolver falls to take-theirs + deferral.
    // `worktree add` is a write and rides the io.exec channel (session env:
    // credentials/hooks) — the injected failure must live on PATH, not the
    // resolved verifier binary.
    const guardDir = await mkdtemp(join(tmpdir(), "git-sideguard-"));
    await writeFile(
      join(guardDir, "git"),
      [
        "#!/bin/sh",
        "sub1=; sub2=; prev=",
        'for a in "$@"; do',
        '  case "$prev" in -C|-c|--git-dir|--work-tree|--namespace) prev=; continue;; esac',
        '  case "$a" in -C|-c|--git-dir|--work-tree|--namespace) prev="$a"; continue;; -*) continue;; *) [ -z "$sub1" ] && sub1="$a" || sub2="$a"; [ -n "$sub2" ] && break;; esac',
        "done",
        '[ "$sub1" = "worktree" ] && [ "$sub2" = "add" ] && { echo "worktree add refused by test shim" >&2; exit 1; }',
        'exec /usr/bin/git "$@"',
        "",
      ].join("\n"),
    );
    await chmod(join(guardDir, "git"), 0o755);
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${guardDir}:${savedPath ?? ""}`;
    let data: Awaited<ReturnType<typeof integrateFlowBranch>>;
    try {
      data = await integrateFlowBranch(repo, ambientIo, {
        branch: session.branch!,
        dryRun: false,
        now: NOW,
        sideInvoke: () => async () => {
          throw new Error("sideInvoke must never run — no side was checkable");
        },
      });
    } finally {
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
    }

    expect(data.integrated).toBe(true);
    expect(data.autoResolved).toEqual(["docs/rfcs/index.yaml"]);
    expect(data.autoResolveDeferred).toEqual(["docs/rfcs/index.yaml"]);
    // take-theirs staged the stage-3 blob — develop carries the session side.
    const blob = await gitExec(repo, ["show", "develop:docs/rfcs/index.yaml"]);
    expect(blob.stdout).toContain("count: 2");
  }, 20_000);

  it("primary dirt held only by a live foreign claim waits, then refuses FLOW-INT-03 naming the holder (RFC-1543 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "foreign");
    await commitIn(session.worktree!, "f.txt", "f");
    await commitIn(repo, "claimed.txt", "base");
    // A live foreign op claims the file it is about to dirty on primary.
    const { claimOp } = await import("../ops-registry.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await claimOp(repo, ambientIo, {
      opId: "ship-001",
      command: "leitstand.ship",
      workspaceRoot: repo,
      paths: ["claimed.txt"],
    });
    await wf(join(repo, "claimed.txt"), "dirty-in-flight");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      waitForeignSeconds: 1,
    });

    expect(data.integrated).toBe(false);
    const diag = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-03");
    expect(diag).toBeDefined();
    expect(diag?.message).toContain("leitstand.ship ship-001");
    expect((diag?.data?.["foreignHolders"] as { opId: string }[] | undefined)?.[0]?.opId).toBe(
      "ship-001",
    );
  }, 30_000);

  it("foreign-held primary dirt clears mid-wait and the integration proceeds (RFC-1543 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "foreign2");
    await commitIn(session.worktree!, "f2.txt", "f2");
    await commitIn(repo, "claimed.txt", "base");
    const { claimOp, releaseOp } = await import("../ops-registry.ts");
    const { writeFile: wf } = await import("node:fs/promises");
    await claimOp(repo, ambientIo, {
      opId: "ship-002",
      command: "leitstand.ship",
      workspaceRoot: repo,
      paths: ["claimed.txt"],
    });
    await wf(join(repo, "claimed.txt"), "dirty-in-flight");

    // The foreign op finishes mid-wait: claim released, dirt committed away.
    const clearer = setTimeout(() => {
      void (async () => {
        await releaseOp(repo, ambientIo, "ship-002");
        await wf(join(repo, "claimed.txt"), "committed-away");
        await gitExec(repo, ["add", "claimed.txt"]);
        await gitExec(repo, ["commit", "-m", "foreign op lands its write"]);
      })();
    }, 1200);

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      waitForeignSeconds: 8,
    });
    clearTimeout(clearer);

    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
  }, 30_000);

  it("a mixed generated/non-generated conflict set still refuses FLOW-INT-02 (AC-3 boundary)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "mixed");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    const sessionIndex = "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n";
    const developIndex = "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n";
    await commitIn(session.worktree!, "docs/rfcs/index.yaml", sessionIndex);
    await commitIn(session.worktree!, "real.txt", "session-side");
    await commitIn(repo, "docs/rfcs/index.yaml", developIndex);
    await commitIn(repo, "real.txt", "develop-side");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      // Mixed conflict set refuses before the resolver engages a side.
      sideInvoke: () => async () => ({ ok: true, exitCode: 0 }),
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    expect(data.diagnostics[0]?.message).toContain("real.txt");
  }, 20_000);
});

describe("flow.integrate — recoverable manifest drift (RFC-1546 AC-1)", () => {
  it("sole FLOW-INT-12 drift defers regeneration to the post-rebase step and writes nothing (RFC-1574 AC-4)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "regen");
    const { runIntegratePreflight } = await import("../preflight.ts");
    const invoked: string[] = [];
    let validateCalls = 0;
    const cmd = (name: string) => ({
      name,
      provider: "workspace" as const,
      description: name,
      scope: "workspace" as const,
    });
    const preflight = await runIntegratePreflight({
      primary: repo,
      branchWorktree: session.worktree!,
      branch: session.branch!,
      io: ambientIo,
      worktreeDirty: { entries: [], toleratedState: [] },
      commands: [
        "ecosystem.manifest.validate",
        "ecosystem.manifest.generate",
        "rfc.validate",
        "friction.validate",
      ].map(cmd),
      invoke: async (name) => {
        invoked.push(name);
        if (name === "ecosystem.manifest.validate") {
          validateCalls++;
          return validateCalls === 1
            ? { ok: false, exitCode: 1, summary: "stale: docs/ecosystem.generated.yaml" }
            : { ok: true, exitCode: 0 };
        }
        return { ok: true, exitCode: 0 };
      },
    });
    expect(preflight.ok).toBe(true);
    // RFC-1574: the preflight never invokes the generator — step (3b) does,
    // on the rebased tree, and commits the result.
    expect(invoked).toEqual(["ecosystem.manifest.validate", "friction.validate"]);
    const status = await gitExec(session.worktree!, ["status", "--porcelain"]);
    expect(status.stdout.trim(), "the preflight must leave the worktree clean").toBe("");
  }, 20_000);

  it("a second violation alongside drift refuses without regenerating", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "regen");
    const { runIntegratePreflight } = await import("../preflight.ts");
    const invoked: string[] = [];
    const cmd = (name: string) => ({
      name,
      provider: "workspace" as const,
      description: name,
      scope: "workspace" as const,
    });
    const preflight = await runIntegratePreflight({
      primary: repo,
      branchWorktree: session.worktree!,
      branch: session.branch!,
      io: ambientIo,
      worktreeDirty: { entries: [], toleratedState: [] },
      commands: [
        "ecosystem.manifest.validate",
        "ecosystem.manifest.generate",
        "friction.validate",
      ].map(cmd),
      invoke: async (name) => {
        invoked.push(name);
        if (name === "ecosystem.manifest.validate") {
          return { ok: false, exitCode: 1, summary: "stale: docs/ecosystem.generated.yaml" };
        }
        // friction.validate is also red — drift is not the sole violation.
        return { ok: false, exitCode: 1, summary: `${name} failed` };
      },
    });
    expect(preflight.ok).toBe(false);
    // The coexisting refusal fires; the regeneration never ran.
    expect(preflight.refuse?.ruleId).toBe("FLOW-INT-14");
    expect(invoked).toEqual(["ecosystem.manifest.validate", "friction.validate"]);
  }, 20_000);
});

// RFC-1544 AC-2/AC-4: referent-aware importer-prune resolution inside
// flow.integrate — a foreign checkout's open mission restores its importer
// subtree (journaled), a stale prune commits as cleanup, and any prune diff
// that is not importer-only still refuses FLOW-INT-01.
const LOCK_WITH_IMPORTER = [
  "importers:",
  "",
  "  .:",
  "    dependencies: {}",
  "",
  "  missions/m-foreign/workpiece:",
  "    dependencies:",
  "      vite: 5.0.0",
  "",
  "packages:",
  "  vite: 5.0.0",
  "",
].join("\n");
const LOCK_PRUNED = [
  "importers:",
  "",
  "  .:",
  "    dependencies: {}",
  "",
  "packages:",
  "  vite: 5.0.0",
  "",
].join("\n");

describe("flow.integrate — mission importer referents (RFC-1544)", () => {
  it("AC-2: a foreign-open-mission prune is auto-restored and journaled", async () => {
    const repo = await governedRepo();
    await commitIn(repo, "pnpm-lock.yaml", LOCK_WITH_IMPORTER);
    const session = await openSession(repo, "importer-foreign");
    await commitIn(session.worktree!, "session.txt", "work");
    // The foreign checkout: a detached worktree holding the open mission.
    const foreign = join(repo, "..", `foreign-holder-${Date.now()}`);
    dirs.push(foreign);
    const add = await gitExec(repo, ["worktree", "add", "--detach", foreign, "develop"]);
    expect(add.exitCode).toBe(0);
    await mkdir(join(foreign, "missions", "m-foreign", "workpiece"), { recursive: true });
    await writeFile(join(foreign, "missions", "m-foreign", "mission.yaml"), 'state: "open"\n');
    // The session worktree's install pruned the importer it cannot see.
    await writeFile(join(session.worktree!, "pnpm-lock.yaml"), LOCK_PRUNED);

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.restoredImporters).toEqual(["m-foreign"]);
    // The restored lockfile matched HEAD — no prune commit reached develop.
    const headLock = await gitExec(repo, ["show", "develop:pnpm-lock.yaml"]);
    expect(headLock.stdout).toContain("missions/m-foreign/workpiece:");
  }, 30_000);

  it("AC-4: a prune diff that is not importer-only still refuses FLOW-INT-01", async () => {
    const repo = await governedRepo();
    await commitIn(repo, "pnpm-lock.yaml", LOCK_WITH_IMPORTER);
    const session = await openSession(repo, "importer-mixed");
    await commitIn(session.worktree!, "session.txt", "work");
    // Importer prune + an unrelated removal — ambiguous, never computed.
    await writeFile(
      join(session.worktree!, "pnpm-lock.yaml"),
      LOCK_PRUNED.replace("  vite: 5.0.0\n", ""),
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-01");
    expect(data.restoredImporters).toBeUndefined();
    expect(data.staleImporterCommitSha).toBeUndefined();
  }, 30_000);

  it("a prune whose referent exists nowhere commits as stale cleanup", async () => {
    const repo = await governedRepo();
    await commitIn(repo, "pnpm-lock.yaml", LOCK_WITH_IMPORTER);
    const session = await openSession(repo, "importer-stale");
    await commitIn(session.worktree!, "session.txt", "work");
    await writeFile(join(session.worktree!, "pnpm-lock.yaml"), LOCK_PRUNED);

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.staleImporterCommitSha).toBeDefined();
    // The prune commit rode the branch into develop — residue is gone.
    const headLock = await gitExec(repo, ["show", "develop:pnpm-lock.yaml"]);
    expect(headLock.stdout).not.toContain("missions/m-foreign/workpiece:");
  }, 30_000);
});

describe("FLOW-INT-19 — duplicate governance ids on the branch (RFC-1600)", () => {
  it("refuses a file-family id already landed on develop at a different path (AC-3)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "dup-rfc-id");
    await mkdir(join(session.worktree!, "docs/rfcs"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/rfcs/rfc-1600-branch-side.md",
      "---\nid: RFC-1600\ntitle: branch copy\n---\n",
    );
    // Meanwhile develop lands the same id at its own path — the allocation
    // race the reservation surface could not prevent retroactively.
    await mkdir(join(repo, "docs/rfcs"), { recursive: true });
    await commitIn(repo, "docs/rfcs/rfc-1600-develop-side.md", "---\nid: RFC-1600\n---\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    const refusal = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-19");
    expect(refusal, "the duplicate must refuse before the heavyweight gate").toBeTruthy();
    expect(refusal?.severity).toBe("error");
    expect(refusal?.message).toContain("RFC-1600");
    expect(refusal?.message).toContain("docs/rfcs/rfc-1600-branch-side.md");
    expect(refusal?.message).toContain("docs/rfcs/rfc-1600-develop-side.md");
    const dups = refusal?.data?.duplicates as { onBranch: string; onDevelop: string }[];
    expect(dups).toHaveLength(1);
    expect(dups[0]?.onDevelop).toBe("docs/rfcs/rfc-1600-develop-side.md");
  }, 30_000);

  it("refuses a rule literal added on the branch while develop defines it elsewhere", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "dup-rule-id");
    await mkdir(join(session.worktree!, "packages/y"), { recursive: true });
    await commitIn(
      session.worktree!,
      "packages/y/b.ts",
      'export const r = { id: "FLOW-INT-25" };\n',
    );
    await mkdir(join(repo, "packages/x"), { recursive: true });
    await commitIn(repo, "packages/x/a.ts", 'const rules = [{ id: "FLOW-INT-25" }];\nexport {};\n');

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.integrated).toBe(false);
    const refusal = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-19");
    expect(refusal?.message).toContain("FLOW-INT-25");
    expect(refusal?.message).toContain("packages/y/b.ts");
    expect(refusal?.message).toContain("packages/x/a.ts");
  }, 30_000);

  it("a rule literal re-landed in the file that already carries it is not a duplicate", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "packages/x"), { recursive: true });
    await commitIn(repo, "packages/x/a.ts", 'const rules = [{ id: "FLOW-INT-25" }];\nexport {};\n');
    const session = await openSession(repo, "reland-rule-id");
    await commitIn(
      session.worktree!,
      "packages/x/a.ts",
      '// FLOW-INT-25 owns the refusal here\nconst rules = [{ id: "FLOW-INT-25" }];\nexport {};\n',
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.ruleId === "FLOW-INT-19")).toEqual([]);
    expect(data.integrated).toBe(true);
  }, 30_000);

  // F-0286 signatures (the scanner's own first live run): branch friction
  // files must resolve to their real ids (F-0283, not F-undefined), and a
  // rule literal carried by prose on either side is not an allocation.
  it("does not collide distinct friction ids (F-0283 vs F-0282)", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "docs/frictions"), { recursive: true });
    await commitIn(repo, "docs/frictions/F-0282.yaml", "id: F-0282\nstatus: open\n");
    const session = await openSession(repo, "new-friction-id");
    await mkdir(join(session.worktree!, "docs/frictions"), { recursive: true });
    await commitIn(session.worktree!, "docs/frictions/F-0283.yaml", "id: F-0283\nstatus: open\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.ruleId === "FLOW-INT-19")).toEqual([]);
    expect(data.integrated).toBe(true);
  }, 30_000);

  it("does not flag a rule literal carried only as prose mentions", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "docs/agent-guides"), { recursive: true });
    await commitIn(repo, "docs/agent-guides/g.md", "that is FLOW-INT-01\n");
    const session = await openSession(repo, "mention-rule-id");
    await mkdir(join(session.worktree!, "docs/agent-guides"), { recursive: true });
    await commitIn(
      session.worktree!,
      "docs/agent-guides/h.md",
      "does not judge worktree dirt — that is FLOW-INT-01\n",
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.ruleId === "FLOW-INT-19")).toEqual([]);
    expect(data.integrated).toBe(true);
  }, 30_000);

  // A develop commit declared a rule in source without regenerating the
  // inventory; a branch that regenerates it adds the projection line. The
  // projection mirrors the source declaration — catching up, not allocating.
  it("does not flag a generated projection catching up a rule declared in source on develop", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "packages/x"), { recursive: true });
    await commitIn(repo, "packages/x/a.ts", 'const rules = [{ id: "FLOW-INT-25" }];\nexport {};\n');
    await mkdir(join(repo, "docs"), { recursive: true });
    // Fixture rule ids stay outside the live FLOW-INT range — this file is
    // itself scanned by FLOW-INT-19 when it lands.
    await commitIn(repo, "docs/validator-inventory.generated.yaml", "rules: []\n");
    const session = await openSession(repo, "inventory-catch-up");
    await commitIn(
      session.worktree!,
      "docs/validator-inventory.generated.yaml",
      "rules:\n  - id: FLOW-INT-25\n",
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.ruleId === "FLOW-INT-19")).toEqual([]);
    expect(data.integrated).toBe(true);
  }, 30_000);

  it("a same-site source reland is not a duplicate of its own generated projection on develop", async () => {
    const repo = await governedRepo();
    await mkdir(join(repo, "packages/x"), { recursive: true });
    await commitIn(repo, "packages/x/a.ts", 'const rules = [{ id: "FLOW-INT-25" }];\nexport {};\n');
    await mkdir(join(repo, "docs"), { recursive: true });
    await commitIn(
      repo,
      "docs/validator-inventory.generated.yaml",
      "rules:\n  - id: FLOW-INT-25\n",
    );
    const session = await openSession(repo, "reland-with-projection");
    await commitIn(
      session.worktree!,
      "packages/x/a.ts",
      'const rules = [{ id: "FLOW-INT-25", severity: "error" }];\nexport {};\n',
    );

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics.filter((d) => d.ruleId === "FLOW-INT-19")).toEqual([]);
    expect(data.integrated).toBe(true);
  }, 30_000);
});

describe("RFC-1599 foreignDirt — primary mutations audited beside a live session", () => {
  it("carries the attributed rows in the FLOW-INT-03 refusal data plus a FLOW-INT-20 warning", async () => {
    const repo = await governedRepo();
    const session = await openFlowBranch(repo, ambientIo, {
      kind: "session",
      slug: "dirt-owner",
      brief: "RFC-1599 audit",
      owner: null,
      dryRun: false,
      now: NOW,
    });
    dirs.push(session.worktree!);
    await commitIn(session.worktree!, "a.txt", "a");
    // Tracked primary dirt on develop — unattributed work refuses FLOW-INT-03;
    // the audit rows attribute the token-carrying path to the session.
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    await commitIn(repo, "docs/rfcs/rfc-1599-a.md", "v1\n");
    await writeFile(join(repo, "docs/rfcs/rfc-1599-a.md"), "dirty\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      waitForeignSeconds: 0,
    });

    expect(data.integrated).toBe(false);
    const refusal = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-03");
    expect(refusal?.severity).toBe("error");
    const rows = refusal?.data?.foreignDirt as
      { path: string; owningSession: string | null }[] | undefined;
    expect(rows).toEqual([{ path: "docs/rfcs/rfc-1599-a.md", owningSession: session.branch }]);
    const warning = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-20");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain("docs/rfcs/rfc-1599-a.md");
    expect(warning?.message).toContain(session.branch!);
  }, 30_000);

  it("warns FLOW-INT-20 without refusing when all primary dirt is twin-sync tolerated", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "twindirt");
    await commitIn(session.worktree!, "a.txt", "a");
    // Committed twin + canonical, then the primary's twin edit byte-matches
    // the canonical — skill-twin-sync tolerated dirt: audit warns, no refusal.
    await mkdir(join(repo, ".agents", "skills", "fo-x"), { recursive: true });
    await mkdir(join(repo, "packages", "forge", "skills", "fo", "fo-x"), {
      recursive: true,
    });
    await commitIn(repo, ".agents/skills/fo-x/SKILL.md", "v1\n");
    await commitIn(repo, "packages/forge/skills/fo/fo-x/SKILL.md", "v2\n");
    await writeFile(join(repo, ".agents/skills/fo-x/SKILL.md"), "v2\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      waitForeignSeconds: 0,
    });

    expect(data.integrated).toBe(true);
    const warning = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-20");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain(".agents/skills/fo-x/SKILL.md");
    expect(data.diagnostics.some((d) => d.severity === "error")).toBe(false);
  }, 30_000);
});
