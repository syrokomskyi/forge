/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-13 adversarial verification of
the external-verification trust boundary. Every probe FAILS while its
counterexample is live and PASSES once closed; numbering continues from
CX-135 (round 12 reported CX-132..CX-135). The verifier labels the six
findings R13-A1..R13-D1; they map to CX-136..CX-141.

Round-13 attack surfaces (assumptions the r12 remediation left open):

  - `EvidenceFingerprint.shapeFiles` pinned PRESENCE only (CX-136/137/138).
    A same-uid session pre-seeds an EMPTY `info/grafts`, `.git/shallow`,
    or `info/attributes` BEFORE the cached OriginGit preflight — the judge
    sees no effective content, the fingerprint records present:true —
    then arms the file AFTER the cache fills and no fingerprinted
    dimension changes. Presence→armed transitions were invisible to
    reprove, deterministically reviving CX-79 (grafted ancestry), shallow
    truncation, and CX-125 (working-tree-encoding clean-on-dirty). The
    fingerprint now pins CONTENT bytes per shape file and reprove
    byte-compares — a presence-preserving arm is drift.
  - `.git/worktrees/<id>/` admin state was unjudged (CX-139) — a
    hand-crafted admin dir (gitdir + HEAD + a session-owned target with a
    matching `.git`) produced a phantom `worktree list --porcelain`
    entry on all three channels. The judge now requires the well-formed
    admin shape `git worktree add` itself writes (gitdir naming a `.git`
    target, commondir resolving back to the common dir, symref|sha HEAD,
    DIRC index when present) and the fingerprint pins the whole
    `<common>/worktrees` subtree.
  - `.git/forge/journal.jsonl` is session-writable yet fed
    `pendingPublications` (CX-140): a fabricated `push` record minted a
    pending publication for a never-pushed tag that flow.push then
    extracted and published. Journal records are now suppressor-only —
    they can hide a tag from digest.tags (availability bound) but never
    mint eligibility: pending/superseded publication lists stay empty
    and publish candidates derive from this run's pushed tags alone.
  - The re-preflight was never re-proven and the held-config pin was
    fictional (CX-141): after a failed reprove the channels re-ran the
    whole preflight once and spawned without a second reprove — a
    config flipper landed `include.path`→`diff.external` inside trusted
    spawns (~18%/call) — and `GIT_CONFIG_LOCAL`, the variable meant to
    pin the judged config bytes, does not exist in git at all (a no-op
    env entry). The bounded reprove loop now re-judges until the last
    check lands immediately before the spawn, and every lever the live
    config could arm is dead at the child: the literal lever keyspace
    rides unconditional `GIT_CONFIG_KEY_n` env pins, `GIT_ATTR_SOURCE`
    pins the empty tree so no attribute ever engages a config-named
    program, upstream-fabricating atoms/forms are argv-refused,
    `info/exclude` presence refuses the channel outright, and diff-capable
    trusted argv carries `--no-ext-diff` so even a `diff.external` armed
    in the residual reprove→spawn window cannot exec.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the boundary implementation owns behaviour.</item>
  <item>The residual microsecond reprove→spawn window — narrowed to a
    byte-compare by the fingerprint reprove, never a stale judgment.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { pushFlow } from "../../flow/handlers/flow-push.ts";
import { markerContent } from "../../flow/markers.ts";
import { releaseTagAnnotation, writeReleaseTag } from "../../flow/release-tags.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";
import { gitExec, initRepoWithOrigin } from "../../flow/tests/helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const gitIn = (root: string, args: string[], input?: string | Buffer) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input,
  });

function repo(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "t@t"]);
  gitIn(root, ["config", "user.name", "t"]);
  gitIn(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

// ===========================================================================
// CX-136..138 — shape-file CONTENT is fingerprinted: pre-seeded empty files
// armed after the cached OriginGit preflight are drift, not stable state.
// ===========================================================================

describe("RFC-1616 r13 — shape-file content fingerprint on the cached channel", () => {
  it(
    "CX-136: a pre-seeded EMPTY .git/info/grafts armed after cache fill " +
      "can no longer forge rev-list/merge-base answers (CX-79/CX-134 revival)",
    { timeout: 60_000 },
    async () => {
      const root = repo("r13-grafts-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      writeFileSync(path.join(root, "a.txt"), "b\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "B"]);
      const A = gitIn(root, ["rev-parse", "HEAD~1"]).trim();
      const B = gitIn(root, ["rev-parse", "HEAD"]).trim();

      // Attacker plants the inert file BEFORE the verifier first looks.
      mkdirSync(path.join(root, ".git/info"), { recursive: true });
      writeFileSync(path.join(root, ".git/info/grafts"), "");

      const og = createOriginGit(root);
      await og.run(["rev-parse", "HEAD"]); // fill the cached preflight

      // Premise check: truth is 2 commits; A is an ancestor of B.
      expect(gitIn(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
      expect(spawnSync("git", ["merge-base", "--is-ancestor", A, B], { cwd: root }).status).toBe(0);

      // Arm the graft AFTER the cached preflight — presence unchanged,
      // content bytes differ → drift → re-preflight → violation.
      writeFileSync(path.join(root, ".git/info/grafts"), `${B} \n`);

      const count = await og.run(["rev-list", "--count", "HEAD"]);
      expect(
        count === null || count.trim() !== "1",
        `cached OriginGit rev-list served grafted history: ${JSON.stringify(count)}`,
      ).toBe(true);

      const mb = await og.runExit?.(["merge-base", "--is-ancestor", A, B]);
      expect(
        mb === null || mb === undefined || mb.code !== 1,
        `cached OriginGit merge-base served the grafted 'not ancestor' verdict`,
      ).toBe(true);
    },
  );

  it(
    "CX-137: a pre-seeded EMPTY .git/shallow armed after cache fill " +
      "can no longer truncate trusted history",
    { timeout: 60_000 },
    async () => {
      const root = repo("r13-shallow-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "A"]);
      writeFileSync(path.join(root, "a.txt"), "b\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "B"]);
      const B = gitIn(root, ["rev-parse", "HEAD"]).trim();

      writeFileSync(path.join(root, ".git/shallow"), "");

      const og = createOriginGit(root);
      await og.run(["rev-parse", "HEAD"]); // fill the cached preflight

      writeFileSync(path.join(root, ".git/shallow"), `${B}\n`);

      const count = await og.run(["rev-list", "--count", "HEAD"]);
      expect(
        count === null || count.trim() !== "1",
        `cached OriginGit rev-list served shallow-truncated history: ${JSON.stringify(count)}`,
      ).toBe(true);
    },
  );

  it(
    "CX-138: a pre-seeded EMPTY .git/info/attributes armed after cache fill " +
      "can no longer answer status clean on foreign-encoded bytes (CX-125 revival)",
    { timeout: 60_000 },
    async () => {
      const root = repo("r13-attr-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      mkdirSync(path.join(root, ".git/info"), { recursive: true });
      writeFileSync(path.join(root, ".git/info/attributes"), "");

      const og = createOriginGit(root);
      await og.run(["status", "--porcelain"]); // fill the cached preflight

      writeFileSync(
        path.join(root, ".git/info/attributes"),
        "a.txt working-tree-encoding=UTF-16LE\n",
      );
      writeFileSync(path.join(root, "a.txt"), Buffer.from("good\n", "utf16le"));

      const st = await og.run(["status", "--porcelain"]);
      expect(
        st === null || st.trim().length > 0,
        `cached OriginGit status answered clean on foreign-encoded bytes (${JSON.stringify(st)})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-139 — .git/worktrees/<id>/ admin state is judged + fingerprinted.
// ===========================================================================

describe("RFC-1616 r13 — session-fabricated worktree admin state", () => {
  it(
    "CX-139: a hand-crafted .git/worktrees/<id> produces no phantom " +
      "worktree list entry on any trusted channel",
    { timeout: 60_000 },
    async () => {
      const root = repo("r13-wt-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const wt = mkdtempSync(path.join(os.tmpdir(), "r13-fakewt-"));
      dirs.push(wt);
      const meta = path.join(root, ".git/worktrees/fake1");
      mkdirSync(meta, { recursive: true });
      writeFileSync(path.join(meta, "gitdir"), `${wt}/.git\n`);
      writeFileSync(path.join(meta, "HEAD"), gitIn(root, ["symbolic-ref", "HEAD"]));
      writeFileSync(path.join(wt, ".git"), `gitdir: ${meta}\n`);

      // Premise: raw git already lists the phantom.
      expect(gitIn(root, ["worktree", "list", "--porcelain"])).toContain(`worktree ${wt}`);

      for (const [name, out] of [
        ["gitEvidence", await gitEvidence(root, ["worktree", "list", "--porcelain"])],
        ["verifierGit", await verifierGit(root, ["worktree", "list", "--porcelain"])],
      ] as const) {
        expect(
          !(out.exitCode === 0 && out.stdout.includes(`worktree ${wt}`)),
          `${name} served a session-fabricated worktree entry: ${JSON.stringify(out.stdout)}`,
        ).toBe(true);
      }

      const og = createOriginGit(root);
      const ogOut = await og.run(["worktree", "list", "--porcelain"]);
      expect(
        ogOut === null || !ogOut.includes(`worktree ${wt}`),
        `OriginGit served a session-fabricated worktree entry: ${JSON.stringify(ogOut)}`,
      ).toBe(true);
    },
  );

  it(
    "CX-139b: a real `git worktree add` entry stays served — the judge " +
      "pins well-formedness, not presence",
    { timeout: 60_000 },
    async () => {
      const root = repo("r13-realwt-");
      writeFileSync(path.join(root, "a.txt"), "a\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const wt = path.join(root, "linked");
      gitIn(root, ["worktree", "add", wt, "-b", "linked-branch"]);
      dirs.push(wt);

      const out = await gitEvidence(root, ["worktree", "list", "--porcelain"]);
      expect(
        out.exitCode === 0 && out.stdout.includes(`worktree ${wt}`),
        `gitEvidence dropped a real worktree entry: ${JSON.stringify(out)}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-140 — the flow journal is suppressor-only: fabricated `push` records
// neither mint pendingPublications nor reach a publish.
// ===========================================================================

async function addPackageLine(repo: string): Promise<void> {
  mkdirSync(path.join(repo, "packages", "lib"), { recursive: true });
  writeFileSync(
    path.join(repo, "packages", "lib", "extract.config.yaml"),
    "standalone: true\ndestName: lib-export\n",
  );
  writeFileSync(
    path.join(repo, "packages", "lib", "package.json"),
    '{\n  "name": "lib",\n  "version": "9.9.9"\n}\n',
  );
  writeFileSync(path.join(repo, "packages", "lib", "forge.generated.yaml"), markerContent("test"));
  await gitExec(repo, ["add", "-A"]);
  await gitExec(repo, ["commit", "-m", "package line lib"]);
  const push = await gitExec(repo, ["push", "origin", "develop"]);
  if (push.exitCode !== 0) throw new Error(`push failed: ${push.stderr}`);
}

describe("RFC-1616 r13 — session-written push journal cannot fabricate publication", () => {
  it(
    "CX-140: a fabricated journal `push` record mints no pendingPublication " +
      "and flow.push never publishes on journal provenance alone",
    { timeout: 120_000 },
    async () => {
      const { repo, extractLog } = await initRepoWithOrigin(dirs, {
        prefix: "r13-journal-",
        fakeExtract: true,
      });
      await addPackageLine(repo);
      const tip = (await gitExec(repo, ["rev-parse", "develop"])).stdout.trim();
      const res = await writeReleaseTag(repo, ambientIo, {
        name: "lib@9.9.9",
        target: tip,
        annotation: releaseTagAnnotation({
          tag: "lib@9.9.9",
          line: "lib",
          version: "9.9.9",
          level: "minor",
          previous: null,
          rfcs: [],
          fingerprints: {},
        }),
      });
      if (res.exitCode !== 0) throw new Error(`tag failed: ${res.stderr}`);

      // Session writes a journal record claiming the flow pushed the tag —
      // the file is <common-gitdir>/forge/journal.jsonl, session-writable.
      const journalFile = path.join(repo, ".git", "forge", "journal.jsonl");
      mkdirSync(path.dirname(journalFile), { recursive: true });
      appendFileSync(
        journalFile,
        `${JSON.stringify({
          at: new Date().toISOString(),
          event: "push",
          branch: "develop",
          sha: tip,
          detail: "lib@9.9.9",
        })}\n`,
      );

      const digest = await collectDigest(repo, ambientIo, { fetch: false });
      const fabricatedPending = digest.pendingPublications.some((p) => p.tag === "lib@9.9.9");

      // Consequence check: pushFlow must not publish the fabricated tag —
      // journal provenance is suppressor-only under the same-uid model.
      const data = await pushFlow(repo, ambientIo, {
        digest: digest.digestId,
        dryRun: false,
      });
      const attempted = data.publications.filter((p) => p.tag === "lib@9.9.9");
      console.log(
        `CX-140: pendingPublications=${JSON.stringify(digest.pendingPublications)} ` +
          `publications=${JSON.stringify(data.publications.map((p) => ({ tag: p.tag, status: p.status })))} ` +
          `extractLog=${existsSync(extractLog) ? "written" : "absent"}`,
      );
      expect(
        !fabricatedPending,
        `fabricated journal record produced a pendingPublication for a tag the flow never pushed: ${JSON.stringify(digest.pendingPublications)}`,
      ).toBe(true);
      expect(
        attempted.length === 0 || attempted.every((p) => p.status !== "published"),
        `flow.push published a tag whose only provenance is a forged journal line: ${JSON.stringify(attempted)}`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-141 — the re-preflight is re-proven in a bounded loop and every spawn
// reads the JUDGED config bytes through a verifier-held fd.
// ===========================================================================

describe("RFC-1616 r13 — pinned config bytes + bounded reprove loop", () => {
  it(
    "CX-141: a config flipper can never land include.path+diff.external " +
      "inside the trusted diff spawn — judged bytes are spawned bytes",
    { timeout: 300_000 },
    async () => {
      const root = repo("r13-race-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      writeFileSync(path.join(root, "a.txt"), "dirty\n"); // keep a diff alive

      const attack = mkdtempSync(path.join(os.tmpdir(), "r13-race-atk-"));
      dirs.push(attack);
      const script = path.join(attack, "evil-diff.sh");
      writeFileSync(script, "#!/bin/sh\necho FORGED-DIFF-OUTPUT\n");
      chmodSync(script, 0o755);
      const inc = path.join(attack, "inc.cfg");
      writeFileSync(inc, `[diff]\n\texternal = ${script}\n`);

      const configPath = path.join(root, ".git", "config");
      const clean = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n[user]\n\temail = t@t\n\tname = t\n[commit]\n\tgpgsign = false\n`;
      const dirty = `${clean}[include]\n\tpath = ${inc}\n`;
      // Ensure the starting state is clean-config.
      writeFileSync(configPath, clean);

      let stop = false;
      const flipper = setInterval(() => {
        try {
          writeFileSync(configPath, Math.random() < 0.5 ? clean : dirty);
        } catch {
          /* ignore */
        }
      }, 5);

      let forged = 0;
      let refused = 0;
      let honest = 0;
      try {
        for (let i = 0; i < 300; i++) {
          const r = await gitEvidence(root, ["diff", "HEAD", "--", "a.txt"]);
          if (r.stdout.includes("FORGED-DIFF-OUTPUT")) forged++;
          else if (r.exitCode !== 0 || r.stderr.includes("EVIDENCE-REFUSED")) refused++;
          else honest++;
        }
      } finally {
        stop = true;
        clearInterval(flipper);
      }
      void stop;
      console.log(
        `CX-141 tally over 300 calls: forged=${forged} refused-or-failed=${refused} honest=${honest}`,
      );
      expect(
        forged,
        `include.path+diff.external reached the trusted spawn ${forged} time(s) during re-preflight`,
      ).toBe(0);
    },
  );
});
