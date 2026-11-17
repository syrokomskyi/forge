/*
<MODULE_CONTRACT>
<purpose>Parity between forge's EVIDENCE_GIT_QUERIES mirror (os/flow/git.ts)
and the shared READ_ONLY_GIT_QUERIES table (werkstatt-shared
kernel/workspace-io.ts): the evidence channel may never admit an argv the
shared read-only judge would refuse — its only extra is the pinned fetch
form collectDigest runs.</purpose>
</MODULE_CONTRACT>
*/

import { describe, expect, it } from "vitest";

import {
  isReadOnlyGitQuery,
  READ_ONLY_GIT_QUERIES,
} from "@warpgogol/werkstatt-shared/kernel/workspace-io";

import { isEvidenceGitQuery } from "../git.ts";

const corpus: string[][] = [
  ["--version"],
  ["rev-parse", "--verify", "--quiet", "HEAD"],
  ["rev-parse", "--show-toplevel"],
  ["worktree", "list", "--porcelain"],
  ["ls-files"],
  ["ls-tree", "HEAD", "--", "forge.yaml"],
  ["cat-file", "-e", "HEAD:x"],
  ["rev-list", "--reverse", "a..b"],
  ["rev-list", "develop", "--not", "--remotes=origin"],
  ["rev-list", "--output=/tmp/x", "a..b"],
  ["merge-base", "--is-ancestor", "a", "b"],
  ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
  ["show-ref"],
  ["describe", "--tags"],
  ["status", "--porcelain", "-uall"],
  ["log", "-1", "--format=%s", "HEAD"],
  ["log", "--format=%(trailers:only)", "HEAD"],
  ["log", "--ext-diff", "HEAD"],
  ["log", "--output=/tmp/x", "HEAD"],
  ["diff", "--name-only", "a..b"],
  ["diff", "--ext-diff", "a..b"],
  ["show", "HEAD:forge.yaml"],
  ["show", "--output=/tmp/x", "HEAD"],
  ["symbolic-ref", "--short", "-q", "HEAD"],
  ["symbolic-ref", "-d", "HEAD"],
  ["symbolic-ref", "a", "b", "c"],
  ["config", "--get", "remote.origin.url"],
  ["config", "--get-all", "x"],
  ["config", "--get-regexp", "^url\\."],
  ["config", "user.email", "a@b"],
  ["config", "--unset", "x"],
  ["remote", "get-url", "origin"],
  ["remote", "get-url", "--push", "origin"],
  ["ls-remote", "origin", "refs/heads/develop"],
  ["ls-remote", "--get-url", "origin"],
  ["ls-remote", "--tags", "origin"],
  ["ls-remote", "--upload-pack=/tmp/x", "origin"],
  ["ls-remote", "-u", "x", "origin"],
  ["branch", "--show-current"],
  ["branch", "--list", "-d", "x"],
  ["branch", "-d", "x"],
  ["fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"],
  ["fetch", "origin"],
  ["fetch", "--upload-pack=/tmp/x", "origin"],
  ["fetch", "-u", "x", "origin"],
  ["push", "origin", "a:b"],
  ["clone", "a", "b"],
  ["checkout", "x"],
  ["commit", "-m", "x"],
  ["update-ref", "a", "b"],
  ["add", "x"],
  ["tag", "x"],
  ["--git-dir", "/tmp/x", "rev-parse", "HEAD"],
  ["-c", "core.sshCommand=x", "fetch", "origin"],
];

describe("isEvidenceGitQuery — parity with the shared read-only table", () => {
  for (const argv of corpus) {
    it(`git ${argv.join(" ")}`, () => {
      const ev = isEvidenceGitQuery(argv);
      const ro = isReadOnlyGitQuery("git", argv);
      const fetchForbidden = argv.some(
        (a) =>
          a.startsWith("--upload-pack") ||
          a.startsWith("--exec") ||
          (/^-[^-]/.test(a) && a.includes("u")),
      );
      const expected = ro || (argv[0] === "fetch" && !fetchForbidden);
      // The evidence table may admit ONLY what the shared read-only table
      // admits — plus a bounded fetch, the one remote-refresh op the
      // channel runs (upload-pack/exec stay forbidden there too).
      // Anything wider is a trust-boundary hole (CX-70 class).
      expect(ev, `evidence admits argv the shared table refuses: ${argv.join(" ")}`).toBe(expected);
    });
  }

  it("admits every READ_ONLY prefix shape the channel actually uses", () => {
    // Sanity: the mirror is not accidentally narrower — every shared table
    // prefix that appears as an exact argv admits on the evidence channel.
    for (const q of READ_ONLY_GIT_QUERIES) {
      const minimal = [...q.prefix];
      expect(isEvidenceGitQuery(minimal), `prefix ${q.prefix.join(" ")} refused`).toBe(
        isReadOnlyGitQuery("git", minimal),
      );
    }
  });
});
