/*
<MODULE_CONTRACT>
<purpose>RFC-1574 AC-1, AC-2, AC-3, AC-5 — flow.integrate step (3b): after the rebase, owner commands regenerate docs/*.generated.yaml in the session worktree and the change is committed with the fixed subject before the gate; no drift means no commit; an owner failure or non-owned dirt refuses FLOW-INT-12 without committing. Every case asserts the worktree state — the RFC-1546 tests asserted only invoke order, which is how the uncommitted regeneration shipped (F-0168).</purpose>
<non-goals>
  <item>No real generators — a stub invoke port rewrites the file.</item>
</non-goals>
</MODULE_CONTRACT>
*/
// Test-Reason: requirement AC-1, AC-2, AC-3, AC-5 (RFC-1574)
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ambientIo } from "../../../src/utils/io.ts";
import type { ForgeInvokeCommand } from "../../../src/types.ts";
import { integrateFlowBranch } from "../handlers/flow-integrate.ts";
import { openFlowBranch } from "../handlers/flow-open.ts";
import { POST_REBASE_REGEN_SUBJECT } from "../post-rebase-regen.ts";
import { gitExec, initRepo } from "./helpers.ts";

const NOW = new Date("2026-11-12T12:00:00Z");
const MANIFEST = "docs/ecosystem.generated.yaml";
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repoWithManifest(): Promise<string> {
  const dir = await initRepo({ prefix: "flow-regen-" });
  dirs.push(dir);
  await writeFile(join(dir, "forge.yaml"), 'schema: "forge/workspace@1"\n');
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, MANIFEST), "contentHash: old\n");
  await gitExec(dir, ["add", "forge.yaml", MANIFEST]);
  await gitExec(dir, ["commit", "-m", "manifest"]);
  await gitExec(dir, ["branch", "develop", "HEAD"]);
  await gitExec(dir, ["switch", "develop"]);
  return dir;
}

async function session(repo: string, slug: string) {
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
  await writeFile(join(data.worktree!, "work.txt"), "work\n");
  await gitExec(data.worktree!, ["add", "work.txt"]);
  await gitExec(data.worktree!, ["commit", "-m", "work"]);
  return data;
}

/** Stub owner port: the generator writes `content` into the manifest; extra writes simulate a misbehaving owner. */
function stubInvoke(
  worktree: () => string,
  opts: { content?: string; fail?: boolean; extra?: string; validateRed?: boolean },
): { invoke: ForgeInvokeCommand; calls: string[] } {
  const calls: string[] = [];
  const invoke: ForgeInvokeCommand = async (name) => {
    calls.push(name);
    if (name === "ecosystem.manifest.validate" && opts.validateRed) {
      return { ok: false, exitCode: 1, summary: "regenerated manifest invalid" };
    }
    if (name === "ecosystem.manifest.generate") {
      if (opts.fail) return { ok: false, exitCode: 1, summary: "generator crashed" };
      if (opts.content !== undefined) await writeFile(join(worktree(), MANIFEST), opts.content);
      if (opts.extra !== undefined) await writeFile(join(worktree(), opts.extra), "stray\n");
    }
    return { ok: true, exitCode: 0 };
  };
  return { invoke, calls };
}

describe("flow.integrate post-rebase regeneration (RFC-1574)", () => {
  it("AC-1: commits a drifted manifest with the fixed subject before the gate", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "drift");
    const stub = stubInvoke(() => s.worktree!, { content: "contentHash: new\n" });
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(data.postRebaseRegen?.committed).toEqual([MANIFEST]);
    const subjects = (await gitExec(repo, ["log", "--format=%s", "-3", "develop"])).stdout;
    expect(subjects).toContain(POST_REBASE_REGEN_SUBJECT);
    expect((await gitExec(repo, ["show", `develop:${MANIFEST}`])).stdout).toBe(
      "contentHash: new\n",
    );
  }, 30_000);

  it("AC-2: no drift means no regeneration commit", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "nodrift");
    const stub = stubInvoke(() => s.worktree!, {});
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.integrated).toBe(true);
    expect(data.postRebaseRegen?.committed).toEqual([]);
    expect(data.postRebaseRegen?.sha).toBeUndefined();
    const subjects = (await gitExec(repo, ["log", "--format=%s", "-3", "develop"])).stdout;
    expect(subjects).not.toContain(POST_REBASE_REGEN_SUBJECT);
  }, 30_000);

  it("AC-3: an owner failure refuses FLOW-INT-12 without committing", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "ownerfail");
    const developBefore = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    const stub = stubInvoke(() => s.worktree!, { fail: true });
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.integrated).toBe(false);
    expect(data.diagnostics.map((d) => d.ruleId)).toContain("FLOW-INT-12");
    expect((await gitExec(repo, ["rev-parse", "develop"])).stdout.trim()).toBe(developBefore);
    const subjects = (await gitExec(s.worktree!, ["log", "--format=%s", "-3"])).stdout;
    expect(subjects).not.toContain(POST_REBASE_REGEN_SUBJECT);
  }, 30_000);

  it("AC-5: a non-owned path dirtied by regeneration refuses FLOW-INT-12 without committing", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "stray");
    const stub = stubInvoke(() => s.worktree!, {
      content: "contentHash: new\n",
      extra: "stray.txt",
    });
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.integrated).toBe(false);
    const diag = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-12");
    expect(diag?.message).toContain("stray.txt");
    const subjects = (await gitExec(s.worktree!, ["log", "--format=%s", "-3"])).stdout;
    expect(subjects).not.toContain(POST_REBASE_REGEN_SUBJECT);
  }, 30_000);

  // Test-Reason: defect REVIEW-CODE-2026-11-12-05 A-1
  it("pre-existing untracked forge state is not judged as owner-dirtied", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "forgestate");
    await mkdir(join(s.worktree!, ".forge"), { recursive: true });
    await writeFile(join(s.worktree!, ".forge", "knowledge-conflicts.txt"), "x\n");
    const stub = stubInvoke(() => s.worktree!, { content: "contentHash: new\n" });
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.postRebaseRegen?.committed).toEqual([MANIFEST]);
  }, 30_000);

  // Test-Reason: defect REVIEW-CODE-2026-11-12-05 A-2
  it("a red validate after regeneration refuses with no regeneration commit", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "redvalidate");
    const stub = stubInvoke(() => s.worktree!, {
      content: "contentHash: bad\n",
      validateRed: true,
    });
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.integrated).toBe(false);
    expect(data.diagnostics.find((d) => d.ruleId === "FLOW-INT-12")?.message).toContain(
      "still red",
    );
    const subjects = (await gitExec(s.worktree!, ["log", "--format=%s", "-3"])).stdout;
    expect(subjects).not.toContain(POST_REBASE_REGEN_SUBJECT);
  }, 30_000);

  // Test-Reason: defect REVIEW-CODE-2026-11-12-05 A-3
  it("standalone without an engine build skips the owners instead of refusing", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "standalone");
    const progress: string[] = [];
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      onProgress: (l: string) => progress.push(l),
    });
    expect(data.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(data.integrated).toBe(true);
    expect(progress.some((l) => l.includes("not runnable here — skipped"))).toBe(true);
  }, 30_000);

  // Test-Reason: defect REVIEW-CODE-2026-11-12-06 H-N1
  it("a failing regeneration commit refuses FLOW-INT-12 with no new commit", async () => {
    const repo = await repoWithManifest();
    const s = await session(repo, "commitfail");
    const hooks = await mkdtemp(join(tmpdir(), "flow-regen-hooks-"));
    dirs.push(hooks);
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\necho refused >&2\nexit 1\n");
    await chmod(join(hooks, "pre-commit"), 0o755);
    await gitExec(s.worktree!, ["config", "core.hooksPath", hooks]);
    const head = (await gitExec(s.worktree!, ["rev-parse", "HEAD"])).stdout.trim();
    const stub = stubInvoke(() => s.worktree!, { content: "contentHash: new\n" });
    const data = await integrateFlowBranch(repo, ambientIo, {
      branch: s.branch!,
      dryRun: false,
      now: NOW,
      invoke: stub.invoke,
    });
    expect(data.integrated).toBe(false);
    const diag = data.diagnostics.find((d) => d.ruleId === "FLOW-INT-12");
    expect(diag?.message).toContain("commit failed");
    const subjects = (await gitExec(s.worktree!, ["log", "--format=%s", `${head}..HEAD`])).stdout;
    expect(subjects).not.toContain(POST_REBASE_REGEN_SUBJECT);
  }, 30_000);
});
