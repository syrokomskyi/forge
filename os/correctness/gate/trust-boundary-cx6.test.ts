/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-6 verification of the external
verification trust boundary against export candidate db767b394. Every probe
FAILS when the counterexample is live and PASSES when closed; numbering
continues from CX-84 (round 5 reported CX-72..CX-84).

Round-6 attack surfaces (opened or left over by the r5 hardening):
  - remote.<name>.uploadpack — a repo-config transport PROGRAM the preflight
    neither refuses (REFUSE list covers proxy|proxyauthmethod|vcs|promisor|
    partialCloneFilter only) nor pins (remote.* is KEEP): git execs it on
    ls-remote/fetch inside the trusted channel — same class as CX-72/74.
  - ~/.ssh/config (pw_dir, not $HOME) ProxyCommand — OpenSSH reads the
    passwd-db home, so the env allowlist never reaches this file. Every
    core.sshCommand/ssh.* lever is refused while the ssh binary's own
    config is not judged at all — a session ProxyCommand execs inside
    the trusted ls-remote/fetch.
  - the predictable lazy hooks dir forge-evidence-hooks-<pid> — mkdirSync is
    recursive-silent, never cleans or verifies ownership: a pre-planted
    reference-transaction hook runs inside the pinned fetch.
  - .git/objects/info/commit-graph — fabricated parent edges are trusted by
    single-tip rev-list walks while ranged walks and merge-base use objects;
    a session graph hides the verifier-trailer commit from the push scan's
    `rev-list <branch>` when origin lacks that branch, and a no-op fetch
    does not heal the graph.
  - `rev-parse --git-path` output is not NUL-terminated — an embedded
    newline in the resolved gitdir (linked-worktree commondir under a
    newline-bearing path) splits one answer into two lines and misaligns
    every positional shape check: info/grafts at its true path goes unread.
  - objects/info/alternates whitespace-only lines — git reads EVERY line
    literally (a "   " line is a real directory path under objects/) while
    the judge requires trim-nonempty: a foreign object store hides behind
    a whitespace-only alternates line.
  - workflow heredoc bodies — `cat <<EOF` + gate lines are stdin to cat,
    never executed; the line-wise runInvokes counts them as invocations.
  - argv short forms — `-g`/`--reflog` on log/rev-list read the
    session-fabricable reflog while only the long --walk-reflogs spelling
    is forbidden (git accepts --reflog as an alias).
  - scaffold on a BROKEN .github symlink — existsSync follows the dead link
    to "absent", the nearest-existing-ancestor walk approves the root,
    then mkdirSync throws ENOENT: unhandled crash, not a structured refuse.
</purpose>
<non-goals>
  <item>Not a contract source of truth — src/utils/verifier-git.ts, os/flow/**, src/onboarding/trust-boundary.ts own behaviour.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { scaffoldTrustBoundary } from "../../../src/onboarding/trust-boundary.ts";
import { setVerifierGitBinForTests } from "../../../src/utils/verifier-git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { evidencePreflight, gitEvidence, isEvidenceGitQuery } from "../../flow/git.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { gitExec, initRepoWithOrigin, installFakePrimaryForge } from "../../flow/tests/helpers.ts";

const dirs: string[] = [];
/** Byte-exact backup of the user's real ssh config when a probe must plant a
 *  Match block — `undefined` = untouched, `null` = file was absent. */
const sshConfigBackup: { file: string; content: Buffer | null | undefined } = {
  file: path.join(os.homedir(), ".ssh", "config"),
  content: undefined,
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (sshConfigBackup.content !== undefined) {
    try {
      if (sshConfigBackup.content === null) rmSync(sshConfigBackup.file, { force: true });
      else writeFileSync(sshConfigBackup.file, sshConfigBackup.content);
    } catch {
      /* best effort restore */
    }
    sshConfigBackup.content = undefined;
  }
  setVerifierGitBinForTests(undefined);
});

const CLEAN_PATH = (process.env["PATH"] ?? "")
  .split(path.delimiter)
  .filter((d) => d.length > 0 && !existsSync(path.join(d, "git-wrapper.sh")))
  .join(path.delimiter);
beforeAll(() => {
  process.env["PATH"] = CLEAN_PATH;
});

const gitIn = (root: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
  });

/** Commit a file carrying one verifier trailer pair, return its sha. */
async function trailerCommit(repo: string, file: string, trailerLine: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "x\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", `session work\n\n${trailerLine}`]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

/** A plain (trailer-free) commit on top of HEAD, return its sha. */
async function cleanCommit(repo: string, file: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "y\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", "clean follow-up"]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

const adoptedWorkflow = (body: string): boolean => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx6-scaffold-"));
  dirs.push(root);
  const rel = ".github/workflows/forge-policy.yml";
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
  return scaffoldTrustBoundary(root, "@operator").skipped.some((s) => s.includes(rel));
};

const WORKFLOW_HEAD = `name: forge-policy
on: [push, pull_request]
jobs:
  policy-surface:
    runs-on: ubuntu-latest
    steps:
`;

/**
 * Patch one parent edge inside .git/objects/info/commit-graph: rewrite
 * `tipSha`'s first parent position to `newParentSha`'s graph position,
 * collapse the second parent to GRAPH_PARENT_NONE, and re-seal the
 * trailer checksum. Format-valid enough that rev-list/log consume it
 * (verify-commit-graph reports the divergence — a read never asks).
 */
function patchCommitGraphParent(repo: string, tipSha: string, newParentSha: string): boolean {
  const graphPath = path.join(repo, ".git", "objects", "info", "commit-graph");
  if (!existsSync(graphPath)) return false;
  const data = Buffer.from(readFileSync(graphPath));
  if (data.subarray(0, 4).toString("latin1") !== "CGPH") return false;
  const nch = data[6]!;
  const entries: Array<[string, number]> = [];
  for (let i = 0; i < nch; i++) {
    const o = 8 + i * 12;
    entries.push([data.subarray(o, o + 4).toString("latin1"), Number(data.readBigUInt64BE(o + 4))]);
  }
  entries.sort((a, b) => a[1] - b[1]);
  const at = (id: string) => entries.findIndex(([c]) => c === id);
  const oidlOff = entries[at("OIDL")]?.[1];
  const cdatOff = entries[at("CDAT")]?.[1];
  if (oidlOff === undefined || cdatOff === undefined) return false;
  const oidlEnd = entries[at("OIDL") + 1]?.[1] ?? data.length - 20;
  const cdatEnd = entries[at("CDAT") + 1]?.[1] ?? data.length - 20;
  const n = (oidlEnd - oidlOff) / 20;
  const recsz = (cdatEnd - cdatOff) / n;
  if (!Number.isInteger(n) || !Number.isInteger(recsz) || recsz < 28) return false;
  const oids: string[] = [];
  for (let i = 0; i < n; i++) {
    oids.push(data.subarray(oidlOff + i * 20, oidlOff + (i + 1) * 20).toString("hex"));
  }
  const di = oids.indexOf(tipSha);
  const bi = oids.indexOf(newParentSha);
  if (di === -1 || bi === -1) return false;
  data.writeUInt32BE(bi, cdatOff + di * recsz + 20);
  data.writeUInt32BE(0x70000000, cdatOff + di * recsz + 24);
  const sealed = createHash("sha1")
    .update(data.subarray(0, data.length - 20))
    .digest();
  sealed.copy(data, data.length - 20);
  chmodSync(graphPath, 0o644);
  writeFileSync(graphPath, data);
  chmodSync(graphPath, 0o444);
  return true;
}

// ===========================================================================
// A. transport-program levers the REFUSE list misses
// ===========================================================================

describe("RFC-1616 r6 — repo-config transport programs inside evidence", () => {
  it(
    "CX-85: `remote.origin.uploadpack` is kept visible (remote.* = KEEP) but never refused — git execs the session's program on `ls-remote`/`fetch` inside the trusted channel (CX-72/74 class reopened)",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx6-uppack-" });
      const marker = path.join(parent, "up.marker");
      const up = path.join(parent, "up.sh");
      writeFileSync(
        up,
        `#!/bin/sh\necho UPLOADPACK-EXEC >> ${JSON.stringify(marker)}\nexec /usr/bin/git upload-pack "$@"\n`,
      );
      chmodSync(up, 0o755);
      await gitExec(repo, ["config", "remote.origin.uploadpack", up]);
      const ls = await gitEvidence(repo, ["ls-remote", "origin", "refs/heads/main"]);
      expect
        .soft(
          ls.stderr.startsWith("EVIDENCE-REFUSED"),
          `the evidence channel did not refuse remote.origin.uploadpack (stderr=${ls.stderr.slice(0, 120)})`,
        )
        .toBe(true);
      expect
        .soft(
          existsSync(marker),
          "a repo-config transport program executed inside the trusted ls-remote",
        )
        .toBe(false);
      const marker2 = path.join(parent, "up2.marker");
      writeFileSync(
        up,
        `#!/bin/sh\necho FETCH-EXEC >> ${JSON.stringify(marker2)}\nexec /usr/bin/git upload-pack "$@"\n`,
      );
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect
        .soft(
          fetch.stderr.startsWith("EVIDENCE-REFUSED"),
          `fetch also accepted remote.origin.uploadpack (stderr=${fetch.stderr.slice(0, 120)})`,
        )
        .toBe(true);
      expect
        .soft(existsSync(marker2), "the pinned fetch exec'd the session upload-pack program")
        .toBe(false);
    },
  );

  it(
    "CX-86: `~/.ssh/config` (getpwuid, not $HOME) is outside the judged surface — a session `Match host` ProxyCommand execs inside the trusted ls-remote while every git-config ssh lever is already refused",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx6-sshcfg-" });
      const marker = path.join(parent, "ssh.marker");
      const proxy = path.join(parent, "proxy.sh");
      writeFileSync(
        proxy,
        `#!/bin/sh\necho PROXY-EXEC "$@" >> ${JSON.stringify(marker)}\nexit 1\n`,
      );
      chmodSync(proxy, 0o755);
      const host = `probe-r6-${process.pid}.invalid`;
      // Session scope includes the account's own files — plant a targeted
      // Match block in the real config; byte-exact restore in afterEach.
      sshConfigBackup.content = existsSync(sshConfigBackup.file)
        ? Buffer.from(readFileSync(sshConfigBackup.file))
        : null;
      writeFileSync(
        sshConfigBackup.file,
        `${sshConfigBackup.content?.toString("utf8") ?? ""}\nMatch host ${host}\n  ProxyCommand ${proxy} %h %p\n`,
      );
      await gitExec(repo, ["config", "remote.origin.url", `ssh://git@${host}/repo.git`]);
      const ls = await gitEvidence(repo, ["ls-remote", "origin"]);
      expect
        .soft(
          ls.stderr.startsWith("EVIDENCE-REFUSED") || ls.exitCode !== 0,
          "the ssh:// read did not even fail closed",
        )
        .toBe(true);
      expect(
        existsSync(marker),
        `the user's ~/.ssh/config ProxyCommand executed inside the trusted evidence channel ` +
          `(ls-remote exit=${ls.exitCode}, stderr=${ls.stderr.slice(0, 160)})`,
      ).toBe(false);
    },
  );

  it(
    "CX-87: the lazy `forge-evidence-hooks-<pid>` dir is predictable — a session pre-plants `reference-transaction` there and mkdirSync's silent recursive keep lets the pinned fetch exec it inside the trusted channel",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx6-hookdir-" });
      const hooksDir = path.join(os.tmpdir(), `forge-evidence-hooks-${process.pid}`);
      const marker = path.join(parent, "hook.marker");
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, "reference-transaction"),
        `#!/bin/sh\necho HOOK-FIRED "$1" >> ${JSON.stringify(marker)}\n`,
      );
      chmodSync(path.join(hooksDir, "reference-transaction"), 0o755);
      // Force one tracking-ref update so the hook must fire on the pinned fetch.
      await gitExec(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect.soft(fetch.exitCode, "fixture: the pinned fetch argv failed").toBe(0);
      expect(
        existsSync(marker),
        "a pre-planted hook in forge-evidence-hooks-<pid> executed inside the trusted fetch — " +
          "the lazy hooks dir is predictable and never verified",
      ).toBe(false);
      rmSync(hooksDir, { recursive: true, force: true });
    },
  );
});

// ===========================================================================
// B. committed-object topology levers the shape check misses
// ===========================================================================

describe("RFC-1616 r6 — session-writable history topology, second front", () => {
  it(
    "CX-88: `.git/objects/info/commit-graph` fabricated edges are trusted by single-tip rev-list — a session graph hides the trailer commit from scanVerifierTrailers' `rev-list <branch>` when origin lacks develop; pushFlow ships it unflagged",
    { timeout: 120_000 },
    async () => {
      const parent = mkdtempSync(path.join(os.tmpdir(), "cx6-cgraph-"));
      dirs.push(parent);
      const repo = path.join(parent, "repo");
      const origin = path.join(parent, "origin.git");
      mkdirSync(repo, { recursive: true });
      gitIn(repo, ["init", "-b", "main"]);
      await gitExec(repo, ["config", "user.email", "flow-test@example.invalid"]);
      await gitExec(repo, ["config", "user.name", "flow-test"]);
      await gitExec(repo, ["config", "commit.gpgsign", "false"]);
      writeFileSync(
        path.join(repo, "forge.yaml"),
        `schema: "forge/workspace@1"\npush:\n  expectedRemote: ${JSON.stringify(origin)}\n`,
      );
      writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
      writeFileSync(path.join(repo, "seed.txt"), "seed\n");
      await gitExec(repo, ["add", "-A"]);
      await gitExec(repo, ["commit", "-qm", "seed"]);
      await gitExec(repo, ["branch", "develop", "HEAD"]);
      gitIn(parent, ["init", "--bare", "-b", "main", "origin.git"]);
      await gitExec(repo, ["remote", "add", "origin", origin]);
      await gitExec(repo, ["switch", "develop"]);
      // origin advertises ONLY main — develop's remote tip stays null, so the
      // push scan walks `rev-list develop` (the single-tip, graph-trusting form).
      await gitExec(repo, ["push", "-u", "origin", "main"]);
      await installFakePrimaryForge(repo);
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const cSha = await cleanCommit(repo, "clean.txt");
      const base = gitIn(repo, ["rev-parse", `${tSha}^`]).trim();
      gitIn(repo, ["commit-graph", "write", "--reachable"]);
      expect(
        patchCommitGraphParent(repo, cSha, base),
        "fixture: could not forge the commit-graph edge",
      ).toBe(true);
      const rawWalk = gitIn(repo, ["rev-list", "develop"]).trim().split("\n");
      expect
        .soft(rawWalk.includes(tSha), "fixture: raw rev-list did not hide the trailer")
        .toBe(false);
      const pre = await evidencePreflight(repo);
      expect
        .soft(
          pre === null || (pre.refusedKeys.length === 0 && pre.shapeViolations.length === 0),
          "preflight refused the repo — the commit-graph lever was caught some other way",
        )
        .toBe(true);
      const ev = await gitEvidence(repo, ["rev-list", "develop"]);
      expect
        .soft(
          ev.stdout.includes(tSha),
          `trusted rev-list served the forged graph topology — trailer ${tSha.slice(0, 12)} hidden`,
        )
        .toBe(true);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      // The trusted digest under-counts: two unpushed commits (T + C) collapse
      // to one because the forged graph swallows T on the ranged walk too.
      expect
        .soft(
          (digest as unknown as { develop: { ahead: number } }).develop.ahead,
          "the digest's unpushed count was computed on the forged graph topology (T invisible)",
        )
        .toBe(2);
      // Boundary: the scan must report the trailer commit — whether push then
      // ships it or breaks on the inconsistent pack is transport detail.
      expect
        .soft(
          (data.verifierTrailerCommits ?? []).some((h) => h.sha === tSha),
          `the trailer scan stayed blind to the graph-hidden commit ` +
            `(verifierTrailerCommits=${JSON.stringify((data.verifierTrailerCommits ?? []).map((h) => h.sha))}, ` +
            `pushed=${data.pushed}, diagnostics=${JSON.stringify(data.diagnostics.map((d) => d.ruleId))})`,
        )
        .toBe(true);
    },
  );

  it(
    "CX-89: `--git-path` output is newline-blind — a `\\n` inside the resolved gitdir splits one answer into two lines; the positional shape map reads wrong paths and non-empty info/grafts goes undetected",
    { timeout: 120_000 },
    async () => {
      const parent = mkdtempSync(path.join(os.tmpdir(), "cx6-gitpath-"));
      dirs.push(parent);
      const mainRepo = path.join(parent, "evil\nmain", "repo");
      mkdirSync(mainRepo, { recursive: true });
      gitIn(mainRepo, ["init", "-b", "main"]);
      await gitExec(mainRepo, ["config", "user.email", "flow-test@example.invalid"]);
      await gitExec(mainRepo, ["config", "user.name", "flow-test"]);
      for (const [f, c] of [
        ["a.txt", "a"],
        ["t.txt", "t"],
        ["c.txt", "c"],
      ]) {
        writeFileSync(path.join(mainRepo, f!), `${c}\n`);
        await gitExec(mainRepo, ["add", f!]);
        await gitExec(mainRepo, ["commit", "-qm", `commit ${c}`]);
      }
      const wt = path.join(parent, "wt");
      await gitExec(mainRepo, ["worktree", "add", wt, "-b", "wt"]);
      const A = gitIn(wt, ["rev-parse", "wt~2"]).trim();
      const T = gitIn(wt, ["rev-parse", "wt~1"]).trim();
      const gitDir = gitIn(wt, ["rev-parse", "--git-common-dir"]).trim();
      mkdirSync(path.join(gitDir, "info"), { recursive: true });
      writeFileSync(
        path.join(gitDir, "info", "grafts"),
        `${gitIn(wt, ["rev-parse", "wt"]).trim()} ${A}\n`,
      );
      // Fixture premise (r6-port): the newline-blindness demonstration
      // rides the raw session channel — on the trusted channel the
      // preflight already refuses this repo, so the same spawn answers
      // EVIDENCE-REFUSED instead of the misaligned output it once served.
      const gitPaths = gitIn(wt, [
        "rev-parse",
        "--git-path",
        "info/grafts",
        "--git-path",
        "objects/info/alternates",
        "--git-path",
        "shallow",
        "--git-path",
        "info/exclude",
      ]);
      expect
        .soft(
          gitPaths.trim().split("\n").length > 4,
          "fixture: --git-path output did not split on the embedded newline",
        )
        .toBe(true);
      const pre = await evidencePreflight(wt);
      expect
        .soft(
          pre !== null && pre.shapeViolations.length > 0,
          `grafts at the real gitdir went undetected via a newline-bearing --git-path answer ` +
            `(violations=${JSON.stringify(pre?.shapeViolations)})`,
        )
        .toBe(true);
      const list = await gitEvidence(wt, ["rev-list", `${A}..wt`]);
      expect(
        list.exitCode !== 0 || list.stdout.includes(T),
        `grafted topology hid a commit on the trusted channel (exit=${list.exitCode}, out=${JSON.stringify(list.stdout)})`,
      ).toBe(true);
    },
  );

  it(
    "CX-91: `objects/info/alternates` whitespace-only lines — git resolves `   ` as the literal path `.git/objects/   ` while the judge requires trim-nonempty: a foreign object store hides behind a line of spaces",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx6-altsp-" });
      const blobSha = gitIn(
        repo,
        ["hash-object", "-w", "--stdin", "-t", "blob"],
        "FORGED\n",
      ).trim();
      const altDir = path.join(repo, ".git", "objects", "   ");
      mkdirSync(path.join(altDir, blobSha.slice(0, 2)), { recursive: true });
      execFileSync("cp", [
        path.join(repo, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2)),
        path.join(altDir, blobSha.slice(0, 2), blobSha.slice(2)),
      ]);
      rmSync(path.join(repo, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2)));
      writeFileSync(path.join(repo, ".git", "objects", "info", "alternates"), "   \n");
      const pre = await evidencePreflight(repo);
      expect
        .soft(
          pre !== null && pre.shapeViolations.includes("objects/info/alternates"),
          `a whitespace-only alternates line defeated the shape check ` +
            `(violations=${JSON.stringify(pre?.shapeViolations)})`,
        )
        .toBe(true);
      const read = await gitEvidence(repo, ["cat-file", "-p", blobSha]);
      expect(
        read.exitCode !== 0 || !read.stdout.includes("FORGED"),
        `the trusted channel resolved a foreign object through the hidden alternates store ` +
          `(exit=${read.exitCode}, stdout=${read.stdout.slice(0, 60)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// C. workflow control flow the line judge cannot see — round 2
// ===========================================================================

describe("RFC-1616 r6 — adoption of dead enforcement, heredoc front", () => {
  it(
    "CX-90: `cat <<EOF` heredoc bodies — the gate lines are stdin to `cat`, never executed; the line-wise runInvokes counts each `forge <cmd>` line as an invocation → a never-running CI is adopted",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<'EOF'
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted a workflow whose gate lines are heredoc stdin — never executed",
      ).toBe(false);
    },
  );

  it(
    "CX-90b: a while-read loop fed by heredoc keeps every gate line matching while nothing runs",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          while IFS= read -r line; do printf '%s\\n' "$line"; done <<'EOF'
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted gate lines inside a while-read heredoc",
      ).toBe(false);
    },
  );
});

// ===========================================================================
// D. argv allowlist short forms
// ===========================================================================

describe("RFC-1616 r6 — reflog/short-form argv leaks", () => {
  it(
    "CX-92: `log -g` / `log --reflog` / `rev-list -g` / `merge-base --fork-point` are admitted — the forbid lists cover only the long `--walk-reflogs` spelling, so session-fabricable reflog data reaches the trusted channel",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx6-reflog-" });
      expect
        .soft(
          isEvidenceGitQuery(["rev-list", "--walk-reflogs", "HEAD@{0}"]),
          "control: the long --walk-reflogs spelling must stay refused",
        )
        .toBe(false);
      for (const argv of [
        ["log", "-g", "HEAD@{0}"],
        ["log", "--reflog", "HEAD@{0}"],
        ["rev-list", "-g", "HEAD@{0}"],
        ["show", "-g", "HEAD@{0}"],
        ["merge-base", "--fork-point", "HEAD"],
      ]) {
        expect
          .soft(
            isEvidenceGitQuery(argv),
            `the evidence predicate admits ${argv.join(" ")} — a session-reflog read`,
          )
          .toBe(false);
      }
      const r = await gitEvidence(repo, ["log", "-g", "--format=%gs", "-2"]);
      expect(
        r.exitCode !== 0 || r.stderr.startsWith("EVIDENCE-REFUSED"),
        `gitEvidence spawned a reflog walk — output reflects session-forged .git/logs ` +
          `(exit=${r.exitCode}, stdout=${r.stdout.slice(0, 80)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// E. scaffold fs edges
// ===========================================================================

describe("RFC-1616 r6 — scaffold filesystem edges", () => {
  it(
    "CX-93: a BROKEN `.github` symlink — destContained follows the dead link to 'absent', the ancestor walk approves the root, then mkdirSync throws ENOENT: unhandled crash instead of a structured conflict",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx6-broken-"));
      dirs.push(root);
      symlinkSync(path.join(root, "does-not-exist"), path.join(root, ".github"));
      let threw: unknown = null;
      let out: ReturnType<typeof scaffoldTrustBoundary> | null = null;
      try {
        out = scaffoldTrustBoundary(root, "@operator");
      } catch (e) {
        threw = e;
      }
      expect(
        threw === null,
        `scaffoldTrustBoundary crashed on a broken .github symlink: ${String(threw)}`,
      ).toBe(true);
      expect
        .soft(
          out !== null &&
            (out.conflicts.length > 0 ||
              out.created.some((c) => c.includes(".github")) ||
              out.skipped.length > 0),
          "a broken-symlinked boundary ancestor produced neither conflict nor install",
        )
        .toBe(true);
    },
  );
});

// ===========================================================================
// F. hold probes — representative r5 fixes still closed
// ===========================================================================

describe("RFC-1616 r6 — closed-surface re-verification", () => {
  it(
    "R6-R1: CX-72 stays dead — `core.gitProxy` still refuses the channel",
    { timeout: 60_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx6-hold-proxy-" });
      const fake = path.join(parent, "f.sh");
      writeFileSync(fake, "#!/bin/sh\nexit 0\n");
      chmodSync(fake, 0o755);
      await gitExec(repo, ["config", "core.gitProxy", fake]);
      const r = await gitEvidence(repo, ["rev-parse", "HEAD"]);
      expect(r.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
      expect(r.stderr).toContain("core.gitproxy");
    },
  );

  it(
    "R6-R2: CX-79 stays dead — non-empty info/grafts still refuses the channel",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx6-hold-graft-" });
      await cleanCommit(repo, "extra.txt");
      const tip = gitIn(repo, ["rev-parse", "develop"]).trim();
      const base = gitIn(repo, ["rev-parse", "develop^"]).trim();
      mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
      writeFileSync(path.join(repo, ".git", "info", "grafts"), `${tip} ${base}\n`);
      const r = await gitEvidence(repo, ["rev-list", "develop"]);
      expect(r.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
      expect(r.stderr).toContain("grafts");
    },
  );

  it(
    "R6-R3: CX-80 stays dead — an expectedRemote-mismatched repoint still errors FLOW-PUSH-14",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx6-hold-anchor-" });
      const fake = path.join(parent, "fake.git");
      gitIn(parent, ["init", "--bare", "-b", "develop", "fake.git"]);
      await gitExec(repo, ["remote", "set-url", "origin", fake]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      expect(digest.diagnostics.some((d) => d.ruleId === "FLOW-PUSH-14")).toBe(true);
      const data = await pushFlow(repo, ambientIo, {
        digest: digest.digestId,
        dryRun: false,
      });
      expect(data.pushed).toBe(false);
    },
  );

  it(
    "R6-R4: CX-84 stays dead — caller extraEnv keeps only locale/temp levers",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx6-hold-env-" });
      const r = await gitEvidence(repo, ["rev-parse", "HEAD"], {
        extraEnv: {
          PATH: "/tmp/evil-bin",
          GIT_DIR: "/tmp/evil-repo",
          http_proxy: "http://evil.invalid:3128",
          LC_ALL: "C",
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBe(40);
    },
  );
});
