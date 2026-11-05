/*
<MODULE_CONTRACT>
<purpose>
RFC-1495 step 1 — resolveStateRoots distinguishes the session worktree from
the primary checkout, degrades on non-git dirs, and forge's own mission.archive
writes the archive into the primary while the mission source stays where the
command ran.
</purpose>
<non-goals>
  <item>Not a contract source of truth — resolveStateRoots and the archive handler own the authoritative behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1495: step 1 — state-roots + primary-archive tests</item>
  <item>RFC-1495: step 1 - forge state roots</item>
</CHANGE_SUMMARY>
*/

import { test, expect, describe, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { ambientIo } from "../../../src/utils/io.ts";
import { realpathSync } from "../../../src/utils/sync-fs.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";

import { resolveStateRoots } from "../worktree-path.ts";
import { runMissionArchive } from "../../mission/handlers/archive.ts";
import { gitExec, initRepo } from "./helpers.ts";

const io = ambientIo;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

function makeContext(workspaceRoot: string): ForgeRuntimeContext {
  return {
    workspaceRoot,
    io,
    logger: {
      info: () => {},
      success: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    outputFormat: "json",
    dryRun: false,
  } as unknown as ForgeRuntimeContext;
}

function makeInput(flags: Record<string, unknown> = {}): ForgeCommandInput {
  return { commandName: "mission.archive", flags } as unknown as ForgeCommandInput;
}

describe("resolveStateRoots (RFC-1495)", () => {
  test("single-worktree repo resolves every root to itself", async () => {
    const repo = await initRepo({ prefix: "state-roots-" });
    dirs.push(repo);
    const roots = await resolveStateRoots(repo, io);
    // Roots come back canonicalized (git's resolved frame) — compare real
    // spellings, not the mkdtemp 8.3 alias Windows may hand out.
    expect(roots.worktreeRoot).toBe(realpathSync(repo));
    expect(roots.primaryRoot).toBe(realpathSync(repo));
    expect(roots.isPrimary).toBe(true);
  });

  test("from a linked worktree, primary is the first worktree", async () => {
    const repo = await initRepo({ prefix: "state-roots-" });
    dirs.push(repo);
    const wt = join(dirname(repo), `${basename(repo)}@session-x`);
    const add = await gitExec(repo, ["worktree", "add", "-b", "session-x", wt]);
    expect(add.exitCode).toBe(0);
    // Worktree dirs land inside the tracked rm — the worktree itself is
    // removed with the parent dir.
    dirs.push(wt);

    const roots = await resolveStateRoots(wt, io);
    expect(roots.worktreeRoot).toBe(realpathSync(wt));
    expect(roots.primaryRoot).toBe(realpathSync(repo));
    expect(roots.isPrimary).toBe(false);

    const primary = await resolveStateRoots(repo, io);
    expect(primary.isPrimary).toBe(true);
    expect(primary.worktreeRoot).toBe(realpathSync(repo));
  });

  test("non-git directory degrades to itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "state-roots-"));
    dirs.push(dir);
    const roots = await resolveStateRoots(dir, io);
    expect(roots).toEqual({
      worktreeRoot: dir,
      primaryRoot: dir,
      isPrimary: true,
    });
  });

  test("mission.archive run in a session worktree lands in the primary archive", async () => {
    const repo = await initRepo({ prefix: "state-roots-" });
    dirs.push(repo);
    const wt = join(dirname(repo), `${basename(repo)}@session-y`);
    const add = await gitExec(repo, ["worktree", "add", "-b", "session-y", wt]);
    expect(add.exitCode).toBe(0);
    dirs.push(wt);

    // A closed mission exists in the session worktree only.
    const missionId = "acme-m000001";
    const missionDir = join(wt, "missions", missionId);
    await mkdir(missionDir, { recursive: true });
    await writeFile(
      join(missionDir, "mission.yaml"),
      `missionId: ${missionId}\nstate: closed\n`,
    );

    const result = await runMissionArchive(makeInput(), makeContext(wt));
    expect(result.exitCode ?? 0).toBe(0);

    // Durable target: the primary's missions/archive/closed/, never the wt's.
    expect(
      existsSync(join(repo, "missions", "archive", "closed", missionId, "mission.yaml")),
    ).toBe(true);
    expect(existsSync(join(wt, "missions", "archive"))).toBe(false);
    expect(existsSync(missionDir)).toBe(false);
  });
});
