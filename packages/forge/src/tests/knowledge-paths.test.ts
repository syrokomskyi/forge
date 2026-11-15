/*
<MODULE_CONTRACT>
<purpose>resolveKnowledgeRoot tests (RFC-1599 AC-5): a cwd inside a session
worktree resolves to that worktree (`.git` gitfile), a cwd inside the
primary resolves to the primary (`.git` dir), and a cwd with no owning
checkout falls back to `&lt;start&gt;/.agents-local`.</purpose>
<non-goals>
  <item>No knowledge-write coverage — writers own their file formats.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1599: evidence — owning-checkout resolution, worktree gitfile, fallback</item>
  <item>RFC-1599: sweep primary dirt into opened worktrees + bind session writes to the owning checkout (RFC-1599)</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveKnowledgeRoot } from "../knowledge/paths.ts";
import { ambientIo } from "../utils/io.ts";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

async function seededRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-paths-"));
  dirs.push(dir);
  await exec("git", ["init", "-b", "main", dir]);
  await exec("git", ["-C", dir, "config", "user.email", "test@example.invalid"]);
  await exec("git", ["-C", dir, "config", "user.name", "test"]);
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await exec("git", ["-C", dir, "add", "seed.txt"]);
  await exec("git", ["-C", dir, "commit", "-m", "seed"]);
  return dir;
}

describe("resolveKnowledgeRoot", () => {
  it("resolves a linked session worktree's own checkout (.git gitfile)", async () => {
    const repo = await seededRepo();
    const wt = join(repo, "..", "linked-wt");
    dirs.push(wt);
    await exec("git", ["-C", repo, "worktree", "add", "-b", "session-x", wt, "main"]);

    const res = await resolveKnowledgeRoot(join(wt, "docs", "deep"), ambientIo);
    expect(res.kind).toBe("worktree");
    expect(res.checkoutRoot).toBe(wt);
    expect(res.agentsRoot).toBe(join(wt, ".agents"));
    // Never the primary — the F-0210 boundary this resolver enforces.
    expect(res.checkoutRoot).not.toBe(repo);
  });

  it("resolves the primary checkout (.git directory)", async () => {
    const repo = await seededRepo();
    const res = await resolveKnowledgeRoot(join(repo, "nested", "dir"), ambientIo);
    expect(res.kind).toBe("primary");
    expect(res.checkoutRoot).toBe(repo);
    expect(res.agentsRoot).toBe(join(repo, ".agents"));
  });

  it("falls back to <start>/.agents-local when no checkout owns the cwd", async () => {
    const bare = await mkdtemp(join(tmpdir(), "knowledge-nogit-"));
    dirs.push(bare);
    const res = await resolveKnowledgeRoot(bare, ambientIo);
    expect(res.kind).toBe("fallback");
    expect(res.checkoutRoot).toBeNull();
    expect(res.agentsRoot).toBe(join(bare, ".agents-local"));
  });
});
