/*
<MODULE_CONTRACT>
<purpose>flow.push ref preflight + push tests (RFC-1491, AC-2/AC-3): a
current digest id pushes develop/main/tags atomically so the bare origin
matches the local tips; a stale id refuses FLOW-PUSH-02 naming the new id
with origin untouched; a foreign push that diverged origin refuses
FLOW-PUSH-03; a missing --digest refuses before anything moves.</purpose>
<non-goals>
  <item>No publication coverage — flow-push-publish.test.ts owns the extract path.</item>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1491: step 5 — flow.push preflight/push tests</item>
  <item>RFC-1491: step 5 — flow.push atomic outbound path + extract publication</item>
  <item>RFC-1491: independent-review pass — shared lock constants, publishable pending filter, declared rules, hold ordering, sha-pinned refspecs</item>
  <item>RFC-1501: one argv-shaped read-only git allowlist for the recording and read-only adapters (RFC-1501)

READ_ONLY_GIT_QUERIES / isReadOnlyGitQuery replace the recording adapter's
first-argument allowlist; the read-only adapter and the static scan use the same
table. The kernel forwards --dry-run into commands that declare a dry-run flag,
and flow.push / flow.hold dry-runs no longer fetch. The switch-over runbook goes
back to werkstatt run flow.install --dry-run.</item>
</CHANGE_SUMMARY>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { pushFlow } from "../handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function unpushedCommit(repo: string, file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-m", `add ${file}`]);
}

describe("flow.push", () => {
  it("a current digest id pushes develop and main atomically (AC-2)", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-push-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const localTip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.develop.ahead).toBe(1);

    const data = await pushFlow(repo, ambientIo, {
      digest: digest.digestId,
      dryRun: false,
    });
    expect(data.diagnostics).toEqual([]);
    expect(data.pushed).toBe(true);
    // Sha-pinned refspecs (DEV-1491-001): the reviewed tips are pushed, not
    // whatever the branch names point at by exec time.
    expect(data.refs).toContain(`${localTip}:refs/heads/develop`);
    expect(data.refs.some((r) => r.endsWith(":refs/heads/main"))).toBe(true);

    const remoteDevelop = (await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim();
    expect(remoteDevelop).toBe(localTip);
    const remoteMain = (await gitExec(origin, ["rev-parse", "refs/heads/main"])).stdout.trim();
    const localMain = (await gitExec(repo, ["rev-parse", "main"])).stdout.trim();
    expect(remoteMain).toBe(localMain);

    // The journal records the push — the next digest shows an empty tail.
    const after = await collectDigest(repo, ambientIo, { fetch: false });
    expect(after.develop.ahead).toBe(0);
    expect(after.digestId).not.toBe(digest.digestId);
  }, 60_000);

  it("a stale digest id refuses FLOW-PUSH-02 and origin stays untouched (AC-3)", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-push-" });
    await unpushedCommit(repo, "one.txt", "1\n");
    const stale = (await collectDigest(repo, ambientIo, { fetch: false })).digestId;
    await unpushedCommit(repo, "two.txt", "2\n");
    const fresh = (await collectDigest(repo, ambientIo, { fetch: false })).digestId;

    const data = await pushFlow(repo, ambientIo, { digest: stale, dryRun: false });
    expect(data.pushed).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-02");
    expect(data.diagnostics[0]?.message).toContain(fresh);

    const remoteTip = (await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim();
    const baseTip = (await gitExec(repo, ["rev-parse", "develop~2"])).stdout.trim();
    expect(remoteTip).toBe(baseTip);
  }, 60_000);

  it("a foreign push that diverged origin refuses FLOW-PUSH-03", async () => {
    const { repo, origin, parent } = await initRepoWithOrigin(dirs, { prefix: "flow-push-" });
    // Another clone pushes a foreign commit to origin/develop.
    const foreign = join(parent, "foreign");
    const clone = await gitExec(parent, ["clone", origin, "foreign"]);
    if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr}`);
    await gitExec(foreign, ["config", "user.email", "flow-test@example.invalid"]);
    await gitExec(foreign, ["config", "user.name", "flow-test"]);
    await gitExec(foreign, ["switch", "-c", "develop", "origin/develop"]);
    await writeFile(join(foreign, "foreign.txt"), "f\n");
    await gitExec(foreign, ["add", "foreign.txt"]);
    await gitExec(foreign, ["commit", "-m", "foreign"]);
    const fpush = await gitExec(foreign, ["push", "origin", "develop"]);
    if (fpush.exitCode !== 0) throw new Error(`foreign push failed: ${fpush.stderr}`);

    await unpushedCommit(repo, "local.txt", "l\n");
    // fetch:true so the quoted digest already reflects the foreign push —
    // the id matches and the ancestor check is what refuses.
    const digest = await collectDigest(repo, ambientIo, { fetch: true });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(data.pushed).toBe(false);
    expect(data.diagnostics[0]?.ruleId).toBe("FLOW-PUSH-03");
    expect(data.diagnostics[0]?.message).toContain("origin/develop");

    // Local work is still there — nothing was pushed or rewritten.
    expect((await gitExec(repo, ["cat-file", "-e", "develop:local.txt"])).exitCode).toBe(0);
  }, 90_000);

  it("--dry-run evaluates preflight without moving any ref", async () => {
    const { repo, origin } = await initRepoWithOrigin(dirs, { prefix: "flow-push-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    expect(data.pushed).toBe(false);
    expect(data.refs.length).toBeGreaterThan(0);
    const remoteTip = (await gitExec(origin, ["rev-parse", "refs/heads/develop"])).stdout.trim();
    expect(remoteTip).not.toBe((await gitExec(repo, ["rev-parse", "develop"])).stdout.trim());
  }, 60_000);

  it("AC-8: --dry-run never fetches — remote-tracking refs stay unchanged (RFC-1501)", async () => {
    const { repo, origin, parent } = await initRepoWithOrigin(dirs, { prefix: "flow-push-" });
    // origin gains a commit after the repository's last fetch.
    const other = join(parent, "other");
    const clone = await gitExec(parent, ["clone", "-q", "-b", "develop", origin, other]);
    expect(clone.exitCode).toBe(0);
    await gitExec(other, ["config", "user.email", "flow-test@example.invalid"]);
    await gitExec(other, ["config", "user.name", "flow-test"]);
    await unpushedCommit(other, "foreign.txt", "f\n");
    expect((await gitExec(other, ["push", "-q", "origin", "develop"])).exitCode).toBe(0);

    const trackingBefore = (
      await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"])
    ).stdout;
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    expect(data.pushed).toBe(false);
    expect(data.fetched).toBe(false);
    const trackingAfter = (
      await gitExec(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"])
    ).stdout;
    expect(trackingAfter).toBe(trackingBefore);
  }, 60_000);
});
