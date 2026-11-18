/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-8 verification of the external
verification trust boundary against export candidate 9da0bf51. Every probe
FAILS when the counterexample is live and PASSES when closed; numbering
continues from CX-103 (round 7 reported CX-94..CX-102).

Round-8 attack surfaces (levers the r7 hardening did not judge):
  - committed-object reads serve UNVERIFIED bytes: a session writes a loose
    object file under `.git/objects/<sha>` whose zlib payload does not hash
    to <sha>; git never re-hashes on read, and loose objects shadow packed
    ones. `show <base>:forge.yaml` on the evidence channel then serves
    forged surface bytes for the OPERATOR-anchored --base sha — the
    attestation anchor itself is fabricable (the shape-file preflight
    cannot see it; the objects are the metadata).
  - `policy.digest --base` admits content-search revspecs `^{/regex}`/`:/`
    — the `@{`-only fabrication judge (CX-97) left every other dynamic
    resolution open; `HEAD^{/.}` resolves to the tip so `verify --base`
    sees baseDigest == current and skips the attestation check entirely.
  - verifierGit's argv judge is a fabrication-only list, not a table: the
    `reflog`/`stash` SUBCOMMANDS (same fabrication store as -g/@{) and
    leading git global options (`-c`, `-C`, `--git-dir`, `--work-tree`,
    `--exec-path`, `--paginate`) ride into the trusted spawn unjudged —
    `-c k=v` appended AFTER the pins wins the last-write.
  - `remote.<name>.fetch` value judgment keys on `[^.]+` — a dot-named
    remote (`remote.o.r.fetch`) escapes the regex into plain KEEP, so a
    non-default refspec stands on the channel; isEvidenceFetchTail admits
    ANY first-positional remote name, so `fetch o.r` unions it and writes
    refs outside the tracking namespace. The SAME `[^.]+` blind spot
    exempts `remote.o.r.uploadpack` from the REFUSE table — verified live:
    `fetch o.r` EXECUTES the session's program inside the channel.
  - heredoc lexer: `<<~` is not a bash operator (bash's delimiter is
    `~EOF`; the judge reads `~` as the tabStrip flag and waits for `EOF`),
    `<<'E'OF`/`<<E"OF"` are one bash WORD (`EOF` after quote removal) the
    judge reads as delimiter `E`, and `<<$X`/`<<$(…)` delimiter words the
    `[\w.-]+` charset cannot match never arm for the judge while bash
    arms a literal delimiter — every variant lets gate lines be judged as
    invocations while bash feeds them to stdin → dead CI adopted.
</purpose>
<non-goals>
  <item>Not a contract source of truth — src/utils/verifier-git.ts, os/flow/**, src/onboarding/trust-boundary.ts own behaviour.</item>
  <item>Remote-side config on the operator's real remote, real-network MITM, /etc files — infrastructure, noted not probed.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { scaffoldTrustBoundary } from "../../../src/onboarding/trust-boundary.ts";
import {
  evidencePinArgs,
  filterEvidenceExtraEnv,
  setVerifierGitBinForTests,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { evidencePreflight, gitEvidence, isEvidenceGitQuery } from "../../flow/git.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { runPolicyDigest } from "../../core/handlers/policy-digest.ts";
import type { ForgeCommandInput, ForgeRuntimeContext } from "../../../src/types.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

/** A plain (trailer-free) commit on top of HEAD, return its sha. */
async function cleanCommit(repo: string, file: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(repo, file), "y\n");
  await gitExec(repo, ["add", file]);
  await gitExec(repo, ["commit", "-qm", "clean follow-up"]);
  return (await gitExec(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

const adoptedWorkflow = (body: string): boolean => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx8-scaffold-"));
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
  const root = mkdtempSync(path.join(os.tmpdir(), "cx8-policy-"));
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
 * Loose-shadow one object: write a zlib loose-object file for `sha` whose
 * payload is `forged` — git serves it verbatim on every read and never
 * re-hashes (empirically: `cat-file -p` prints forged bytes; loose wins
 * over packed). Returns the object path the session wrote.
 */
function looseShadow(repo: string, sha: string, type: string, forged: Buffer): string {
  const rel = `.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`;
  const dest = path.join(repo, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  try {
    chmodSync(dest, 0o644);
  } catch {
    /* absent already — loose shadow over packed sha still wins */
  }
  writeFileSync(dest, deflateSync(Buffer.concat([Buffer.from(`${type} ${forged.length}\0`), forged])));
  chmodSync(dest, 0o444);
  return dest;
}

// ===========================================================================
// A. the unverified object store — loose shadows lie to every evidence read
// ===========================================================================

describe("RFC-1616 r8 — committed-object bytes are unverified (loose shadow)", () => {
  it(
    "CX-104a: a loose object whose bytes do not hash to its sha is served verbatim — `cat-file -p <sha>` on the evidence channel returns forged content (git never re-hashes; loose shadows packed)",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-shadow-" });
      const real = "REAL-BYTES\n";
      const sha = gitIn(repo, ["hash-object", "-w", "--stdin", "-t", "blob"], real).trim();
      // Control: the real bytes answer.
      expect(gitIn(repo, ["cat-file", "-p", sha])).toBe(real);
      // Pack everything, then loose-shadow the packed sha.
      gitIn(repo, ["gc", "-q"]);
      looseShadow(repo, sha, "blob", Buffer.from("FORGED-BYTES\n"));
      // Premise: raw git serves the forged bytes for the real sha.
      expect(gitIn(repo, ["cat-file", "-p", sha])).toBe("FORGED-BYTES\n");
      // The evidence channel serves the same forged answer — no pin or
      // shape-file reaches the object store.
      const ev = await gitEvidence(repo, ["cat-file", "-p", sha]);
      expect(
        ev.exitCode === 0 && ev.stdout === "FORGED-BYTES\n"
          ? false
          : ev.stderr.startsWith("EVIDENCE-REFUSED") || ev.exitCode !== 0,
        `the evidence channel served forged object bytes for ${sha.slice(0, 9)} ` +
          `(exit=${ev.exitCode}, out=${JSON.stringify(ev.stdout.slice(0, 40))})`,
      ).toBe(true);
    },
  );

  it(
    "CX-104b: policy.digest --verify --base <attested sha> — loose-shadowing the base commit's forge.yaml blob makes baseDigest == current sha256, so the attestation check is SKIPPED and an unattested advance verifies",
    { timeout: 120_000 },
    async () => {
      const root = policyRepo();
      const realBase = gitIn(root, ["rev-parse", "HEAD"]).trim();
      // Advance the policy surface, regenerate the digest, commit WITHOUT
      // the attestation trailer (the AC-5 fixture that must fail).
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
      expect(
        honest.exitCode !== 0,
        "control: the real base must still catch the unattested advance",
      ).toBe(true);
      // Forge: loose-shadow the BASE commit's forge.yaml blob with the
      // WEAKENED yaml — `show <base>:forge.yaml` then serves session bytes
      // for the operator-anchored sha, and ls-tree/show of every other
      // judged file stays identical → baseDigest == current sha256.
      const blobSha = gitIn(root, ["rev-parse", `${realBase}:forge.yaml`]).trim();
      const weakened = POLICY_YAML.replace("deny: [deploy]", "deny: []");
      looseShadow(root, blobSha, "blob", Buffer.from(weakened));
      // Premise: raw git serves the forged blob for the anchored sha.
      expect(gitIn(root, ["show", `${realBase}:forge.yaml`])).toContain("deny: []");
      const forged = await runPolicyDigest(
        digestInp({ verify: true, base: realBase }),
        digestCtx(root),
      );
      expect(
        forged.exitCode !== 0,
        `loose-shadowing the anchored base blob verified an unattested advance ` +
          `(status=${forged.data?.status}, violations=${JSON.stringify(forged.data?.violations)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// B. policy.digest --base — dynamic revspec resolution past the @{ judge
// ===========================================================================

describe("RFC-1616 r8 — --base revspecs resolve through session-controlled content", () => {
  it(
    "CX-103: `policy.digest --verify --base 'HEAD^{/.}'` — a message-search revspec resolves to the tip so baseDigest == current and the attestation check never runs — the CX-97 @{ judge left every non-@{ dynamic resolution open",
    { timeout: 120_000 },
    async () => {
      const root = policyRepo();
      const realBase = gitIn(root, ["rev-parse", "HEAD"]).trim();
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
      expect(
        honest.exitCode !== 0,
        "control: the real base must still catch the unattested advance",
      ).toBe(true);
      // Fixture premise: HEAD^{/.} resolves to the tip itself.
      expect(gitIn(root, ["rev-parse", "HEAD^{/.}"])).toBe(
        gitIn(root, ["rev-parse", "HEAD"]),
      );
      // Every tip-resolving revspec waives the attestation — content-search
      // ^{/}, any-ref search :/, a session-pointed branch, and bare HEAD
      // alike. (An index revspec like `:0` is NOT in the list — `ls-tree`
      // refuses it, the base surface mismatches, and the check falls back
      // to attestation — the hole needs a COMMIT-resolving rev.)
      for (const revspec of ["HEAD^{/.}", ":/regenerate", "master", "HEAD"]) {
        const forged = await runPolicyDigest(
          digestInp({ verify: true, base: revspec }),
          digestCtx(root),
        );
        expect
          .soft(
            forged.exitCode !== 0,
            `--base '${revspec}' resolved a session-chosen tip and waived the ` +
              `attestation (status=${forged.data?.status}, violations=${JSON.stringify(forged.data?.violations)})`,
          )
          .toBe(true);
      }
    },
  );
});

// ===========================================================================
// C. verifierGit — the argv judge is fabrication-only, not a table
// ===========================================================================

describe("RFC-1616 r8 — verifierGit admits non-judged argv", () => {
  it(
    "CX-108: `verifierGit` runs the `reflog`/`stash` subcommands — the same session-fabricable store the -g/@{ argv judgments exist to refuse, admitted because the judge scans flags only, not the subcommand position",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-vg-reflog-" });
      await cleanCommit(repo, "extra.txt");
      const r1 = await verifierGit(repo, ["reflog"]);
      expect
        .soft(
          r1.exitCode !== 0,
          `verifierGit answered \`git reflog\` on the trusted channel ` +
            `(out=${r1.stdout.slice(0, 80)}) — session-fabricable reflog data`,
        )
        .toBe(true);
      const r2 = await verifierGit(repo, ["reflog", "show", "HEAD"]);
      expect
        .soft(
          r2.exitCode !== 0,
          `verifierGit answered \`git reflog show\` (out=${r2.stdout.slice(0, 80)})`,
        )
        .toBe(true);
      const r3 = await verifierGit(repo, ["stash", "list"]);
      expect
        .soft(
          r3.exitCode !== 0,
          `verifierGit answered \`git stash list\` — a reflog-derived read ` +
            `(out=${r3.stdout.slice(0, 80)})`,
        )
        .toBe(true);
    },
  );

  it(
    "CX-109: `verifierGit` admits leading git global options — `-c k=v` lands AFTER the evidence pins and wins the last write; `--git-dir`/`--work-tree`/`-C` redirect the repo; `--exec-path` redirects builtin resolution",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-vg-opts-" });
      // A callsite that interpolates session text at argv[0] hands the
      // whole global-option surface to the spawn — the judge scans for
      // @{/-g/--reflog only, so each of these runs unrefused.
      const r1 = await verifierGit(repo, [
        "-c",
        "core.commentChar=x",
        "log",
        "-1",
        "--format=%s",
      ]);
      expect
        .soft(
          r1.exitCode !== 0,
          "verifierGit executed a caller -c pin — later -c argv beats the " +
            `evidence pins (exit=${r1.exitCode}, out=${r1.stdout.slice(0, 60)})`,
        )
        .toBe(true);
      const other = mkdtempSync(path.join(os.tmpdir(), "cx8-other-"));
      dirs.push(other);
      gitIn(other, ["init", "-q"]);
      const r2 = await verifierGit(repo, ["--git-dir", path.join(other, ".git"), "rev-parse", "HEAD"]);
      expect
        .soft(
          r2.exitCode !== 0,
          `verifierGit redirected the repo via --git-dir (exit=${r2.exitCode})`,
        )
        .toBe(true);
      const r3 = await verifierGit(repo, ["-C", other, "rev-parse", "--is-inside-work-tree"]);
      expect
        .soft(
          r3.exitCode !== 0,
          `verifierGit redirected cwd via -C (exit=${r3.exitCode})`,
        )
        .toBe(true);
      const r4 = await verifierGit(repo, ["config", "user.email", "injected@example"]);
      expect
        .soft(
          r4.exitCode !== 0,
          `verifierGit ran a config WRITE on the trusted channel (exit=${r4.exitCode})`,
        )
        .toBe(true);
      const r5 = await verifierGit(repo, ["update-ref", "refs/heads/injected", "HEAD"]);
      expect
        .soft(
          r5.exitCode !== 0,
          `verifierGit ran update-ref — a ref write on the trusted channel`,
        )
        .toBe(true);
    },
  );
});

// ===========================================================================
// D. remote.<name>.fetch — dot-named remotes escape the value judgment
// ===========================================================================

describe("RFC-1616 r8 — remote.<name>.fetch judgment keyed on [^.]+", () => {
  it(
    "CX-110: `remote.o.r.fetch` (a dot-named remote) never matches the value-judge regex — a non-default refspec stays KEEP and the admitted `fetch o.r` unions it, writing refs outside the tracking namespace",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx8-dotremote-" });
      const decoy = path.join(parent, "decoy");
      gitIn(parent, ["init", "-b", "main", "decoy"]);
      gitIn(decoy, ["config", "user.email", "t@t"]);
      gitIn(decoy, ["config", "user.name", "t"]);
      writeFileSync(path.join(decoy, "d"), "d\n");
      gitIn(decoy, ["add", "d"]);
      gitIn(decoy, ["commit", "-qm", "decoy"]);
      // A remote whose NAME contains a dot — legal for git, invisible to
      // the `remote\.([^.]+)\.fetch` key regex → falls into plain KEEP.
      await gitExec(repo, ["remote", "add", "o.r", decoy]);
      await gitExec(repo, ["config", "remote.o.r.fetch", "+refs/heads/*:refs/heads/x-*"]);
      const pre = await evidencePreflight(repo);
      // The judge must refuse (or pin) the non-default refspec — a bare
      // KEEP verdict is the hole.
      expect
        .soft(
          pre !== null && pre.refusedKeys.includes("remote.o.r.fetch"),
          `judge did not refuse remote.o.r.fetch=+refs/heads/*:refs/heads/x-* ` +
            `(refused=${JSON.stringify(pre?.refusedKeys)}, configArgs=${JSON.stringify(pre?.configArgs)})`,
        )
        .toBe(true);
      // Live fetch proof — the channel's own predicate admits ANY remote
      // name positionally; a non-default configured refspec unions in.
      const admitted = isEvidenceGitQuery([
        "fetch",
        "--no-tags",
        "o.r",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect.soft(admitted, "predicate refused `fetch o.r`").toBe(true);
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--no-tags",
        "o.r",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      const heads = gitIn(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).trim();
      expect
        .soft(
          fetch.exitCode !== 0 || !heads.includes("x-"),
          `the evidence fetch wrote local refs via remote.o.r.fetch ` +
            `(exit=${fetch.exitCode}, heads=${heads})`,
        )
        .toBe(true);
      // Escalation — the same `[^.]+` blind spot exempted
      // `remote.o.r.uploadpack` from the REFUSE table, so the KEEP'd
      // program path was EXECUTED by `fetch o.r` inside the trusted
      // channel (marker file proves the spawn ran, not just resolved).
      // Port premise fix: remediation widened the remote-name segment to
      // `.+`, so the program key is REFUSED and the hole is closed — the
      // premise now asserts the refusal, then the marker check proves the
      // configured binary can never spawn.
      const scratch = mkdtempSync(path.join(os.tmpdir(), "cx8-up-"));
      dirs.push(scratch);
      const marker = path.join(scratch, "marker");
      const evil = path.join(scratch, "evil-uploadpack.sh");
      writeFileSync(evil, `#!/bin/sh\necho PWNED > ${JSON.stringify(marker)}\nexit 1\n`);
      chmodSync(evil, 0o755);
      await gitExec(repo, ["config", "remote.o.r.uploadpack", evil]);
      const pre2 = await evidencePreflight(repo);
      expect
        .soft(
          pre2 !== null && pre2.refusedKeys.includes("remote.o.r.uploadpack"),
          `remote.o.r.uploadpack was NOT refused — the dot-name hole is live ` +
            `(refused=${JSON.stringify(pre2?.refusedKeys)})`,
        )
        .toBe(true);
      const fetch2 = await gitEvidence(repo, [
        "fetch",
        "--no-tags",
        "o.r",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect
        .soft(
          !existsSync(marker),
          `fetch o.r executed remote.o.r.uploadpack inside the evidence channel ` +
            `(marker=${marker}, exit=${fetch2.exitCode}, err=${fetch2.stderr.slice(0, 80)})`,
        )
        .toBe(true);
      // Sibling admission: a PATH/URL positional is also taken as the
      // remote — `fetch <session-path>` pulls session refs into the
      // tracking namespace, `ls-remote <session-path>` answers them.
      for (const argv of [
        ["fetch", decoy, "+refs/heads/*:refs/remotes/origin/*"],
        ["ls-remote", decoy],
      ]) {
        expect
          .soft(
            isEvidenceGitQuery(argv),
            `predicate refused ${argv.join(" ")} — a session-path remote`,
          )
          .toBe(true);
      }
    },
  );
});

// ===========================================================================
// E. heredoc lexer — bash grammar the judge still misreads
// ===========================================================================

describe("RFC-1616 r8 — heredoc delimiter/operator divergences", () => {
  it(
    "CX-105: `cat <<~EOF` — `<<~` is not a bash operator: bash's delimiter is the literal `~EOF` while the judge reads `~` as the tabStrip flag and terminates on `EOF` — every gate line after the fake terminator is still stdin to cat",
    { timeout: 60_000 },
    () => {
      // Bash-faithful premise: `cat <<~EOF … EOF … ~EOF` feeds ALL lines
      // to cat (verified on bash 5.x — `wanted '~EOF'`).
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<~EOF
          EOF
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          ~EOF
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted a workflow whose gate lines are heredoc stdin (<<~ operator)",
      ).toBe(false);
    },
  );

  it(
    "CX-106: `cat <<'E'OF` — quoting is per-WORD not per-delimiter: bash quote-removes `'E'OF` to delimiter `EOF`, the judge captures the quoted fragment `E` and terminates on the first `E` line — the gate lines below are still stdin",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<'E'OF
          E
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect(
        adoptedWorkflow(wf),
        "the scaffold adopted gate lines inside a partially-quoted-delimiter heredoc",
      ).toBe(false);
      // The double-quote twin: `<<E"OF"` — same adjacency, `EOF` for bash.
      const wf2 =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<E"OF"
          E
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect
        .soft(
          adoptedWorkflow(wf2),
          'the scaffold adopted gate lines inside `<<E"OF"` — the same adjacency via ""',
        )
        .toBe(false);
    },
  );

  it(
    "CX-107: `cat <<$(echo EOF)` / `cat <<$EOF` — a substitution/expansion delimiter word never matches the `\\\\?([\\\\w.-]+)` branch, so the judge arms NO heredoc and counts the body as commands, while bash treats the literal word as the delimiter and feeds every line to stdin",
    { timeout: 60_000 },
    () => {
      const wf =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<$(echo EOF)
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect
        .soft(
          adoptedWorkflow(wf),
          "the scaffold adopted gate lines inside a `<<$(…)`-delimited heredoc",
        )
        .toBe(false);
      const wf2 =
        WORKFLOW_HEAD +
        `      - run: |
          cat <<$EOF
          forge correctness.gate --policy-only --base HEAD~1
          forge policy.digest --verify
          forge pinned.validate --mode ci
          EOF
`;
      expect
        .soft(
          adoptedWorkflow(wf2),
          "the scaffold adopted gate lines inside a `<<$EOF`-delimited heredoc",
        )
        .toBe(false);
    },
  );
});

// ===========================================================================
// F. env channel + pin coverage — the allowlist and the static pins
// ===========================================================================

describe("RFC-1616 r8 — extraEnv allowlist and pin coverage", () => {
  it(
    "CX-111: `filterEvidenceExtraEnv` keeps ONLY locale/temp levers — every GIT_* redirection, transport override, preload lever, PATH and proxy env a session could name is dropped before merge",
    { timeout: 60_000 },
    async () => {
      const levers = {
        PATH: "/tmp/evil-bin",
        GIT_DIR: "/tmp/evil-repo",
        GIT_WORK_TREE: "/tmp/evil-wt",
        GIT_INDEX_FILE: "/tmp/evil-index",
        GIT_OBJECT_DIRECTORY: "/tmp/evil-objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/evil-alt",
        GIT_CONFIG_GLOBAL: "/tmp/evil-gitconfig",
        GIT_CONFIG_SYSTEM: "/tmp/evil-gitconfig",
        GIT_CONFIG_PARAMETERS: "'url.x.insteadOf=/evil'",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.x.insteadOf",
        GIT_CONFIG_VALUE_0: "/evil",
        GIT_EXEC_PATH: "/tmp/evil-exec",
        GIT_SSH: "/tmp/evil-ssh",
        GIT_SSH_COMMAND: "ssh -o ProxyCommand=/evil",
        GIT_ASKPASS: "/tmp/evil-ask",
        SSH_ASKPASS: "/tmp/evil-ask",
        GIT_EXTERNAL_DIFF: "/tmp/evil-diff",
        GIT_TRACE: "1",
        GIT_TRACE_PACKET: "1",
        GIT_FLUSH: "1",
        GIT_NAMESPACE: "evil",
        GIT_CEILING_DIRECTORIES: "/",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_GLOB_PATHSPECS: "1",
        GIT_NOGLOB_PATHSPECS: "1",
        GIT_ICASE_PATHSPECS: "1",
        GIT_COMMON_DIR: "/tmp/evil-common",
        GIT_AUTHOR_NAME: "evil",
        GIT_COMMITTER_NAME: "evil",
        GIT_NO_REPLACE_OBJECTS: "0",
        GIT_EDITOR: "/tmp/evil-ed",
        GIT_PAGER: "/tmp/evil-pager",
        PAGER: "/tmp/evil-pager",
        http_proxy: "http://evil.invalid:3128",
        https_proxy: "http://evil.invalid:3128",
        SSL_CERT_FILE: "/tmp/evil-ca",
        NODE_EXTRA_CA_CERTS: "/tmp/evil-ca",
        NODE_OPTIONS: "--require /tmp/evil",
        LD_PRELOAD: "/tmp/evil.so",
        BASH_ENV: "/tmp/evil-rc",
        ENV: "/tmp/evil-rc",
        CDPATH: "/tmp",
        IFS: "x",
        SHELLOPTS: "xtrace",
        HOME: "/tmp/evil-home",
        XDG_CONFIG_HOME: "/tmp/evil-xdg",
        HOMEDRIVE: "Z:",
        HOMEPATH: "\\evil",
      } as const;
      const filtered = filterEvidenceExtraEnv({ ...levers, LC_ALL: "C", TZ: "UTC", TMPDIR: "/tmp/ok" });
      const kept = Object.keys(filtered).sort();
      expect(kept, `extraEnv kept session levers: ${kept.join(",")}`).toEqual([
        "LC_ALL",
        "TMPDIR",
        "TZ",
      ]);
      // Live proof — a representative exec lever cannot ride extraEnv into
      // the spawned child: GIT_SSH_COMMAND would redirect ls-remote's
      // transport; GIT_DIR would redirect the repo entirely.
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-env-" });
      const r = await gitEvidence(repo, ["rev-parse", "HEAD"], {
        extraEnv: {
          GIT_DIR: path.join(os.tmpdir(), "nonexistent-evil-repo"),
          GIT_SSH_COMMAND: "sh -c 'echo PWN >&2'",
          GIT_EXEC_PATH: "/tmp",
          LD_PRELOAD: "/tmp/evil.so",
        },
      });
      expect(
        r.exitCode === 0 && r.stdout.trim().length === 40,
        `a session GIT_* lever rode extraEnv into the evidence read ` +
          `(exit=${r.exitCode}, out=${r.stdout.slice(0, 40)}, err=${r.stderr.slice(0, 80)})`,
      ).toBe(true);
    },
  );

  it(
    "CX-112: the static pin set holds `fetch.recurseSubmodules`/`submodule.recurse`/`core.fsmonitor`/`extensions.worktreeConfig` — session config values for them are neither refused nor dynamically re-pinned (STATIC table) so the file value must never reach a spawned child",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-static-" });
      await gitExec(repo, ["config", "fetch.recurseSubmodules", "true"]);
      await gitExec(repo, ["config", "submodule.recurse", "true"]);
      await gitExec(repo, ["config", "core.fsmonitor", "true"]);
      const pre = await evidencePreflight(repo);
      expect(pre !== null, "preflight failed").toBe(true);
      // The two submodule-recursion levers are STATIC-owned: they must
      // produce NO dynamic pin and NO refusal — the static `=false` pin is
      // the sole guard. (core.fsmonitor is deliberately NOT static-owned —
      // a boolean file value produces a dynamic `-c core.fsmonitor=`
      // empty pin, which empirically disables it; a command-valued file
      // entry is REFUSE'd outright.)
      const dynamicPins = (pre?.configArgs ?? []).join(" ").toLowerCase();
      for (const k of ["fetch.recursesubmodules", "submodule.recurse"]) {
        expect
          .soft(
            !dynamicPins.includes(`${k}=`),
            `${k} produced a dynamic re-pin — the static pin should own it`,
          )
          .toBe(true);
      }
      // core.fsmonitor=true must land the empty pin (kills the file
      // value); a program value must REFUSE the channel instead.
      expect
        .soft(
          dynamicPins.includes("core.fsmonitor="),
          "core.fsmonitor=true produced no dynamic pin",
        )
        .toBe(true);
      const { repo: repo2 } = await initRepoWithOrigin(dirs, { prefix: "cx8-fsm-" });
      await gitExec(repo2, ["config", "core.fsmonitor", "/tmp/cx8-fsm.sh"]);
      const pre2 = await evidencePreflight(repo2);
      expect
        .soft(
          pre2 !== null && pre2.refusedKeys.includes("core.fsmonitor"),
          "a program-valued core.fsmonitor did not refuse the channel",
        )
        .toBe(true);
      // Live: a fetch still works with all three set (no recursion, no
      // fsmonitor exec) — core.hooksPath is pinned for non-config reads.
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect.soft(fetch.exitCode, `fetch failed: ${fetch.stderr.slice(0, 100)}`).toBe(0);
      // `config --get core.hooksPath` deliberately answers the REAL repo
      // value (the install/check surface judges drift through it) — but a
      // hook-invoking read must get the pinned empty dir instead.
      await gitExec(repo, ["config", "core.hooksPath", "/tmp/cx8-evil-hooks"]);
      const cfg = await gitEvidence(repo, ["config", "--get", "core.hooksPath"]);
      expect
        .soft(
          cfg.exitCode === 0 && cfg.stdout.trim() === "/tmp/cx8-evil-hooks",
          `config --get core.hooksPath did not answer the real value: ${cfg.stdout.trim()}`,
        )
        .toBe(true);
      // And a non-config read must NOT see /tmp/cx8-evil-hooks — the pin
      // argv carries the mkdtemp dir instead (last -c wins).
      const pins = evidencePinArgs(["status", "--porcelain"], pre);
      const hpIdx = pins.findIndex((a) => a.startsWith("core.hooksPath="));
      expect
        .soft(
          hpIdx !== -1 && !pins[hpIdx]!.includes("/tmp/cx8-evil-hooks"),
          `non-config evidence argv lacks the hooksPath pin (pins=${pins.filter((a) => a.includes("hooksPath")).join(",")})`,
        )
        .toBe(true);
    },
  );
});

// ===========================================================================
// G. hold probes — representative r7 fixes still closed
// ===========================================================================

describe("RFC-1616 r8 — closed-surface re-verification", () => {
  it(
    "R8-R1: CX-94 stays dead — a non-default remote.origin.fetch still refuses the channel and the pinned fetch writes no x-* branches",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-hold-fetchcfg-" });
      await gitExec(repo, ["config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/heads/x-*"]);
      const fetch = await gitEvidence(repo, [
        "fetch",
        "--prune",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      expect(fetch.stderr.startsWith("EVIDENCE-REFUSED")).toBe(true);
      const heads = gitIn(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).trim();
      expect(heads).not.toContain("x-");
    },
  );

  it(
    "R8-R2: CX-97 stays dead — verifierGit still refuses `@{`/`@{u}`/`log -g` argv",
    { timeout: 60_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-hold-at-" });
      for (const argv of [
        ["rev-parse", "--verify", "-q", "HEAD@{1}"],
        ["rev-list", "HEAD@{1}..HEAD"],
        ["log", "-g", "--format=%gs", "-1"],
        ["merge-base", "--fork-point", "HEAD", "HEAD"],
      ]) {
        const r = await verifierGit(repo, argv);
        expect
          .soft(
            r.exitCode !== 0 && r.stderr.includes("EVIDENCE-REFUSED"),
            `verifierGit admitted ${argv.join(" ")}`,
          )
          .toBe(true);
      }
    },
  );

  it(
    "R8-R3: CX-100 stays dead — `cat <<-EOF` with a SPACE-indented terminator is still not adopted",
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
      expect(adoptedWorkflow(wf), "space-indented terminator still adopts").toBe(false);
    },
  );

  it(
    "R8-R4: CX-102 stays dead — a utf-16-encoded trailer commit is still flagged by the push scan",
    { timeout: 120_000 },
    async () => {
      const { repo } = await initRepoWithOrigin(dirs, { prefix: "cx8-hold-enc-" });
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
      const objPath = path.join(path.dirname(repo), "cobj8");
      writeFileSync(objPath, obj);
      const encSha = gitIn(repo, ["hash-object", "-t", "commit", "-w", objPath]).trim();
      gitIn(repo, ["update-ref", "refs/heads/develop", encSha]);
      const digest = await collectDigest(repo, ambientIo, { fetch: true });
      expect(
        digest.correctnessTrail.verifierCommits.some((c) => c.sha === encSha),
        "digest missed the encoding-garbled trailer commit",
      ).toBe(true);
      const data = await pushFlow(repo, ambientIo, { digest: digest.digestId, dryRun: false });
      expect(
        (data.verifierTrailerCommits ?? []).some((h) => h.sha === encSha),
        "pushFlow shipped the encoding-garbled trailer commit unflagged",
      ).toBe(true);
    },
  );

  it(
    "R8-R5: CX-87 stays dead — the hooks dir is still mkdtemp-randomised, a pre-planted forge-evidence-hooks-<pid> never reaches the pinned fetch",
    { timeout: 120_000 },
    async () => {
      const { repo, parent } = await initRepoWithOrigin(dirs, { prefix: "cx8-hold-hookdir-" });
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
      expect(existsSync(marker), "a stale forge-evidence-hooks-<pid> hooked the trusted fetch").toBe(
        false,
      );
      rmSync(stale, { recursive: true, force: true });
    },
  );

  it(
    "R8-R6: CX-96 stays dead — config source flags are still refused in every ordering",
    { timeout: 60_000 },
    () => {
      for (const argv of [
        ["config", "--get", "--worktree", "core.hooksPath"],
        ["config", "--worktree", "--get", "core.hooksPath"],
        ["config", "--get", "--file", "/tmp/x", "k"],
        ["config", "--get-all", "--blob", "HEAD:cfg", "k"],
        ["config", "--get-regexp", "--file=/tmp/x", ".*"],
        ["config", "--local", "--no-includes", "--list", "--file=/tmp/x"],
        ["config", "--get", "--default", "x", "k"],
      ]) {
        expect
          .soft(isEvidenceGitQuery(argv), `${argv.join(" ")} admitted an alternate source`)
          .toBe(false);
      }
    },
  );
});
