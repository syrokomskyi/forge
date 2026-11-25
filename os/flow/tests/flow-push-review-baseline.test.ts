/*
<MODULE_CONTRACT>
<purpose>RFC-1643: flow.push honors a committed review baseline —
`push.verifierReviewedThrough: <full sha>` read from forge.yaml at the
digest-reviewed `refs/heads/develop` tip. Trailer commits that are
ancestors of a usable baseline (and the integrate-generated weakening
record of a baseline-only bump) stop triggering FLOW-PUSH-08 but stay
listed; FLOW-PUSH-17 makes every exemption visible. Worktree, session-HEAD
and shadow-ref declarations, malformed/unknown/tag/non-ancestor values,
pseudo-hits and planted tracking refs (CX-82) exempt nothing.</purpose>
<non-goals>
  <item>Never touches the enclosing repository — all fixtures are mkdtemp repos.</item>
  <item>No publication coverage — the scan runs before the extract path.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest } from "../digest.ts";
import { pushFlow, type FlowPushData } from "../handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function head(repo: string, rev = "HEAD"): Promise<string> {
  return (await gitExec(repo, ["rev-parse", rev])).stdout.trim();
}

async function trailerCommit(repo: string, file: string, trailer: string): Promise<string> {
  await writeFile(join(repo, file), `${file}\n`);
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailer}: yes`]);
  return head(repo);
}

function forgeYaml(originUrl: string, extra: string): string {
  return `schema: "forge/workspace@1"\npush:\n  expectedRemote: ${JSON.stringify(originUrl)}\n${extra}`;
}

/** Write (and by default commit) forge.yaml declaring `line` under push. */
async function declare(
  repo: string,
  originUrl: string,
  line: string,
  commit = true,
): Promise<string> {
  await writeFile(join(repo, "forge.yaml"), forgeYaml(originUrl, line ? `  ${line}\n` : ""));
  if (!commit) return "";
  await gitExec(repo, ["add", "forge.yaml"]);
  await gitExec(repo, ["commit", "-qm", "chore: move review baseline"]);
  return head(repo);
}

async function dryPush(repo: string): Promise<FlowPushData> {
  const digest = await collectDigest(repo, ambientIo, { fetch: false });
  return pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
}

const ids = (d: FlowPushData) => d.diagnostics.map((x) => x.ruleId);

describe("flow.push committed review baseline (RFC-1643)", () => {
  it("AC-1/AC-2/AC-3: ancestors of the baseline stop no push, stay listed, and FLOW-PUSH-17 names the bump", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    const bump = await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    const data = await dryPush(repo);
    expect(ids(data)).not.toContain("FLOW-PUSH-08");
    expect(data.verifierTrailerCommits?.map((h) => h.sha)).toEqual([t1]);
    expect(data.verifierReviewBaseline).toMatchObject({
      status: "applied",
      declared: t1,
      exempted: [t1],
      newlyExempted: [t1],
      bumpedBy: bump,
    });
    expect(data.verifierReviewBaseline?.changes).toEqual([
      { commit: bump, from: "(absent)", to: t1 },
    ]);
    const w = data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-17");
    expect(w?.severity).toBe("warning");
    expect(w?.message).toContain(t1.slice(0, 9));
    expect(w?.message).toContain(bump.slice(0, 9));
  }, 90_000);

  it("AC-4: a trailer commit after the baseline still stops, naming only it", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    const t2 = await trailerCommit(repo, "b.txt", "X-Policy-Digest");
    const data = await dryPush(repo);
    const stop = data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-08");
    expect(stop?.message).toContain(t2.slice(0, 9));
    expect(stop?.message).not.toContain(t1.slice(0, 9));
    expect(data.verifierTrailerCommits?.map((h) => h.sha).sort()).toEqual([t1, t2].sort());
  }, 90_000);

  it("AC-4: an unverifiable pseudo-hit inside the baseline's ancestry still stops", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    await writeFile(join(repo, "enc.txt"), "x\n");
    await gitExec(repo, ["add", "enc.txt"]);
    await gitExec(repo, ["-c", "i18n.commitEncoding=ISO-8859-1", "commit", "-qm", "encoded"]);
    const enc = await head(repo);
    await declare(repo, originUrl, `verifierReviewedThrough: "${enc}"`);
    const data = await dryPush(repo);
    expect(data.verifierTrailerCommits?.find((h) => h.sha === enc)?.trailers.join()).toContain(
      "x-unverifiable-encoding",
    );
    expect(data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-08")?.message).toContain(
      enc.slice(0, 9),
    );
  }, 90_000);

  it("AC-5: a worktree-only baseline exempts nothing (CX-34)", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`, false);
    const data = await dryPush(repo);
    expect(ids(data)).toContain("FLOW-PUSH-08");
  }, 90_000);

  it("AC-5: a baseline or opt-out on an unintegrated session HEAD exempts nothing", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await gitExec(repo, ["switch", "-qc", "auto/session-x"]);
    await declare(
      repo,
      originUrl,
      `verifierReviewedThrough: "${t1}"\n  requireVerifierReview: false`,
    );
    const data = await dryPush(repo);
    expect(ids(data)).toContain("FLOW-PUSH-08");
    expect(data.verifierReviewBaseline?.status).toBe("absent");
  }, 90_000);

  it("AC-5: a shadow refs/tags/develop carrying a baseline exempts nothing", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await gitExec(repo, ["switch", "-qc", "side"]);
    const shadow = await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    await gitExec(repo, ["tag", "develop", shadow]);
    await gitExec(repo, ["switch", "-q", "refs/heads/develop"]);
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.develop.local).toBe(t1);
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    expect(ids(data)).toContain("FLOW-PUSH-08");
  }, 90_000);

  describe("AC-6/AC-7: unusable baselines exempt nothing and FLOW-PUSH-16 names the reason", () => {
    const cases: Array<{
      name: string;
      value: (r: { repo: string; t1: string }) => Promise<string>;
      reason: string;
    }> = [
      {
        name: "abbreviated sha",
        value: async ({ t1 }) => `"${t1.slice(0, 12)}"`,
        reason: "malformed",
      },
      { name: "ref name", value: async () => `"develop"`, reason: "malformed" },
      {
        name: "upper-case sha",
        value: async ({ t1 }) => `"${t1.toUpperCase()}"`,
        reason: "malformed",
      },
      { name: "unquoted numeric", value: async () => "1234567", reason: "malformed" },
      { name: "unknown sha", value: async () => `"${"ab".repeat(20)}"`, reason: "unknown" },
      {
        name: "tag-object sha",
        value: async ({ repo, t1 }) => {
          await gitExec(repo, ["tag", "-a", "reviewed", "-m", "r", t1]);
          return `"${await head(repo, "refs/tags/reviewed")}"`;
        },
        reason: "not-a-commit",
      },
      {
        name: "non-ancestor commit",
        value: async ({ repo }) => {
          await gitExec(repo, ["switch", "-qc", "side"]);
          await writeFile(join(repo, "side.txt"), "s\n");
          await gitExec(repo, ["add", "side.txt"]);
          await gitExec(repo, ["commit", "-qm", "side"]);
          const side = await head(repo);
          await gitExec(repo, ["switch", "-q", "develop"]);
          return `"${side}"`;
        },
        reason: "not-ancestor",
      },
    ];
    it.each(cases)(
      "$name",
      async ({ value, reason }) => {
        const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
        const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
        await declare(repo, originUrl, `verifierReviewedThrough: ${await value({ repo, t1 })}`);
        const data = await dryPush(repo);
        expect(ids(data)).toContain("FLOW-PUSH-08");
        expect(data.verifierReviewBaseline?.exempted).toEqual([]);
        const w = data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-16");
        expect(w?.severity).toBe("warning");
        expect(w?.message).toContain(`(${reason})`);
      },
      90_000,
    );
  });

  it("AC-8: a planted origin/develop past the baseline cannot hide a trailer commit (CX-82)", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    const t2 = await trailerCommit(repo, "b.txt", "X-Expectation-Origin");
    await gitExec(repo, ["update-ref", "refs/remotes/origin/develop", t2]);
    const data = await dryPush(repo);
    expect(data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-08")?.message).toContain(
      t2.slice(0, 9),
    );
  }, 90_000);

  it("AC-9: the empty weakening record of a baseline-only bump is exempt", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    await gitExec(repo, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "flow: accept correctness weakening\n\nX-Correctness-Weakening: policy-key push",
    ]);
    const w = await head(repo);
    const data = await dryPush(repo);
    expect(ids(data)).not.toContain("FLOW-PUSH-08");
    expect(data.verifierReviewBaseline?.exempted.sort()).toEqual([t1, w].sort());
    expect(data.verifierReviewBaseline?.newlyExempted.sort()).toEqual([t1, w].sort());
  }, 90_000);

  it("AC-9: a weakening record over a bump that also changes other files still stops", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await writeFile(join(repo, "smuggled.txt"), "payload\n");
    await gitExec(repo, ["add", "smuggled.txt"]);
    await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    await gitExec(repo, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "flow: accept correctness weakening\n\nX-Correctness-Weakening: policy-key push",
    ]);
    const w = await head(repo);
    const data = await dryPush(repo);
    expect(data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-08")?.message).toContain(
      w.slice(0, 9),
    );
  }, 90_000);

  it("FLOW-PUSH-17: a decoy comment or a re-quote is not a baseline change (review E1/E3)", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    const bump = await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    await declare(repo, originUrl, `verifierReviewedThrough: '${t1}'`);
    await declare(
      repo,
      originUrl,
      `verifierReviewedThrough: '${t1}'\n  # verifierReviewedThrough: operator-reviewed`,
    );
    const data = await dryPush(repo);
    expect(data.verifierReviewBaseline?.bumpedBy).toBe(bump);
    expect(data.verifierReviewBaseline?.changes.map((c) => c.commit)).toEqual([bump]);
    expect(data.verifierReviewBaseline?.newlyExempted).toEqual([t1]);
  }, 90_000);

  it("FLOW-PUSH-17: a chain of bumps lists every change and cannot hide newly exempted hits (review E4)", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    const p1 = await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    const p2 = await declare(repo, originUrl, `verifierReviewedThrough: "${p1}"`);
    const data = await dryPush(repo);
    expect(ids(data)).not.toContain("FLOW-PUSH-08");
    expect(data.verifierReviewBaseline?.changes).toEqual([
      { commit: p2, from: t1, to: p1 },
      { commit: p1, from: "(absent)", to: t1 },
    ]);
    expect(data.verifierReviewBaseline?.newlyExempted).toEqual([t1]);
    const w = data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-17")?.message ?? "";
    expect(w).toContain(p1.slice(0, 9));
    expect(w).toContain(p2.slice(0, 9));
  }, 90_000);

  it("AC-5: a shadow refs/develop carrying a baseline exempts nothing", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await gitExec(repo, ["switch", "-qc", "side"]);
    const shadow = await declare(repo, originUrl, `verifierReviewedThrough: "${t1}"`);
    await gitExec(repo, ["update-ref", "refs/develop", shadow]);
    await gitExec(repo, ["switch", "-q", "refs/heads/develop"]);
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    expect(digest.develop.local).toBe(t1);
    const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: true });
    expect(ids(data)).toContain("FLOW-PUSH-08");
  }, 90_000);

  it("T9 residual: a develop moved past integrate still surfaces the bump in FLOW-PUSH-17 (review E2)", async () => {
    const { repo, originUrl } = await initRepoWithOrigin(dirs, { prefix: "rfc1643-" });
    await declare(repo, originUrl, "");
    await writeFile(
      join(repo, "forge.yaml"),
      forgeYaml(originUrl, "") + "policy:\n  mutable: []\n",
    );
    await gitExec(repo, ["commit", "-qam", "declare policy"]);
    await gitExec(repo, ["switch", "-qc", "auto/session-x"]);
    const t1 = await trailerCommit(repo, "a.txt", "X-Verifier-Report");
    await writeFile(
      join(repo, "forge.yaml"),
      forgeYaml(originUrl, `  verifierReviewedThrough: "${t1}"\n`) + "policy:\n  mutable: []\n",
    );
    await gitExec(repo, ["commit", "-qam", "self-exempt"]);
    const bump = await head(repo);
    await gitExec(repo, ["update-ref", "refs/heads/develop", bump]);
    await gitExec(repo, ["switch", "-q", "develop"]);
    const data = await dryPush(repo);
    // Accepted residual (RFC-1643 T9, option a): no stop, but never silent.
    expect(ids(data)).not.toContain("FLOW-PUSH-08");
    expect(data.verifierReviewBaseline?.bumpedBy).toBe(bump);
    expect(data.verifierReviewBaseline?.newlyExempted).toEqual([t1]);
    expect(data.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-17")?.message).toContain(
      bump.slice(0, 9),
    );
  }, 90_000);
});
