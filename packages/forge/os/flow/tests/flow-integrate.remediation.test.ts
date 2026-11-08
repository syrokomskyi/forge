/*
<MODULE_CONTRACT>
<purpose>flow.integrate remediation-flag tests (RFC-1531 AC-3/4/5/7):
--auto-clean deletes exactly the closed disposable class then re-evaluates
(a work or importer-prune member in the set deletes nothing and refuses
FLOW-INT-01 with per-path classes), --autocommit sweeps the remainder into
the fixed-subject commit and records its sha, and every flag mutates
nothing under --dry-run.</purpose>
<non-goals>
  <item>No vanished-worktree coverage — flow-integrate.reattach.test.ts owns --reattach.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1531: closed dirty-path classifier + remediation flags on flow.integrate</item>
  <item>RFC-1531: add flow.integrate remediation flags on the shared dirty classifier</item>
</CHANGE_SUMMARY>
*/

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { commonGitDir, readJournal } from "../registry.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-02T12:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function governedRepo(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-remediate-" });
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

describe("flow.integrate --auto-clean (RFC-1531)", () => {
  it("AC-3: an all-disposable dirty set is deleted and the pipeline proceeds", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "debris");
    await commitIn(session.worktree!, "real.txt", "real work");
    await writeFile(join(session.worktree!, "scratch.log"), "scratch\n");
    await mkdir(join(session.worktree!, "coverage"), { recursive: true });
    await writeFile(join(session.worktree!, "coverage", "lcov.info"), "lcov\n");
    await mkdir(join(session.worktree!, "tmp-e2e"), { recursive: true });
    await writeFile(join(session.worktree!, "tmp-e2e", "trace.out"), "trace\n");
    await writeFile(join(session.worktree!, "leftover.stale"), "stale\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      autoClean: true,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.autoCleaned).toEqual(
      expect.arrayContaining([
        "scratch.log",
        "coverage/lcov.info",
        "tmp-e2e/trace.out",
        "leftover.stale",
      ]),
    );
    expect((await gitExec(repo, ["cat-file", "-e", "develop:real.txt"])).exitCode).toBe(0);
    // The disposable debris was deleted, not committed.
    expect((await gitExec(repo, ["cat-file", "-e", "develop:scratch.log"])).exitCode).not.toBe(0);
    // The journal records the cleanup for auditability.
    const journal = await readJournal(ambientIo, await commonGitDir(ambientIo, repo));
    const integrate = [...journal].reverse().find(
      (e) => e.event === "integrate" && e.branch === session.branch,
    );
    expect(integrate?.autoCleaned).toEqual(
      expect.arrayContaining(["scratch.log"]),
    );
  }, 20_000);

  it("AC-4: a work member in the set deletes nothing and refuses FLOW-INT-01 with per-path classes", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "mixed");
    await commitIn(session.worktree!, "real.txt", "real");
    await writeFile(join(session.worktree!, "scratch.log"), "debris\n");
    await writeFile(join(session.worktree!, "important.ts"), "export const x = 1;\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      autoClean: true,
    });

    expect(data.integrated).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-01");
    // Nothing was deleted — the disposable sibling stays for the operator.
    expect(await ambientIo.exists(join(session.worktree!, "scratch.log"))).toBe(true);
    // data.entries carries the classified set: scratch.log disposable,
    // important.ts work.
    const entries = data.diagnostics[0]?.data?.["entries"] as
      | Array<{ path: string; class: string }>
      | undefined;
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "scratch.log", class: "disposable" },
        { path: "important.ts", class: "work" },
      ]),
    );
    expect(data.diagnostics[0]?.data?.["classes"]).toMatchObject({
      disposable: 1,
      work: 1,
    });
  }, 20_000);
});

describe("flow.integrate --autocommit (RFC-1531)", () => {
  it("AC-5/AC-9: remaining dirty entries sweep into the fixed-subject commit before the rebase", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "sweep");
    await commitIn(session.worktree!, "real.txt", "real");
    await writeFile(join(session.worktree!, "notes.md"), "loose notes\n");
    await writeFile(join(session.worktree!, "draft.ts"), "export {};\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      autocommit: true,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.autocommitSha).toMatch(/^[0-9a-f]{40}$/);
    // The sweep commit carries the fixed subject and both files.
    const subject = (
      await gitExec(repo, ["log", "-1", "--format=%s", data.autocommitSha!])
    ).stdout.trim();
    expect(subject).toBe("chore(flow): sweep session leftovers");
    expect((await gitExec(repo, ["cat-file", "-e", "develop:notes.md"])).exitCode).toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:draft.ts"])).exitCode).toBe(0);
  }, 20_000);

  it("composition: --auto-clean deletes disposable first, --autocommit sweeps only what remains", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "composed");
    await commitIn(session.worktree!, "real.txt", "real");
    await writeFile(join(session.worktree!, "scratch.log"), "debris\n");
    await writeFile(join(session.worktree!, "keep.ts"), "export {};\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
      autoClean: true,
      autocommit: true,
    });

    expect(data.diagnostics).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.autoCleaned).toEqual(["scratch.log"]);
    // Debris never lands in the sweep commit.
    expect((await gitExec(repo, ["cat-file", "-e", "develop:scratch.log"])).exitCode).not.toBe(0);
    expect((await gitExec(repo, ["cat-file", "-e", "develop:keep.ts"])).exitCode).toBe(0);
  }, 20_000);
});

describe("remediation flags under --dry-run (RFC-1531 AC-7)", () => {
  it("reports the classified set and the would-clean scope without deleting or committing", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "preview");
    await commitIn(session.worktree!, "real.txt", "real");
    await writeFile(join(session.worktree!, "scratch.log"), "debris\n");
    await writeFile(join(session.worktree!, "keep.ts"), "export {};\n");
    const tip = await sha(repo, session.branch!);

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: true,
      now: NOW,
      autoClean: true,
      autocommit: true,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-01");
    expect(data.diagnostics[0]?.data?.["wouldAutoClean"]).toEqual(["scratch.log"]);
    expect(data.diagnostics[0]?.data?.["wouldAutocommit"]).toBe(true);
    // Nothing deleted, nothing committed.
    expect(await ambientIo.exists(join(session.worktree!, "scratch.log"))).toBe(true);
    expect(await ambientIo.exists(join(session.worktree!, "keep.ts"))).toBe(true);
    expect(await sha(repo, session.branch!)).toBe(tip);
  }, 20_000);

  it("without flags the FLOW-INT-01 diagnostic still carries per-path classes (AC-6)", async () => {
    const repo = await governedRepo();
    const session = await openSession(repo, "classified");
    await commitIn(session.worktree!, "real.txt", "real");
    await writeFile(join(session.worktree!, "scratch.log"), "debris\n");
    await writeFile(join(session.worktree!, "keep.ts"), "export {};\n");

    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: session.branch!,
      dryRun: false,
      now: NOW,
    });

    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-INT-01");
    const entries = data.diagnostics[0]?.data?.["entries"] as
      | Array<{ path: string; class: string }>
      | undefined;
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "scratch.log", class: "disposable" },
        { path: "keep.ts", class: "work" },
      ]),
    );
    expect(data.diagnostics[0]?.fixHint).toContain("--auto-clean");
    expect(data.diagnostics[0]?.fixHint).toContain("--autocommit");
  }, 20_000);
});
