import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ambientIo } from "../../../src/utils/io.ts";
import { runFlowSweptList, runFlowSweptGc } from "../handlers/flow-swept.ts";
import { gitExec, initRepo } from "./helpers.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

function ctx(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    io: ambientIo,
    logger: {
      section: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      getEvents: () => [],
    },
    dryRun: false,
    outputFormat: "json",
  } as unknown as ForgeRuntimeContext;
}

const input = (flags: Record<string, unknown> = {}) =>
  ({ argv: [], flags }) as unknown as ForgeCommandInput;

async function seedSweptRef(repo: string, wt: string, ts: string): Promise<void> {
  const { stdout: head } = await gitExec(repo, ["rev-parse", "HEAD"]);
  await gitExec(repo, ["update-ref", `refs/forge/swept/${wt}/${ts}`, head.trim()]);
}

describe("flow.swept.list / flow.swept.gc (RFC-1626)", () => {
  it("list enumerates swept refs grouped by worktree; empty inventory exits clean", async () => {
    const empty = await initRepo({ prefix: "flow-swept-empty-" });
    dirs.push(empty);
    const none = await runFlowSweptList(input(), ctx(empty));
    expect(none.exitCode).toBe(0);
    expect(none.data?.refs).toEqual([]);

    const repo = await initRepo({ prefix: "flow-swept-" });
    dirs.push(repo);
    await seedSweptRef(repo, "werkstatt-session-a", "20261119T230000Z");
    await seedSweptRef(repo, "werkstatt-session-b", "20261120T010000Z");
    const res = await runFlowSweptList(input(), ctx(repo));
    expect(res.exitCode).toBe(0);
    expect(res.data?.refs.map((r) => r.worktree).sort()).toEqual([
      "werkstatt-session-a",
      "werkstatt-session-b",
    ]);
    expect(res.data?.byWorktree).toEqual({
      "werkstatt-session-a": 1,
      "werkstatt-session-b": 1,
    });
  });

  it("gc plans without --apply and deletes only expired refs with it", async () => {
    const repo = await initRepo({ prefix: "flow-swept-gc-" });
    dirs.push(repo);
    // A commit whose COMMITTER date predates the keep window — creatordate
    // on a commit ref reads the committer date.
    const { stdout: head } = await gitExec(repo, ["rev-parse", "HEAD"]);
    const { stdout: tree } = await gitExec(repo, ["write-tree"]);
    const execFileAsync = promisify(execFile);
    const { stdout: oldHead } = await execFileAsync(
      "git",
      ["commit-tree", tree.trim(), "-p", head.trim(), "-m", "old"],
      {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
        },
      },
    );
    await gitExec(repo, ["update-ref", "refs/forge/swept/wt-old/20200101T000000Z", oldHead.trim()]);
    await gitExec(repo, ["update-ref", "refs/forge/swept/wt-new/20990101T000000Z", head.trim()]);

    const plan = await runFlowSweptGc(input({ "keep-days": "30" }), ctx(repo));
    expect(plan.exitCode).toBe(0);
    expect(plan.data?.applied).toBe(false);
    expect(plan.data?.plan).toEqual(["refs/forge/swept/wt-old/20200101T000000Z"]);

    const applied = await runFlowSweptGc(input({ "keep-days": "30", apply: true }), ctx(repo));
    expect(applied.exitCode).toBe(0);
    expect(applied.data?.deleted).toEqual(["refs/forge/swept/wt-old/20200101T000000Z"]);
    const { stdout: remaining } = await gitExec(repo, [
      "for-each-ref",
      "refs/forge/swept",
      "--format=%(refname)",
    ]);
    expect(remaining.trim()).toBe("refs/forge/swept/wt-new/20990101T000000Z");
  });
});
