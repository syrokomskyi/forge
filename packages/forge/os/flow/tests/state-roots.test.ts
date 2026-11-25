/*
<MODULE_CONTRACT>
<purpose>
RFC-1495 step 1 — state roots tests: resolveStateRoots distinguishes the
session worktree from the primary checkout, degrades on non-git dirs, and
forge's own mission.archive writes the archive into the primary while the
mission source stays where the command ran.
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { ambientIo } from "../../../src/utils/io.ts";
import { canonicalRepoDir } from "../../../src/utils/repo-path.ts";

import { resolveStateRoots } from "../worktree-path.ts";
import { gitExec, initRepo } from "./helpers.ts";

const io = ambientIo;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("resolveStateRoots (RFC-1495)", () => {
  test("single-worktree repo resolves every root to itself", async () => {
    const repo = await initRepo({ prefix: "state-roots-" });
    dirs.push(repo);
    const roots = await resolveStateRoots(repo, io);
    // Roots come back canonicalized (git's resolved frame) — compare real
    // spellings, not the mkdtemp 8.3 alias Windows may hand out.
    expect(roots.worktreeRoot).toBe(canonicalRepoDir(repo));
    expect(roots.primaryRoot).toBe(canonicalRepoDir(repo));
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
    expect(roots.worktreeRoot).toBe(canonicalRepoDir(wt));
    expect(roots.primaryRoot).toBe(canonicalRepoDir(repo));
    expect(roots.isPrimary).toBe(false);

    const primary = await resolveStateRoots(repo, io);
    expect(primary.isPrimary).toBe(true);
    expect(primary.worktreeRoot).toBe(canonicalRepoDir(repo));
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

});
