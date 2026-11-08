/*
<MODULE_CONTRACT>
<purpose>session.save owning-checkout routing tests (RFC-1536 AC-1/AC-4):
resolveOwningCheckout attributes a write invoked from the primary cwd to
the registered session worktree, refuses SESSION-WRITE-01 when several live
session worktrees exist without an attributable hint, and degrades to
primary semantics when no session worktree is registered.</purpose>
<non-goals>
  <item>No ATIF parsing coverage — the transcript pipeline has its own tests; this file covers only the RFC-1536 routing contract.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1536: owning-checkout routing tests</item>
  <item>RFC-1536: evidence — routing/warning tests, FLOW-OPEN-10 validation renumber, owning-worktree doc rule, frictions F-0091/F-0096/F-0106/F-0119 addressed</item>
</CHANGE_SUMMARY>
*/

import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { resolveOwningCheckout } from "../../flow/session-checkout.ts";
import { commonGitDir, updateRegistry, type FlowRegistryEntry } from "../../flow/registry.ts";
import { gitExec, initRepo } from "../../flow/tests/helpers.ts";

const dirs: string[] = [];
beforeEach(() => {
  // Agent-session env vars must not leak ambient attribution into tests.
  vi.stubEnv("WERKSTATT_AGENT_ID", "");
  vi.stubEnv("AI_AGENT", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

async function repo(): Promise<string> {
  const dir = await initRepo({ prefix: "session-save-", branch: "develop" });
  dirs.push(dir);
  return dir;
}

async function registerSession(
  primary: string,
  name: string,
  worktreePath: string,
  ownerId: string,
): Promise<string> {
  const baseSha = (await gitExec(primary, ["rev-parse", "HEAD"])).stdout.trim();
  const common = await commonGitDir(ambientIo, primary);
  const entry: FlowRegistryEntry = {
    name,
    kind: "session",
    base: "develop",
    baseSha,
    worktree: worktreePath,
    owner: { kind: "session", id: ownerId },
    brief: null,
    openedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    held: null,
    port: null,
  };
  await updateRegistry(ambientIo, common, (r) => ({
    ...r,
    branches: [...r.branches.filter((b) => b.name !== name), entry],
  }));
  return worktreePath;
}

/** Real linked worktree — resolveOwningCheckout needs topLevel() to answer. */
async function fakeWorktree(primary: string, name: string): Promise<string> {
  const dir = join(dirname(primary), `wt-${name}`);
  const add = await gitExec(primary, ["worktree", "add", "-b", `test/${name}`, dir, "develop"]);
  if (add.exitCode !== 0) throw new Error(`worktree add failed: ${add.stderr}`);
  dirs.push(dir);
  return dir;
}

describe("resolveOwningCheckout (RFC-1536)", () => {
  it("attributes a primary-cwd write to the single live session worktree (AC-1)", async () => {
    const primary = await repo();
    const wt = await fakeWorktree(primary, "one");
    await registerSession(primary, "auto/session-260101-01-a", wt, "unspecified");

    const result = await resolveOwningCheckout(ambientIo, primary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkout.kind).toBe("worktree");
      expect(result.checkout.sessionBranch).toBe("auto/session-260101-01-a");
    }
  });

  it("keeps cwd semantics inside the registered worktree itself", async () => {
    const primary = await repo();
    const wt = await fakeWorktree(primary, "self");
    await registerSession(primary, "auto/session-260101-02-b", wt, "devin");

    const result = await resolveOwningCheckout(ambientIo, wt);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkout.kind).toBe("worktree");
      expect(result.checkout.worktreePath).toBe(wt);
    }
  });

  it("refuses when several live session worktrees exist and no hint attributes (AC-4)", async () => {
    const primary = await repo();
    const wt1 = await fakeWorktree(primary, "a");
    const wt2 = await fakeWorktree(primary, "b");
    await registerSession(primary, "auto/session-260101-01-a", wt1, "unspecified");
    await registerSession(primary, "auto/session-260101-02-b", wt2, "unspecified");

    const result = await resolveOwningCheckout(ambientIo, primary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates.length).toBe(2);
    }
  });

  it("routes via an explicit sessionId hint among several worktrees", async () => {
    const primary = await repo();
    const wt1 = await fakeWorktree(primary, "a");
    const wt2 = await fakeWorktree(primary, "b");
    await registerSession(primary, "auto/session-260101-01-a", wt1, "agent-a");
    await registerSession(primary, "auto/session-260101-02-b", wt2, "agent-b");

    const result = await resolveOwningCheckout(ambientIo, primary, "agent-b");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkout.sessionBranch).toBe("auto/session-260101-02-b");
    }
  });

  it("refuses when the hint matches none of the live worktrees (never guess)", async () => {
    const primary = await repo();
    const wt = await fakeWorktree(primary, "a");
    await registerSession(primary, "auto/session-260101-01-a", wt, "agent-a");

    const result = await resolveOwningCheckout(ambientIo, primary, "agent-zzz");
    expect(result.ok).toBe(false);
  });

  it("degrades to primary when no session worktree is registered", async () => {
    const primary = await repo();
    const result = await resolveOwningCheckout(ambientIo, primary);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.checkout.kind).toBe("primary");
  });
});
