/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-7 verification of the external
verification trust boundary against export candidate d2f270ad. Every probe
FAILS when the counterexample is live and PASSES when closed; numbering
continues from CX-93 (round 6 reported CX-85..CX-93).

Round-7 attack surfaces (opened or left over by the r6 hardening):
  - remote.<name>.fetch / tagOpt — remote.* is KEEP so the configured
    refspecs/tag-following stand on the trusted channel, and git UNIONS them
    with the pinned command-line refspec: the "read-only + tracking-refresh"
    fetch writes refs/heads/*, refs/tags/* and any session-named namespace
    (CX-81 reopened via config, not argv).
  - objects/info/alternates `  # path` — the judge counts a whitespace-led
    '#' line as a comment; git reads it as a literal alternate dir (only
    col-0 '#' comments there) — a foreign object store hides behind a
    space-indented "comment".
  - `config --get*`/`--list` predicates admit --file/--blob/--worktree —
    an alternate config source answers fabricated values (worktree scope
    reads .git/config.worktree even under the extensions.worktreeConfig=false
    pin) or arbitrary file bytes into evidence stdout (CX-75 class).
  - verifierGit — the runner/policy channel — judges NO argv: `@{…}`
    reflog reads and `log -g` execute on the trusted env, and
    `policy.digest --verify --base` flows a flag-derived ref straight into
    `show`/`rev-list`/`ls-tree` — `--base 'HEAD@{0}'` makes baseDigest ==
    current, silently waiving the X-Policy-Digest attestation.
  - `rev-list --use-bitmap-index` is admitted — the flag opts into the
    session-writable pack bitmap cache (the class the commitGraph pin
    closed).
  - heredoc delimiter lexing: `<<'E#F'` (the `#.*$` comment strip eats the
    quoted delimiter → never armed), `<<1` (digit-leading delimiter never
    matches `[A-Za-z_]`), and `<<-EOF` with a SPACE-indented terminator
    (judge trim()s, bash strips only tabs) all leave the body judged as
    commands while every gate line is still stdin → dead CI adopted.
  - a commit object declaring `encoding: utf-16*` recodes %s/%B/%(trailers)
    to garbage on every trusted read — the encoding header lives INSIDE the
    object so no -c pin can strip it: the push scan and digest trail ship
    an X-Verifier-Report commit unflagged.
  - stdin-consuming flags (--stdin, --exclude-existing) are admitted and
    block the evidence channel until timeout.
</purpose>
<non-goals>
  <item>Not a contract source of truth — src/utils/verifier-git.ts, os/flow/**, src/onboarding/trust-boundary.ts own behaviour.</item>
  <item>Remote-side config (uploadpack.hideRefs on the real remote), real-network MITM, /etc files — infrastructure, noted not probed.</item>
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
import { setVerifierGitBinForTests, verifierGit } from "../../../src/utils/verifier-git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { evidencePreflight, gitEvidence, isEvidenceGitQuery } from "../../flow/git.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { runPolicyDigest } from "../../core/handlers/policy-digest.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";

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
  const root = mkdtempSync(path.join(os.tmpdir(), "cx7-scaffold-"));
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

/** policy.digest invocation plumbing — mirrors os/core/handlers/policy-digest.test.ts. */
const digestCtx = (root: string): ForgeRuntimeContext => ({
  workspaceRoot: root,
  logger: { section: () => {}, info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  dryRun: false,
  outputFormat: "json",
});
const digestInp = (flags: Record<string, unknown>): ForgeCommandInput => ({
  argv: [],
  flags: flags as ForgeCommandInput["flags"],
});

const POLICY_YAML = `schema: forge/config@1
project:
  name: demo
paths:
  rfcsDir: docs/rfcs
policy:
  mutable: [project]
  additive: [bindings]
  freezeFiles:
    - "hooks/**"
agentTools:
  deny: [deploy]
`;

function policyRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx7-policy-"));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  gitIn(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(root, "forge.yaml"), POLICY_YAML);
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  writeFileSync(path.join(root, "hooks", "pre-commit.sh"), "#!/bin/sh\nexit 0\n");
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", "seed"]);
  return root;
}

/**
 * Patch one parent edge inside a commit-graph file (same format helper as
 * r6 — works on base `objects/info/commit-graph` and chain-dir
 * `objects/info/commit-graphs/graph-*.graph` files alike).
 */
function patchCommitGraphParentFile(
  graphPath: string,
  tipSha: string,
  newParentSha: string,
): boolean {
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
// A. remote.* config that still writes on the "read-only + pinned" fetch
// ===========================================================================

describe("RFC-1616 r7 — repo-config ref-write levers on the pinned fetch", () => {
  it(
    "CX-94: `remote.origin.fetch` unions with the pinned refspec — the evidence fetch creates local `refs/heads/x-*` branches (and `remote.origin.tagOpt` plants remote tags) — CX-81's argv fix never judged the config",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-fetchcfg-" });
      // Session-writable config — remote.* is KEEP so nothing pins or refuses it.
      await gitExec(repo, [
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/*:refs/heads/x-*",
      ]);
      await gitExec(repo, ["config", "remote.origin.tagOpt", "--tags"]);
      // Fixture: remote carries a tag the session wants planted locally.
      const originPath = gitIn(repo, ["remote", "get-url", "origin"]).trim();
      gitIn(originPath, ["tag", "t-planted", "refs/heads/develop"]);
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      // The fetch may legitimately fail (checked-out-branch guard) — the
      // contract is what it may WRITE, not its exit status.
      const heads = gitIn(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).trim();
      const tags = gitIn(repo, ["tag", "--list", "t-*"]).trim();
      expect
        .soft(
          fetch.stderr.startsWith("EVIDENCE-REFUSED"),
          `the evidence channel did not refuse remote.origin.fetch/tagOpt (stderr=${fetch.stderr.slice(0, 140)})`,
        )
        .toBe(true);
      expect
        .soft(
          heads.split("\n").filter((r) => !["refs/heads/develop", "refs/heads/main"].includes(r)),
          `the pinned fetch wrote local branches via configured remote.origin.fetch: ${heads}`,
        )
        .toEqual([]);
      expect
        .soft(
          tags,
          "remote.origin.tagOpt planted a remote tag into refs/tags/ on the trusted fetch",
        )
        .toBe("");
    },
  );
});

// ===========================================================================
// B. shape-file lexing divergences
// ===========================================================================

describe("RFC-1616 r7 — alternates comment divergence", () => {
  it(
    "CX-95: a `   # forged` alternates line — the judge's `^\\s*#` treats it as a comment while git resolves it as the literal path `objects/   # forged` — a foreign object store invisible to the shape check",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-altcmt-" });
      const blobSha = gitIn(
        repo,
        ["hash-object", "-w", "--stdin", "-t", "blob"],
        "FORGED\n",
      ).trim();
      // A directory literally named `   # forged` under objects/ — git's
      // alternates parser only comments '#' at column 0.
      const altDir = path.join(repo, ".git", "objects", "   # forged");
      mkdirSync(path.join(altDir, blobSha.slice(0, 2)), { recursive: true });
      execFileSync("cp", [
        path.join(repo, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2)),
        path.join(altDir, blobSha.slice(0, 2), blobSha.slice(2)),
      ]);
      rmSync(path.join(repo, ".git", "objects", blobSha.slice(0, 2), blobSha.slice(2)));
      writeFileSync(path.join(repo, ".git", "objects", "info", "alternates"), "   # forged\n");
      // Fixture premise: git resolves the foreign object through the
      // space-indented line.
      expect(gitIn(repo, ["cat-file", "-p", blobSha]).trim()).toBe("FORGED");
      const pre = await evidencePreflight(repo);
      expect
        .soft(
          pre !== null && pre.shapeViolations.includes("objects/info/alternates"),
          `a whitespace-led "comment" alternates line defeated the shape check ` +
            `(violations=${JSON.stringify(pre?.shapeViolations)})`,
        )
        .toBe(true);
      const read = await gitEvidence(repo, ["cat-file", "-p", blobSha]);
      expect(
        read.exitCode !== 0 || !read.stdout.includes("FORGED"),
        `the trusted channel resolved a foreign object through a "commented" alternates line ` +
          `(exit=${read.exitCode}, stdout=${read.stdout.slice(0, 60)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// C. config-read source flags
// ===========================================================================

describe("RFC-1616 r7 — config reads admit alternate sources", () => {
  it(
    "CX-96: `config --get*` and `--local --no-includes --list` admit `--file`/`--blob`/`--worktree` — a session-named file, a committed blob, or the worktree-scoped config answers fabricated values into evidence stdout (CX-75 class)",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-cfgsrc-" });
      for (const argv of [
        ["config", "--get", "--file", "/etc/passwd", "x"],
        ["config", "--get", "--file=/tmp/x", "k"],
        ["config", "--get-all", "--blob", "HEAD:cfg", "k"],
        ["config", "--get-regexp", "--file", "/tmp/x", ".*"],
        ["config", "--get", "--worktree", "core.hooksPath"],
        ["config", "--local", "--no-includes", "--list", "--file=/tmp/x"],
        ["config", "--local", "--no-includes", "--list", "--blob", "HEAD:x"],
      ]) {
        expect
          .soft(
            isEvidenceGitQuery(argv),
            `the evidence predicate admits ${argv.join(" ")} — an alternate config source`,
          )
          .toBe(false);
      }
      // Live proof on the worktree scope: an explicit --worktree flag reads
      // .git/config.worktree even under the extensions.worktreeConfig=false
      // pin — the preflight's own `config --get core.hooksPath` surface can
      // be steered to a session file.
      await gitExec(repo, ["config", "extensions.worktreeConfig", "true"]);
      await gitExec(repo, ["config", "--worktree", "core.hooksPath", "/tmp/evil-hooks"]);
      const pinned = gitIn(repo, [
        "-c",
        "extensions.worktreeConfig=false",
        "config",
        "--get",
        "--worktree",
        "core.hooksPath",
      ]).trim();
      // Premise: an explicit --worktree reads config.worktree REGARDLESS
      // of the disabled extension — the pin cannot guard the alternate
      // source, so argv refusal is the only boundary (asserted above).
      expect
        .soft(
          pinned === "/tmp/evil-hooks",
          `--worktree under the disabled-extension pin should still reach config.worktree (got ${JSON.stringify(pinned)})`,
        )
        .toBe(true);
      const r = await gitEvidence(repo, [
        "config",
        "--get",
        "--file",
        path.join(path.dirname(repo), "fake.ini"),
        "x.y",
      ]);
      expect
        .soft(
          r.stderr.startsWith("EVIDENCE-REFUSED") || r.exitCode !== 0,
          `gitEvidence served config from a session-named file (stdout=${r.stdout.slice(0, 60)})`,
        )
        .toBe(true);
    },
  );
});

// ===========================================================================
// D. the unjudged runner/policy channel
// ===========================================================================

describe("RFC-1616 r7 — verifierGit argv is unjudged (reflog/upstream reads)", () => {
  it(
    "CX-97a: `verifierGit` executes `@{…}` reflog/upstream reads and `log -g` on the trusted env — the sibling evidence table refuses the same argv (CX-92) but the runner/policy channel never judges",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-vg-atref-" });
      await cleanCommit(repo, "extra.txt");
      const r1 = await verifierGit(repo, ["rev-parse", "--verify", "-q", "HEAD@{1}"]);
      expect
        .soft(
          r1.exitCode !== 0,
          `verifierGit answered a reflog lookup HEAD@{1} → ${r1.stdout.trim()} — session-fabricable state on the trusted channel`,
        )
        .toBe(true);
      const r2 = await verifierGit(repo, ["rev-list", "HEAD@{1}..HEAD"]);
      expect
        .soft(
          r2.exitCode !== 0,
          `verifierGit answered a reflog-anchored rev-list (out=${r2.stdout.slice(0, 60)})`,
        )
        .toBe(true);
      const r3 = await verifierGit(repo, ["log", "-g", "--format=%gs", "-1"]);
      expect
        .soft(
          r3.exitCode !== 0,
          `verifierGit ran log -g — reflog data the evidence table refuses (out=${r3.stdout.slice(0, 60)})`,
        )
        .toBe(true);
      // @{u} follows session branch.*.remote/merge config.
      await gitExec(repo, ["config", "branch.develop.remote", "origin"]);
      await gitExec(repo, ["config", "branch.develop.merge", "refs/heads/main"]);
      const r4 = await verifierGit(repo, ["rev-parse", "--verify", "-q", "develop@{u}"]);
      expect
        .soft(
          r4.exitCode !== 0,
          `verifierGit resolved develop@{u} through session branch config → ${r4.stdout.trim()}`,
        )
        .toBe(true);
    },
  );

  it(
    "CX-97b: `policy.digest --verify --base 'HEAD@{0}'` — the flag-derived ref reaches verifierGit unjudged; base == tip so an unattested policy advance verifies WITHOUT any X-Policy-Digest trailer",
    { timeout: 120_000 },
    async () => {
      const root = policyRepo();
      const realBase = gitIn(root, ["rev-parse", "HEAD"]).trim();
      // Advance the policy surface, regenerate the digest, commit WITHOUT the
      // attestation trailer — the AC-5 fixture that must fail --verify --base.
      writeFileSync(
        path.join(root, "forge.yaml"),
        POLICY_YAML.replace("deny: [deploy]", "deny: []"),
      );
      gitIn(root, ["commit", "-qam", "weaken the deny list"]);
      await runPolicyDigest(digestInp({ write: true }), digestCtx(root));
      gitIn(root, ["add", ".forge/policy.digest"]);
      gitIn(root, ["commit", "-qm", "regenerate digest — no trailer"]);
      const honest = await runPolicyDigest(
        digestInp({ verify: true, base: realBase }),
        digestCtx(root),
      );
      expect
        .soft(
          honest.exitCode !== 0,
          "control: the real base must still catch the unattested advance",
        )
        .toBe(true);
      const forged = await runPolicyDigest(
        digestInp({ verify: true, base: "HEAD@{0}" }),
        digestCtx(root),
      );
      expect(
        forged.exitCode !== 0,
        `--base 'HEAD@{0}' read the reflog on the trusted channel and verified an ` +
          `unattested advance (status=${forged.data?.status}, violations=${JSON.stringify(forged.data?.violations)})`,
      ).toBe(true);
      // The upstream twin: @{u} follows session branch config to a chosen base.
      await gitExec(root, ["config", "branch.master.remote", "."]);
      await gitExec(root, ["config", "branch.master.merge", "refs/heads/master"]);
      const forgedU = await runPolicyDigest(
        digestInp({ verify: true, base: "@{u}" }),
        digestCtx(root),
      );
      expect
        .soft(
          forgedU.exitCode !== 0,
          `--base '@{u}' followed session branch.*.merge config to waive the attestation ` +
            `(violations=${JSON.stringify(forgedU.data?.violations)})`,
        )
        .toBe(true);
    },
  );
});

// ===========================================================================
// E. session-writable caches reachable through admitted argv
// ===========================================================================

describe("RFC-1616 r7 — pack bitmap admission", () => {
  it(
    "CX-98: `rev-list --use-bitmap-index` is admitted — the flag opts into the session-writable pack bitmap cache on the trusted channel (the class the core.commitGraph pin closed)",
    { timeout: 60_000 },
    async () => {
      expect(
        isEvidenceGitQuery(["rev-list", "--use-bitmap-index", "HEAD"]),
        "the evidence predicate admits a rev-list that trusts .git/objects/pack/*.bitmap",
      ).toBe(false);
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-bitmap-" });
      const r = await gitEvidence(repo, ["rev-list", "--use-bitmap-index", "HEAD"]);
      expect
        .soft(
          r.stderr.startsWith("EVIDENCE-REFUSED") || r.exitCode !== 0,
          `gitEvidence ran a bitmap-trusting walk (exit=${r.exitCode})`,
        )
        .toBe(true);
    },
  );
});

// ===========================================================================
// F. workflow heredoc delimiter lexing
// ===========================================================================

describe("RFC-1616 r7 — heredoc delimiter lexer divergences", () => {
  it(
    "CX-99a: `cat <<'E#F'` — the `#.*$` comment strip eats the quoted delimiter so the heredoc never arms; the gate lines are stdin to cat yet count as invocations → dead CI adopted",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<'E#F'
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          E#F
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted a workflow whose gate lines are heredoc stdin (quoted #-delimiter)",
      ).toBe(false);
    },
  );

  it(
    "CX-99b: `cat <<1` — a digit-leading delimiter never matches the `[A-Za-z_]` lexer branch, so the body is judged as commands while bash feeds it to cat",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<1
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          1
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted gate lines inside a numeric-delimiter heredoc",
      ).toBe(false);
    },
  );

  it(
    "CX-100: `cat <<-EOF` with a SPACE-indented terminator — the judge trims the terminator line so the body 'ends' for it, while bash `<<-` strips only tabs and every gate line is still stdin",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<-EOF
            EOF
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted a workflow whose gate lines are still inside the heredoc body (space-indented terminator)",
      ).toBe(false);
    },
  );
});

// ===========================================================================
// G. stdin-consuming flags
// ===========================================================================

describe("RFC-1616 r7 — stdin-consuming flags on a no-stdin channel", () => {
  it(
    "CX-101: `for-each-ref --stdin` / `show-ref --exclude-existing` / `ls-remote --stdin` are admitted — each blocks on stdin the evidence spawn never closes, hanging the trusted channel until timeout",
    { timeout: 60_000 },
    () => {
      for (const argv of [
        ["for-each-ref", "--stdin"],
        ["show-ref", "--exclude-existing"],
        ["ls-remote", "--stdin", "origin"],
      ]) {
        expect
          .soft(
            isEvidenceGitQuery(argv),
            `the evidence predicate admits ${argv.join(" ")} — a blocking stdin read`,
          )
          .toBe(false);
      }
    },
  );
});

// ===========================================================================
// H. committed-object encoding shaping
// ===========================================================================

describe("RFC-1616 r7 — commit-object encoding header blinds the trailer scan", () => {
  it(
    "CX-102: a commit declaring `encoding: utf-16` recodes %s/%B/%(trailers) to garbage on every trusted read — no -c pin can strip an in-object header — pushFlow ships the X-Verifier-Report commit unflagged",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-enc-" });
      const tree = gitIn(repo, ["rev-parse", "develop^{tree}"]).trim();
      const parentSha = gitIn(repo, ["rev-parse", "develop"]).trim();
      const obj = [
        `tree ${tree}`,
        `parent ${parentSha}`,
        "author a <t@t> 1700000000 +0000",
        "committer a <t@t> 1700000000 +0000",
        "encoding utf-16",
        "",
        "session work",
        "",
        "X-Verifier-Report: r.yaml",
        "",
      ].join("\n");
      const objPath = path.join(path.dirname(repo), "cobj");
      writeFileSync(objPath, obj);
      const encSha = gitIn(repo, ["hash-object", "-t", "commit", "-w", objPath]).trim();
      gitIn(repo, ["update-ref", "refs/heads/develop", encSha]);
      // Fixture premise: the raw object visibly claims the trailer while the
      // recoded %(trailers) surface is empty.
      expect(gitIn(repo, ["cat-file", "commit", encSha])).toContain("X-Verifier-Report");
      const rawTrailers = gitIn(repo, [
        "log",
        "-1",
        "--format=%(trailers:only,separator=%x00)",
        encSha,
      ]);
      expect
        .soft(rawTrailers.includes("X-Verifier-Report"), "fixture: unpinned trailers visible")
        .toBe(false);
      const ev = await gitEvidence(repo, [
        "log",
        "-1",
        "--format=%(trailers:only,separator=%x00)",
        encSha,
      ]);
      // Premise: %(trailers) recodes on ANY channel — the in-object
      // `encoding:` header is authoritative and no argv/-c can override
      // it, so the read is inherently blind; the fix is that the scans
      // flag the encoded commit via %e, asserted below.
      expect
        .soft(
          !ev.stdout.includes("X-Verifier-Report"),
          `the evidence %(trailers) read should be as blind as raw git ` +
            `(exit=${ev.exitCode}, out=${JSON.stringify(ev.stdout.slice(0, 80))})`,
        )
        .toBe(true);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      expect
        .soft(
          digest.correctnessTrail.verifierCommits.some((c) => c.sha === encSha),
          `digest correctnessTrail missed the encoding-garbled trailer commit ` +
            `(verifierCommits=${JSON.stringify(digest.correctnessTrail.verifierCommits.map((c) => c.sha))})`,
        )
        .toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(
        (data.verifierTrailerCommits ?? []).some((h) => h.sha === encSha),
        `pushFlow shipped the encoding-garbled trailer commit unflagged ` +
          `(verifierTrailerCommits=${JSON.stringify((data.verifierTrailerCommits ?? []).map((h) => h.sha))}, pushed=${data.pushed})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// I. hold probes — representative r6 fixes still closed
// ===========================================================================

describe("RFC-1616 r7 — closed-surface re-verification", () => {
  it(
    "R7-R1: CX-72 stays dead — `core.gitProxy` still refuses the channel",
    { timeout: 60_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-proxy-" });
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
    "R7-R2: CX-79 stays dead — non-empty info/grafts still refuses the channel",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-graft-" });
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
    "R7-R3: CX-80 stays dead — an expectedRemote-mismatched repoint still errors FLOW-PUSH-14",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-anchor-" });
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
    "R7-R4: CX-84 stays dead — caller extraEnv keeps only locale/temp levers",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-env-" });
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

  it(
    "R7-R5: CX-85 stays dead — `remote.origin.uploadpack` still refuses ls-remote and fetch",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-uppack-" });
      const up = path.join(parent, "up.sh");
      const marker = path.join(parent, "up.marker");
      writeFileSync(
        up,
        `#!/bin/sh\necho EXEC >> ${JSON.stringify(marker)}\nexec /usr/bin/git upload-pack "$@"\n`,
      );
      chmodSync(up, 0o755);
      await gitExec(repo, ["config", "remote.origin.uploadpack", up]);
      const ls = await gitEvidence(repo, ["ls-remote", "origin", "refs/heads/main"]);
      expect(ls.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
      expect(ls.stderr).toContain("remote.origin.uploadpack");
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect(fetch.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it(
    "R7-R6: CX-86 stays dead — the pinned GIT_SSH_COMMAND devnulls ~/.ssh/config; a Match host ProxyCommand never runs",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-sshcfg-" });
      const marker = path.join(parent, "ssh.marker");
      const proxy = path.join(parent, "proxy.sh");
      writeFileSync(proxy, `#!/bin/sh\necho PX >> ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(proxy, 0o755);
      const host = `probe-r7-${process.pid}.invalid`;
      sshConfigBackup.content = existsSync(sshConfigBackup.file)
        ? Buffer.from(readFileSync(sshConfigBackup.file))
        : null;
      writeFileSync(
        sshConfigBackup.file,
        `${sshConfigBackup.content?.toString("utf8") ?? ""}\nMatch host ${host}\n  ProxyCommand ${proxy} %h %p\n`,
      );
      await gitExec(repo, ["config", "remote.origin.url", `ssh://git@${host}/repo.git`]);
      const ls = await gitEvidence(repo, ["ls-remote", "origin"]);
      expect(ls.exitCode !== 0 || ls.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
      expect(existsSync(marker), "~/.ssh/config ProxyCommand ran inside the trusted channel").toBe(
        false,
      );
    },
  );

  it(
    "R7-R7: CX-87 stays dead — the hooks dir is mkdtemp-randomised, a pre-planted forge-evidence-hooks-<pid> never reaches the pinned fetch",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-hookdir-" });
      const stale = path.join(os.tmpdir(), `forge-evidence-hooks-${process.pid}`);
      const marker = path.join(parent, "hook.marker");
      mkdirSync(stale, { recursive: true });
      writeFileSync(
        path.join(stale, "reference-transaction"),
        `#!/bin/sh\necho HOOK-FIRED >> ${JSON.stringify(marker)}\n`,
      );
      chmodSync(path.join(stale, "reference-transaction"), 0o755);
      await gitExec(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect.soft(fetch.exitCode, "fixture: pinned fetch failed").toBe(0);
      expect(
        existsSync(marker),
        "a stale forge-evidence-hooks-<pid> dir still hooked the trusted fetch",
      ).toBe(false);
      rmSync(stale, { recursive: true, force: true });
    },
  );

  it(
    "R7-R8: CX-88 stays dead — a forged objects/info/commit-graph is ignored under the core.commitGraph pin (and the chain dir is warn-only + pinned)",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-cgraph-" });
      const tSha = await trailerCommit(repo, "t.txt", "X-Verifier-Report: r.yaml");
      const cSha = await cleanCommit(repo, "clean.txt");
      const base = gitIn(repo, ["rev-parse", `${tSha}^`]).trim();
      gitIn(repo, ["commit-graph", "write", "--reachable"]);
      const graphPath = path.join(repo, ".git", "objects", "info", "commit-graph");
      expect(patchCommitGraphParentFile(graphPath, cSha, base)).toBe(true);
      // Forge premise: unpinned rev-list hides the trailer commit.
      expect(gitIn(repo, ["rev-list", "develop"]).includes(tSha)).toBe(false);
      const ev = await gitEvidence(repo, ["rev-list", "develop"]);
      expect(
        ev.stdout.includes(tSha),
        `the pinned channel served forged graph topology — ${tSha.slice(0, 9)} hidden`,
      ).toBe(true);
      const pre = await evidencePreflight(repo);
      expect
        .soft(
          pre !== null && pre.warnedShape.includes("objects/info/commit-graph"),
          "the forged graph should be reported as warn-only shape, not refused",
        )
        .toBe(true);
      // Chain-dir twin: --split writes objects/info/commit-graphs/ — a new
      // commit first so there is a layer to write.
      await cleanCommit(repo, "chain.txt");
      gitIn(repo, ["commit-graph", "write", "--reachable", "--split"]);
      const chainDir = path.join(repo, ".git", "objects", "info", "commit-graphs");
      const chainFile = execFileSync("ls", [chainDir])
        .toString()
        .split("\n")
        .find((f) => f.startsWith("graph-") && f.endsWith(".graph"));
      expect(chainFile !== undefined, "fixture: no chain graph written").toBe(true);
      const ev2 = await gitEvidence(repo, ["rev-list", "develop"]);
      expect(ev2.stdout.includes(tSha), "the pinned channel trusted a commit-graphs/ chain").toBe(
        true,
      );
    },
  );

  it(
    "R7-R9: CX-89 stays dead — per-path --git-path queries keep positional alignment under a newline-bearing gitdir",
    { timeout: 120_000 },
    async () => {
      const parent = mkdtempSync(path.join(os.tmpdir(), "cx7-hold-gitpath-"));
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
      const gitDir = gitIn(wt, ["rev-parse", "--git-common-dir"]).trim();
      mkdirSync(path.join(gitDir, "info"), { recursive: true });
      writeFileSync(
        path.join(gitDir, "info", "grafts"),
        `${gitIn(wt, ["rev-parse", "wt"]).trim()} ${A}\n`,
      );
      const pre = await evidencePreflight(wt);
      expect(
        pre !== null && pre.shapeViolations.length > 0,
        `grafts went undetected under a newline-bearing --git-path answer ` +
          `(violations=${JSON.stringify(pre?.shapeViolations)})`,
      ).toBe(true);
    },
  );

  it(
    "R7-R10: CX-90 stays dead — a plain `cat <<EOF` heredoc body is never counted as invocations",
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
      expect(adoptedWorkflow(wf), "a plain heredoc still adopts").toBe(false);
    },
  );

  it(
    "R7-R11: CX-91 stays dead — a whitespace-only alternates line still refuses the channel",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-altsp-" });
      writeFileSync(path.join(repo, ".git", "objects", "info", "alternates"), "   \n");
      const pre = await evidencePreflight(repo);
      expect(pre !== null && pre.shapeViolations.includes("objects/info/alternates")).toBe(true);
      const r = await gitEvidence(repo, ["rev-parse", "HEAD"]);
      expect(r.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
    },
  );

  it(
    "R7-R12: CX-92 stays dead — -g/--reflog/--fork-point and every `@{`-bearing arg stay refused on both predicates",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx7-hold-reflog-" });
      for (const argv of [
        ["log", "-g", "HEAD@{0}"],
        ["log", "--reflog", "HEAD@{0}"],
        ["rev-list", "-g", "HEAD@{0}"],
        ["show", "-g", "HEAD@{0}"],
        ["merge-base", "--fork-point", "HEAD"],
        ["log", "--format=@{0}"],
        ["log", "--grep=@{0}"],
        ["rev-parse", "develop@{u}"],
        ["ls-remote", "origin", "x@{y}"],
        ["remote", "get-url", "x@{y}"],
      ]) {
        expect
          .soft(isEvidenceGitQuery(argv), `${argv.join(" ")} admitted a reflog/@{ read`)
          .toBe(false);
      }
      const r = await gitEvidence(repo, ["log", "-g", "--format=%gs", "-2"]);
      expect(r.exitCode !== 0 || r.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
    },
  );

  it(
    "R7-R13: CX-93 stays dead — a BROKEN .github symlink reports a structured conflict, never crashes",
    { timeout: 60_000 },
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "cx7-hold-broken-"));
      dirs.push(root);
      symlinkSync(path.join(root, "does-not-exist"), path.join(root, ".github"));
      let threw: unknown = null;
      let out: ReturnType<typeof scaffoldTrustBoundary> | null = null;
      try {
        out = scaffoldTrustBoundary(root, "@operator");
      } catch (e) {
        threw = e;
      }
      expect(threw === null, `scaffold crashed on broken symlink: ${String(threw)}`).toBe(true);
      expect(
        out !== null &&
          (out.conflicts.length > 0 ||
            out.created.some((c) => c.includes(".github")) ||
            out.skipped.length > 0),
        "a broken-symlinked boundary ancestor produced neither conflict nor install",
      ).toBe(true);
    },
  );
});
