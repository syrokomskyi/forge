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
  <item>The coverage assertion records real consult argv via the git.ts consultProbe seam, every io read through a wrapped ambientIo, AND ambient-io reads by monkeypatching ambientIo's methods for the collect window — a read escaping all three channels maps to nothing and FAILS (fail-closed classifiers, no catch-all).</item>
  <item>An unclassified read FAILS the test — that is the false-negative tripwire: extending the collector without extending DigestInputs cannot slip silently.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1638: persist reviewed digests + DigestInputs coverage assertion</item>
  <item>RFC-1638: review round 1 — fail-closed classifiers, ambient-io interception</item>
  <item>RFC-1643: committed verifier-review baseline for flow.push</item>
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
 * The reads → inputs mapping from the RFC's exhaustiveness contract —
 * FAIL-CLOSED: a consult argv this function cannot place maps to
 * `undefined` and fails the coverage assertion.
 */
function classifyConsult(argv: readonly string[]): InputField | undefined {
  const [op] = argv;
  const head = argv.join(" ");
  // Evidence-channel self-capture (RFC-1616 preflight): gitdir/shape
  // resolves, the branch-name probe and the full config dump gate whether a
  // consult is TRUSTED — they never feed digest content, and a drifted
  // surface makes the channel's own re-preflight refuse the consult
  // (observeDigestInputs → null → recount), so the safe direction holds
  // without a DigestInputs field.
  if (
    op === "symbolic-ref" ||
    head.includes("--git-path") ||
    head.includes("--absolute-git-dir") ||
    head.includes("--git-common-dir") ||
    head.includes("--no-includes --list")
  ) {
    return "machinery";
  }
  if (op === "status") return "statusPorcelainSha256";
  if (op === "remote" || op === "ls-remote" || op === "fetch") return "remoteConfigSha256";
  if (op === "config") {
    // Only the remote-identity consults are hashed — anything else read
    // through config escapes remoteConfigSha256.
    return /remote\.|url\.|insteadof|credential|protocol|core\.ssh|http/i.test(head)
      ? "remoteConfigSha256"
      : undefined;
  }
  if (op === "rev-parse") {
    if (head.includes("refs/remotes/")) return "developRemote";
    // RFC-1643: tips resolve fully qualified (`refs/heads/*`).
    if (argv.includes("develop") || argv.includes("refs/heads/develop")) return "developLocal";
    if (argv.includes("main") || argv.includes("refs/heads/main")) return "mainLocal";
    if (argv.includes("HEAD")) return "head";
    return undefined; // any other rev-parse resolves a surface no input pins
  }
  if (op === "worktree") return "sessions";
  if (op === "check-ignore" || op === "ls-files") return "statusPorcelainSha256";
  // Object/graph reads pinned by the recorded branch tips + HEAD.
  if (
    [
      "rev-list",
      "log",
      "show",
      "diff",
      "cat-file",
      "for-each-ref",
      "merge-base",
      "describe",
      "ls-tree",
      "tag",
      "grep",
    ].includes(op)
  ) {
    return "head";
  }
  return undefined;
}

/**
 * io-read path → input field — FAIL-CLOSED. Own-artifact = the persisted
 * digests dir itself; machinery = tmpdir scratch outside the judged
 * surface. Direct node:fs imports the io adapter cannot see (e.g. the
 * ambient `frontmatter-io` alias is intercepted via the monkeypatch below;
 * truly invisible reads would surface only via statusPorcelain changes —
 * the comment documents that residual carve-out).
 */
function classifyIoPath(path: string): InputField | undefined {
  const p = path.replaceAll("\\", "/");
  if (p.includes(`/${PERSISTED_DIGESTS_DIR}/`)) return "own-artifact";
  if (p.includes("/forge/digests/")) return "own-artifact";
  if (p.endsWith("/forge/journal.jsonl")) return "journalTailSha256";
  if (p.includes("/forge/registry")) return "sessions";
  if (p.includes("/.github/workflows")) return "tagTriggerFilesSha256";
  if (p.endsWith("/.git/HEAD")) return "head";
  if (p.includes("/.git/refs/") || p.endsWith("/.git/packed-refs")) return "head";
  if (p.endsWith("/.git/config")) return "remoteConfigSha256";
  if (p.includes("/.git/objects/") || p.includes("/.git/worktrees/")) return "head";
  if (p.includes(tmpdir().replaceAll("\\", "/"))) return "machinery";
  if (p.includes("/node_modules/")) return "machinery";
  // Worktree file reads (forge.yaml, package.json, pnpm-workspace.yaml,
  // docs/**, hooks/**, *.md, .gitignore) — the porcelain belt pins them.
  if (!p.includes("/.git/")) return "statusPorcelainSha256";
  // Any other .git-internal read — index, COMMIT_EDITMSG, hooks state —
  // maps to no input: fail the test so DigestInputs must grow.
  return undefined;
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
    // The preimage member the suppressed tag view cannot reconstruct —
    // the field push-side recompute binds the payload through.
    expect(persisted.releaseTags).toEqual(expect.arrayContaining(data.tags));

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
    // Ambient-io reads (helpers importing `ambientIo` directly — e.g.
    // frontmatter-io's `fs` alias) escape the wrapped adapter; patch the
    // object's methods for the collect window so they record too.
    const ambientReads: string[] = [];
    const originals = {
      readFile: ambientIo.readFile,
      exists: ambientIo.exists,
      readdir: ambientIo.readdir,
    };
    ambientIo.readFile = async (p: string) => {
      ambientReads.push(p);
      return originals.readFile(p);
    };
    ambientIo.exists = async (p: string) => {
      ambientReads.push(p);
      return originals.exists(p);
    };
    ambientIo.readdir = async (p: string) => {
      ambientReads.push(p);
      return originals.readdir(p);
    };
    try {
      await collectDigest(repo, io, { fetch: false });
    } finally {
      consultProbe.current = null;
      ambientIo.readFile = originals.readFile;
      ambientIo.exists = originals.exists;
      ambientIo.readdir = originals.readdir;
    }

    expect(consults.length).toBeGreaterThan(0);
    const unmappedConsults = consults.filter((c) => classifyConsult(c.argv) === undefined);
    const unmappedReads = [...ioReads, ...ambientReads].filter(
      (p) => classifyIoPath(p) === undefined,
    );
    expect(
      unmappedConsults.map((c) => `${c.channel}: ${c.argv.join(" ")}`),
      "collector consults that map to no DigestInputs field — extend DigestInputs or the attestation goes stale-blind",
    ).toEqual([]);
    expect(unmappedReads, "collector io reads that map to no DigestInputs field").toEqual([]);
  }, 90_000);
});
