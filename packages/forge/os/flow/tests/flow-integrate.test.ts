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
  <item>RFC-1515: close rfc-1515 review findings — delete tolerated paths before worktree remove, prune vanished registrations, verified branch -D, shared held-lock render, gated e2e throw, journal toleratedState, edge tests</item>
  <item>RFC-1528: flow.integrate bounded preflight before rebase and gate

Classified lockfile diffs on FLOW-INT-01/03, early primary check, and resolvable validators (ecosystem.manifest.validate, scoped rfc.validate, friction.validate) refusing as FLOW-INT-12/13/14.</item>
  <item>RFC-1537: classify regenerable worktree dirt and journal integrate refusals cheapest-first</item>
  <item>RFC-1538: revalidate integration preconditions post-lock and reuse the session engine</item>
  <item>RFC-1546: derive-and-repair recoverable state across flow surfaces (AC-1..AC-5)</item>
  <history>RFC-1487, RFC-1515</history>
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
    await (await import("../registry.ts")).appendJournal(ambientIo, common, {
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
    const sessionIndex =
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n";
    const developIndex =
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n";
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

  it("a mixed generated/non-generated conflict set still refuses FLOW-INT-02 (AC-3 boundary)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "mixed");
    await mkdir(join(session.worktree!, "docs", "rfcs"), { recursive: true });
    await mkdir(join(repo, "docs", "rfcs"), { recursive: true });
    const sessionIndex =
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 2\n";
    const developIndex =
      "command: rfc.index.generate\ngeneratedAt: 2026-11-08\ncount: 9\n";
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
  it("sole FLOW-INT-12 drift regenerates the manifest and continues", async () => {
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
    expect(invoked).toEqual([
      "ecosystem.manifest.validate",
      "friction.validate",
      "ecosystem.manifest.generate",
      "ecosystem.manifest.validate",
    ]);
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
      commands: ["ecosystem.manifest.validate", "ecosystem.manifest.generate", "friction.validate"].map(
        cmd,
      ),
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
