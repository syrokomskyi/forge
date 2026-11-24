/*
<MODULE_CONTRACT>
<purpose>RFC-1638 AC-4 evidence: digestId is computed over the reduced
judged-input set — refs/remotes/origin/*, derived ahead counts, and the
pushedTags journal suppression are OUTSIDE the hash, so post-push drift
of those surfaces cannot invalidate a reviewed digestId; while any local
mutation (tip move, journal tail, status) still does.</purpose>
<non-goals>
  <item>No inputHash-vs-attestation coverage — flow-push-attest.test.ts owns the push-side assertions.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Remote drift is staged by plumbing (commit-tree + update-ref) — no checkout, so the local worktree/status input stays byte-identical across the two collects.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1638: digestId reduced-input-set stability tests</item>
  <item>RFC-1638: persist reviewed digests + attest pushed state by input hash</item>
</CHANGE_SUMMARY>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { appendJournal } from "../registry.ts";
import { releaseTagAnnotation, writeReleaseTag } from "../release-tags.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

async function unpushedCommit(repo: string, file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-m", `add ${file}`]);
}

/** Plant a diverged child on refs/remotes/origin/<branch> via plumbing —
 * the local checkout never moves, so only the remote-tracking input drifts. */
async function divergeRemoteRef(repo: string, branch: string): Promise<void> {
  const base = (await gitExec(repo, ["rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim();
  const tree = (await gitExec(repo, ["rev-parse", `${base}^{tree}`])).stdout.trim();
  const foreign = (
    await gitExec(repo, ["commit-tree", tree, "-p", base, "-m", `foreign ${branch}`])
  ).stdout.trim();
  await gitExec(repo, ["update-ref", `refs/remotes/origin/${branch}`, foreign]);
}

describe("digestId reduced input set (RFC-1638, AC-4)", () => {
  it("a remote-tracking ref move does not invalidate the quoted digestId", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "digest-id-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const before = await collectDigest(repo, ambientIo, { fetch: false });

    await divergeRemoteRef(repo, "develop");
    const after = await collectDigest(repo, ambientIo, { fetch: false });

    expect(after.digestId).toBe(before.digestId);
  }, 120_000);

  it("a journal 'push' record suppressing a tag does not change digestId", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "digest-tag-" });
    const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    await writeReleaseTag(repo, ambientIo, {
      name: "v1.0.1",
      target: tip,
      annotation: releaseTagAnnotation({
        tag: "v1.0.1",
        line: "repo",
        version: "1.0.1",
        level: "baseline",
        previous: null,
        rfcs: [],
        fingerprints: {},
      }),
    });
    const before = await collectDigest(repo, ambientIo, { fetch: false });
    expect(before.tags).toContain("v1.0.1");

    await appendJournal(ambientIo, join(repo, ".git"), {
      event: "push",
      branch: "develop",
      sha: tip,
      detail: "v1.0.1",
      at: new Date().toISOString(),
    });
    const after = await collectDigest(repo, ambientIo, { fetch: false });

    expect(after.digestId).toBe(before.digestId);
    expect(after.tags).not.toContain("v1.0.1"); // display list suppressed, hash stable
  }, 120_000);

  it("a local tip move DOES change digestId — the reduced set still covers local state", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "digest-local-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const before = await collectDigest(repo, ambientIo, { fetch: false });
    await unpushedCommit(repo, "more.txt", "m\n");
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.digestId).not.toBe(before.digestId);
  }, 120_000);
});
