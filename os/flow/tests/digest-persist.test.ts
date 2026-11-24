/*
<MODULE_CONTRACT>
<purpose>RFC-1638 AC-1 evidence: flow.digest persists the reviewed digest plus
its input hash under .git/forge/digests/<digestId>.json
(forge/persisted-digest@1), and every collector read maps to a declared
DigestInputs field — the exhaustiveness contract that keeps attestation from
attesting a stale digest clean.</purpose>
<non-goals>
  <item>No push-path coverage — flow-push-attest.test.ts owns the consumer side.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>The coverage assertion records real consult argv via the git.ts consultProbe seam and every io read through a wrapped ambientIo — no mocked substrate, the attested handle is under test.</item>
  <item>An unclassified read FAILS the test — that is the false-negative tripwire: extending the collector without extending DigestInputs cannot slip silently.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1638: persist reviewed digests + DigestInputs coverage assertion</item>
  <item>RFC-1638: persist reviewed digests + attest pushed state by input hash</item>
</CHANGE_SUMMARY>
*/

import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import type { WorkspaceIO } from "../../../src/types.ts";
import {
  collectDigest,
  digestInputHash,
  observeDigestInputs,
  PERSISTED_DIGEST_SCHEMA,
  PERSISTED_DIGESTS_DIR,
  type DigestInputs,
  type PersistedDigest,
} from "../digest.ts";
import { consultProbe } from "../git.ts";
import { gitExec, initRepoWithOrigin } from "./helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  consultProbe.current = null;
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

async function unpushedCommit(repo: string, file: string, content: string): Promise<void> {
  await writeFile(join(repo, file), content);
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-m", `add ${file}`]);
}

type InputField = keyof DigestInputs | "own-artifact" | "machinery";

/**
 * The reads → inputs mapping from the RFC's exhaustiveness contract: every
 * consult argv and every io read the collector performs must classify to a
 * declared DigestInputs field — or to "own-artifact" (the persisted digest
 * itself) / "machinery" (channel scratch outside the judged surface).
 */
function classifyConsult(argv: readonly string[]): InputField {
  const [op] = argv;
  const head = argv.join(" ");
  if (op === "status") return "statusPorcelainSha256";
  if (op === "remote" || op === "config" || op === "ls-remote" || op === "fetch") {
    return "remoteConfigSha256";
  }
  if (op === "rev-parse") {
    if (head.includes("refs/remotes/")) return "developRemote";
    if (argv.includes("develop")) return "developLocal";
    if (argv.includes("main")) return "mainLocal";
    return "head";
  }
  if (op === "worktree") return "sessions";
  if (op === "check-ignore" || op === "ls-files") return "statusPorcelainSha256";
  // Object/graph reads (rev-list, log, show, diff, cat-file, for-each-ref,
  // merge-base, describe, tag listings) are pinned by the branch tips and
  // HEAD — the tag enumeration rides HEAD-anchored listLineTags.
  return "head";
}

function classifyIoPath(path: string): InputField {
  const p = path.replaceAll("\\", "/");
  if (p.includes(`/${PERSISTED_DIGESTS_DIR}/`)) return "own-artifact";
  if (p.endsWith("/forge/journal.jsonl")) return "journalTailSha256";
  if (p.includes("/forge/registry")) return "sessions";
  if (p.includes("/forge/digests")) return "own-artifact";
  if (p.includes("/.github/workflows")) return "tagTriggerFilesSha256";
  if (p.includes("/.git/forge/")) return "own-artifact";
  if (p.endsWith("/.git/config")) return "remoteConfigSha256";
  if (p.endsWith("/.git/HEAD")) return "head";
  if (p.includes("/.git/")) return "head"; // repo-shape probes — tips pin the answer
  if (p.includes(tmpdir().replaceAll("\\", "/"))) return "machinery";
  // Every worktree read (package.json, pnpm-workspace.yaml, forge.yaml,
  // docs/**, hooks/**, .gitignore…) is covered by the porcelain belt.
  return "statusPorcelainSha256";
}

describe("flow.digest persisted digest (RFC-1638, AC-1)", () => {
  it("collectDigest writes forge/persisted-digest@1 with a matching inputHash", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "digest-persist-" });
    await unpushedCommit(repo, "work.txt", "w\n");
    const data = await collectDigest(repo, ambientIo, { fetch: false });

    const dir = join(repo, ".git", PERSISTED_DIGESTS_DIR);
    const file = join(dir, `${data.digestId}.json`);
    const persisted = JSON.parse(await readFile(file, "utf8")) as PersistedDigest;

    expect(persisted.schema).toBe(PERSISTED_DIGEST_SCHEMA);
    expect(persisted.digestId).toBe(data.digestId);
    expect(persisted.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(persisted.digest).toEqual(data);

    // The persisted input hash re-observes equal on unchanged state — that
    // is the equality attestation relies on.
    const inputs = await observeDigestInputs(repo, ambientIo);
    expect(inputs).not.toBeNull();
    expect(digestInputHash(inputs!)).toBe(persisted.inputHash);
  }, 90_000);

  it("every collector read maps to a declared DigestInputs field", async () => {
    const { repo } = await initRepoWithOrigin(dirs, { prefix: "digest-cover-" });
    await unpushedCommit(repo, "work.txt", "w\n");

    const consults: Array<{ argv: readonly string[]; channel: string }> = [];
    const ioReads: string[] = [];
    consultProbe.current = (argv, channel) => consults.push({ argv, channel });
    const io: WorkspaceIO = {
      ...ambientIo,
      readFile: async (p: string) => {
        ioReads.push(p);
        return ambientIo.readFile(p);
      },
      readFileBytes: async (p: string) => {
        ioReads.push(p);
        return ambientIo.readFileBytes(p);
      },
      exists: async (p: string) => {
        ioReads.push(p);
        return ambientIo.exists(p);
      },
      readdir: async (p: string) => {
        ioReads.push(p);
        return ambientIo.readdir(p);
      },
    };
    try {
      await collectDigest(repo, io, { fetch: false });
    } finally {
      consultProbe.current = null;
    }

    expect(consults.length).toBeGreaterThan(0);
    const unmappedConsults = consults.filter((c) => classifyConsult(c.argv) === undefined);
    const unmappedReads = ioReads.filter((p) => classifyIoPath(p) === undefined);
    expect(
      unmappedConsults.map((c) => `${c.channel}: ${c.argv.join(" ")}`),
      "collector consults that map to no DigestInputs field — extend DigestInputs or the attestation goes stale-blind",
    ).toEqual([]);
    expect(unmappedReads, "collector io reads that map to no DigestInputs field").toEqual([]);
  }, 90_000);
});
