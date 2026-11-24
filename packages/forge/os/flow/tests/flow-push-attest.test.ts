/*
<MODULE_CONTRACT>
<purpose>RFC-1638 AC-2/AC-3/AC-5 evidence: flow.push attests a persisted
digest by inputHash — equal inputs push without a recount, drifted inputs
fall back to a fresh recount (FLOW-PUSH-02 on a quoted-stale digestId), a
missing or unknown persisted record refuses FLOW-PUSH-15 naming
flow.digest, and --recount bypasses the file on demand.</purpose>
<non-goals>
  <item>No remote-side ref verification — the daemon fixture only proves the push accepted.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Every test goes through the real git-daemon origin + real collectDigest — the attested artifact is the one the digest command itself persisted, never a fabricated file.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1638: attestation-path push tests (attest / drift-recount / FLOW-PUSH-15 / --recount)</item>
  <item>RFC-1638: persist reviewed digests + attest pushed state by input hash</item>
</CHANGE_SUMMARY>
*/

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { collectDigest, PERSISTED_DIGESTS_DIR } from "../digest.ts";
import { pushFlow } from "../handlers/flow-push.ts";
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

function digestFilePath(repo: string, digestId: string): string {
  return join(repo, ".git", PERSISTED_DIGESTS_DIR, `${digestId}.json`);
}

describe("flow.push attestation by persisted digest (RFC-1638)", () => {
  it("AC-2: equal inputHash attests the persisted digest — push lands with no recount", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "push-attest-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });

    const result = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(result.pushed).toBe(true);
    expect(result.attestation).toBe("input-hash");
    const persisted = JSON.parse(await readFile(digestFilePath(repo, digest.digestId), "utf8")) as {
      computedAt: string;
    };
    expect(result.digestComputedAt).toBe(persisted.computedAt);
    expect(result.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-02")).toBe(false);
  }, 120_000);

  it("AC-3: drifted inputs fall back to a recount — a quoted-stale digestId still refuses FLOW-PUSH-02", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "push-drift-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    await unpushedCommit(repo, "drift.txt", "d\n"); // local tip drift → inputHash mismatch

    const result = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(result.pushed).toBe(false);
    expect(result.attestation).toBe("recount");
    expect(
      result.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-02" && d.severity === "error"),
    ).toBe(true);
  }, 120_000);

  it("AC-5: missing persisted record refuses FLOW-PUSH-15 naming flow.digest", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "push-missing-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    await rm(digestFilePath(repo, digest.digestId), { force: true });

    const result = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(result.pushed).toBe(false);
    const d = result.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-15");
    expect(d).toBeDefined();
    expect(d!.severity).toBe("error");
    expect(d!.message).toContain("flow.digest");
  }, 120_000);

  it("AC-5: an unknown-schema persisted record refuses FLOW-PUSH-15", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "push-unknown-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    await writeFile(digestFilePath(repo, digest.digestId), JSON.stringify({ schema: "nope" }));

    const result = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(result.pushed).toBe(false);
    expect(result.diagnostics.some((x) => x.ruleId === "FLOW-PUSH-15")).toBe(true);
  }, 120_000);

  it("a forged persisted payload refuses FLOW-PUSH-15 — the file must preimage the quoted id", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "push-forged-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });
    // Session-writable forgery: keep the honest inputHash + id, swap the
    // payload's develop tip for a session-authored evil commit.
    const evil = (await gitExec(repo, ["rev-parse", "main"])).stdout.trim();
    const file = digestFilePath(repo, digest.digestId);
    const honest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const forgedDigest = {
      ...(honest["digest"] as Record<string, unknown>),
      develop: { local: evil, remote: null, ahead: 1 },
    };
    await writeFile(file, JSON.stringify({ ...honest, digest: forgedDigest }));

    const result = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
    expect(result.pushed).toBe(false);
    const d = result.diagnostics.find((x) => x.ruleId === "FLOW-PUSH-15");
    expect(d).toBeDefined();
    expect(d!.message).toContain("preimage");
  }, 120_000);

  it("--recount bypasses the persisted file and reports the recount", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "push-recount-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const digest = await collectDigest(repo, ambientIo, { fetch: false });

    const result = await pushFlow(repo, ambientIo, {
      digest: digest.digestId,
      dryRun: false,
      recount: true,
    });
    expect(result.pushed).toBe(true);
    expect(result.attestation).toBe("recount");
    expect(result.digestComputedAt).toBeDefined();
  }, 120_000);
});
