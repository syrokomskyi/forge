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
  <item>RFC-1545: standalone generated-conflict regeneration in flow.integrate</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
  <item>RFC-1544: attribute mission lockfile churn to owning checkout and auto-resolve foreign importer diffs (RFC-1544)</item>
  <item>ADR-0128: FLOW-INT-02 names rebase stderr tail + porcelain status when no unmerged paths; cap path list at 20 (+N more) (ADR-0128 F-0188)</item>
  <item>RFC-1574: regenerate derived manifests after the integrate rebase and commit them

flow.integrate step (3b) runs GENERATED_BASENAME_OWNERS owners on the rebased tree (opts.invoke ?? standaloneInvoke), commits only owned paths with the fixed subject before the gate, refuses FLOW-INT-12 on owner failure, non-owned dirt or a still-red validate; the preflight no longer writes and refuses only without a resolvable owner.</item>
  <history>RFC-1487, RFC-1515, RFC-1528, RFC-1537, RFC-1538, RFC-1546</history>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
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
    expect((details?.rebaseStderrTail as string[]).join("\n")).toContain(
      "knowledge-conflicts.txt",
    );
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
      invoke: async (name, flags) => {
        invoked.push(`${name} ${JSON.stringify(flags ?? {})}`);
        await writeFile(join(session.worktree!, "docs/rfcs/index.yaml"), resolved);
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
      invoke: async () => ({
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
      invoke: async () => {
        // A "successful" regen that writes marker-laden output must not land.
        await writeFile(
          join(session.worktree!, "docs/rfcs/index.yaml"),
          "command: rfc.index.generate\n<<<<<<< HEAD\ncount: 9\n=======\ncount: 2\n>>>>>>> branch\n",
        );
        return { ok: true, exitCode: 0 };
      },
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-02");
    expect(data.diagnostics[0]?.message).toContain("conflict markers");
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
      invoke: async () => ({ ok: true, exitCode: 0 }),
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
