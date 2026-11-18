/*
<MODULE_CONTRACT>
<purpose>
RFC-1616 acceptance probes — independent round-12 adversarial verification of
the external-verification trust boundary. Every probe FAILS while its
counterexample is live and PASSES once closed; numbering continues from
CX-131 (round 11 reported CX-125..CX-131 + controls).

Round-12 attack surfaces (assumptions the r11 remediation left open):

  - `remote.<name>.url` is still KEEP-classed. R11's CX-131 fix refused
    `url.*.(push)?insteadOf` and pinned `protocol.file.allow=never` on
    ls-remote/fetch — but the URL VALUE itself is never judged: a session
    `remote.origin.url = git://127.0.0.1:<port>/<repo>` (or `http://` to a
    dumb-protocol server — verified out-of-band — or `ssh://`) points every
    trusted `ls-remote origin`/`fetch origin` at a session-owned daemon.
    The daemon authors refs, tags, FETCH_HEAD and tracking refs —
    remoteTips, tagReachable and the push scan's remote view are forged
    (CX-132). The same hole exists for a literal `git://`/`http://`
    positional in the argv tail — no remote name needed (also CX-132).
  - `isUnprovenIndexRead`'s grep branch counts the FIRST bare token after
    the head as the pattern — but `git grep <pattern> <nonrev-path>` (no
    `--`) treats the path as a WORKTREE pathspec: it counts as a "rev", so
    the shape is classified tree-anchored and proceeds on the ambient
    index when the claims-index rebuild is unproven. A session-authored
    ambient index (here: `skip-worktree`) then decides the verdict —
    trusted grep answers exit 1 / "" on a file containing the pattern
    (CX-133). The `-e <pattern> <path>` spelling misses the same check.
  - `createOriginGit` caches `evidenceRepoPreflight` for the instance
    lifetime. Every per-call channel (verifierGit/gitEvidence) re-judges
    `.git/` on each spawn; a cached OriginGit never re-judges — so a
    same-uid session writes surface material AFTER the cache fills and
    the trusted reads judge a stale world:
      * unlink + rewrite a loose object at HEAD's sha → `og.run log` /
        `cat-file -p` serve forged commit bytes (CX-134) — loose objects
        are trusted-by-name, git never rehashes them on read;
      * create `.git/info/attributes` post-preflight (EVIDENCE_SHAPE_PATHS
        judges it — but only AT preflight time) → `working-tree-encoding`
        makes `status` answer clean on dirty bytes (CX-135);
      * inject `include.path` in `.git/config` → `diff.external` execs a
        session program inside the trusted diff (CX-135);
      * set `core.worktree` post-preflight → `status`/`diff`/`grep`
        enumerate a session twin worktree → clean verdict on a dirty
        real worktree (CX-135);
      * inject `filter.<f>.clean` post-preflight → a session program
        execs inside `diff` and rewrites the hashed worktree bytes —
        even keys the EXEC class would have pinned to `cat` are live
        because pins derive only from the captured dump (CX-135).
    The refuse-on-presence classes (include.path, core.worktree, shape
    paths) and every dump-driven pin are all live again post-preflight
    on the cached channel.
</purpose>
<non-goals>
  <item>Not a contract source of truth — the boundary implementation owns behaviour.</item>
  <item>The narrow preflight→spawn race on the per-call channels (ms window
    needing a concurrent writer); the OriginGit cache is the deterministic
    witness of the same root cause.</item>
</non-goals>
</MODULE_CONTRACT>
*/

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";
import { createOriginGit } from "../../rfc/verification-origin.ts";

const dirs: string[] = [];
const daemons: ChildProcess[] = [];
afterEach(() => {
  for (const d of daemons.splice(0)) d.kill();
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

/** `git daemon` serving `serveDir` on a free loopback port → the url. */
async function serveDaemon(serveDir: string): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
  const daemon = spawn("git", [
    "daemon",
    "--export-all",
    "--reuseaddr",
    `--base-path=${serveDir}`,
    "--listen=127.0.0.1",
    `--port=${port}`,
  ]);
  daemons.push(daemon);
  return `git://127.0.0.1:${port}`;
}

async function waitDaemon(url: string, probeCwd: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      gitIn(probeCwd, ["ls-remote", url]);
      return;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** A second repo behind a session-owned daemon, exporting one forged tag. */
async function forgedRemote(prefix: string): Promise<string> {
  const fake = repo(prefix);
  writeFileSync(path.join(fake, "f.txt"), "FORGED\n");
  gitIn(fake, ["add", "-A"]);
  gitIn(fake, ["commit", "-qm", "forged"]);
  gitIn(fake, ["tag", "v9.9.9"]);
  const base = await serveDaemon(path.dirname(fake));
  const url = `${base}/${path.basename(fake)}`;
  await waitDaemon(url, fake);
  return url;
}

// ===========================================================================
// CX-132 — session-authored remote target steers trusted transports
// ===========================================================================

describe("RFC-1616 r12 — trusted ls-remote/fetch contact session-chosen transport targets", () => {
  it(
    "CX-132a: KEEP-classed `remote.origin.url` pointing at a session `git://` daemon makes trusted `ls-remote origin`/`fetch origin` answer the daemon's forged refs on all three channels",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-remote-");
      writeFileSync(path.join(root, "a.txt"), "real\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "real"]);
      const url = await forgedRemote("cx12-fake-");
      gitIn(root, ["config", "remote.origin.url", url]);

      // Premise: raw git contacts the daemon through the config URL.
      expect(gitIn(root, ["ls-remote", "--tags", "origin"])).toContain("v9.9.9");

      const e = await gitEvidence(root, ["ls-remote", "--tags", "origin"]);
      const v = await verifierGit(root, ["ls-remote", "--tags", "origin"]);
      const og = await createOriginGit(root).run(["ls-remote", "--tags", "origin"]);
      const f = await gitEvidence(root, [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      const refs = await gitEvidence(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin",
      ]);

      const leaks = [
        ["gitEvidence ls-remote", e.exitCode !== 0 || !e.stdout.includes("v9.9.9"), e.stdout],
        ["verifierGit ls-remote", v.exitCode !== 0 || !v.stdout.includes("v9.9.9"), v.stdout],
        ["OriginGit ls-remote", og === null || !og.includes("v9.9.9"), og],
        [
          "gitEvidence fetch",
          f.exitCode !== 0 || (refs.exitCode === 0 && refs.stdout.trim() === ""),
          `fetch exit=${f.exitCode} refs=${refs.stdout.trim()}`,
        ],
      ] as const;
      for (const [label, honest, seen] of leaks) {
        expect(
          honest,
          `${label} answered the session daemon's forged view: ${JSON.stringify(seen)}`,
        ).toBe(true);
      }
    },
  );

  it(
    "CX-132b: a literal `git://` URL positional in `ls-remote`/`fetch` argv is judged only by the refspec regex — the transport target itself is unjudged and contacts the session daemon",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-liturl-");
      writeFileSync(path.join(root, "a.txt"), "real\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "real"]);
      const url = await forgedRemote("cx12-litfake-");

      const r = await gitEvidence(root, ["ls-remote", "--tags", url]);
      const vr = await verifierGit(root, ["ls-remote", "--tags", url]);
      const og = await createOriginGit(root).run(["ls-remote", "--tags", url]);
      const f = await gitEvidence(root, [
        "fetch",
        "--no-tags",
        url,
        "+refs/heads/*:refs/remotes/origin/*",
      ]);
      const refs = await gitEvidence(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin",
      ]);

      const leaks = [
        ["gitEvidence ls-remote", r.exitCode !== 0 || !r.stdout.includes("v9.9.9"), r.stdout],
        ["verifierGit ls-remote", vr.exitCode !== 0 || !vr.stdout.includes("v9.9.9"), vr.stdout],
        ["OriginGit ls-remote", og === null || !og.includes("v9.9.9"), og],
        [
          "gitEvidence fetch",
          f.exitCode !== 0 || (refs.exitCode === 0 && refs.stdout.trim() === ""),
          `fetch exit=${f.exitCode} refs=${refs.stdout.trim()}`,
        ],
      ] as const;
      for (const [label, honest, seen] of leaks) {
        expect(
          honest,
          `${label} answered the session daemon's forged view: ${JSON.stringify(seen)}`,
        ).toBe(true);
      }
    },
  );
});

// ===========================================================================
// CX-133 — grep no-separator nonrev-pathspec shape evades index classification
// ===========================================================================

describe("RFC-1616 r12 — unproven-index grep shapes", () => {
  it(
    "CX-133: `grep <pattern> <existing-path>` and `grep -e <pattern> <existing-path>` (no `--`) are worktree greps — but the path counts as a rev, so the shape proceeds on the AMBIENT index when the claims rebuild is unproven; a session-authored ambient index decides the verdict on all three channels",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-grep-");
      writeFileSync(path.join(root, "a.txt"), "needle\n");
      writeFileSync(path.join(root, "b.txt"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      // A VALID session index carrying skip-worktree — not corrupt, so the
      // ambient index itself is the forgery the unproven branch falls back
      // to whenever the verifier's rebuild cannot run.
      gitIn(root, ["update-index", "--skip-worktree", "a.txt"]);

      // Premise: ambient index hides the file from a no-separator grep.
      let missed = false;
      try {
        gitIn(root, ["grep", "-l", "needle", "a.txt"]);
      } catch {
        missed = true;
      }
      expect(missed, "premise: ambient-index grep must miss the skip-worktree file").toBe(true);

      // Session env lever: TMPDIR points at a nonexistent dir — the held
      // claims-index mkdtemp fails → every preflight's index is unproven.
      const saved = {
        TMPDIR: process.env["TMPDIR"],
        TMP: process.env["TMP"],
        TEMP: process.env["TEMP"],
      };
      process.env["TMPDIR"] = "/nonexistent-forge-cx12";
      process.env["TMP"] = "/nonexistent-forge-cx12";
      process.env["TEMP"] = "/nonexistent-forge-cx12";
      try {
        // Control: a properly classified index op still refuses.
        const st = await gitEvidence(root, ["status", "--porcelain"]);
        expect(
          st.exitCode !== 0 && st.stderr.includes("EVIDENCE-REFUSED"),
          `control: unproven status did not refuse (exit=${st.exitCode})`,
        ).toBe(true);

        // Ambient hides the file → the forged answer is a miss (exit 1).
        const ge = await gitEvidence(root, ["grep", "-l", "needle", "a.txt"]);
        const gee = await gitEvidence(root, ["grep", "-l", "-e", "needle", "a.txt"]);
        const vg = await verifierGit(root, ["grep", "-l", "needle", "a.txt"]);

        // OriginGit signature cannot separate a refusal (code≠0, empty
        // stdout) from a genuine miss — flip the ambient index to SHOW the
        // file so proceeding-on-ambient yields a positive answer while the
        // honest outcome is still refusal.
        gitIn(root, ["update-index", "--no-skip-worktree", "a.txt"]);
        const og = await createOriginGit(root).run(["grep", "-l", "needle", "a.txt"]);

        const leaks = [
          ["gitEvidence grep -l needle a.txt", ge, ge.stderr.includes("EVIDENCE-REFUSED")],
          ["gitEvidence grep -l -e needle a.txt", gee, gee.stderr.includes("EVIDENCE-REFUSED")],
          ["verifierGit grep -l needle a.txt", vg, vg.stderr.includes("EVIDENCE-REFUSED")],
        ] as const;
        for (const [label, r, refused] of leaks) {
          expect(
            r.exitCode !== 0 && refused,
            `${label} answered the ambient forgery instead of refusing (exit=${r.exitCode}, out=${JSON.stringify(r.stdout)})`,
          ).toBe(true);
        }
        expect(
          og === null,
          `OriginGit grep -l needle a.txt must refuse on unproven index, answered ${JSON.stringify(og)}`,
        ).toBe(true);
      } finally {
        if (saved.TMPDIR === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = saved.TMPDIR;
        if (saved.TMP === undefined) delete process.env["TMP"];
        else process.env["TMP"] = saved.TMP;
        if (saved.TEMP === undefined) delete process.env["TEMP"];
        else process.env["TEMP"] = saved.TEMP;
      }
    },
  );
});

// ===========================================================================
// CX-134 — cached-preflight OriginGit serves post-preflight loose objects
// ===========================================================================

describe("RFC-1616 r12 — post-preflight object-store forgery on the cached channel", () => {
  it(
    "CX-134: a loose object rewritten AFTER createOriginGit's cached preflight is served verbatim by og.run (loose objects are trusted-by-name — git never rehashes them on read); the per-call channels re-scan and refuse",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-loose-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);
      const head = gitIn(root, ["rev-parse", "HEAD"]).trim();

      // Fill the OriginGit preflight cache on the clean surface.
      const og = createOriginGit(root);
      const before = await og.run(["log", "-1", "--format=%B", "HEAD"]);
      expect(before?.trim(), "premise: pre-attack log must answer the real message").toBe("seed");

      // Session rewrite: loose shadows packed; the file at HEAD's fanout
      // path is trusted-by-name for the sha it lives at.
      const realCommit = gitIn(root, ["cat-file", "commit", head]);
      const forged = realCommit.replace("seed", "FORGED-MSG");
      const payload = Buffer.concat([
        Buffer.from(`commit ${Buffer.byteLength(forged)}\0`),
        Buffer.from(forged),
      ]);
      const looseDir = path.join(root, ".git/objects", head.slice(0, 2));
      const looseFile = path.join(looseDir, head.slice(2));
      chmodSync(looseDir, 0o755); // git loose dirs may be read-only
      rmSync(looseFile, { force: true });
      writeFileSync(looseFile, deflateSync(payload));

      // Premise: raw git serves the forged bytes (no rehash on loose read).
      expect(gitIn(root, ["log", "-1", "--format=%B", "HEAD"]).trim()).toBe("FORGED-MSG");

      // Controls: the per-call channels' fresh loose-object scan catches it.
      const v = await verifierGit(root, ["cat-file", "-p", head]);
      expect(
        v.exitCode !== 0 && !v.stdout.includes("FORGED-MSG"),
        `verifierGit served the post-attack forged loose object (exit=${v.exitCode})`,
      ).toBe(true);
      const e = await gitEvidence(root, ["cat-file", "-p", head]);
      expect(
        e.exitCode !== 0 && !e.stdout.includes("FORGED-MSG"),
        `gitEvidence served the post-attack forged loose object (exit=${e.exitCode})`,
      ).toBe(true);
      // Control: the batch channel's per-record rehash must degrade to null.
      const sm = await og.showMany?.([head]);
      expect(
        sm === null || sm === undefined || sm[0] === null || sm[0] === undefined,
        `OriginGit showMany must never serve forged bytes under a real sha (${JSON.stringify(sm)})`,
      ).toBe(true);

      // The cached channel still answers the pre-attack surface.
      const after = await og.run(["log", "-1", "--format=%B", "HEAD"]);
      const cf = await og.run(["cat-file", "-p", head]);
      expect(
        after === null || after.trim() === "seed",
        `cached OriginGit log served the post-preflight forged commit (${JSON.stringify(after)})`,
      ).toBe(true);
      expect(
        cf === null || !cf.includes("FORGED-MSG"),
        `cached OriginGit cat-file -p served the post-preflight forged commit (${JSON.stringify(cf?.slice(0, 120))})`,
      ).toBe(true);
    },
  );
});

// ===========================================================================
// CX-135 — cached-preflight OriginGit honors post-preflight .git/ injections
// ===========================================================================

describe("RFC-1616 r12 — post-preflight config/shape injections on the cached channel", () => {
  it(
    "CX-135a: `.git/info/attributes` created AFTER the cached preflight is unjudged — `working-tree-encoding` makes the trusted status answer clean on dirty bytes",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-attr-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const og = createOriginGit(root);
      await og.run(["status", "--porcelain"]); // fill the cache

      // The shape path is refuse-on-presence — but only AT preflight.
      mkdirSync(path.join(root, ".git/info"), { recursive: true });
      writeFileSync(
        path.join(root, ".git/info/attributes"),
        "a.txt working-tree-encoding=UTF-16LE\n",
      );
      writeFileSync(path.join(root, "a.txt"), Buffer.from("good\n", "utf16le"));

      // Controls: the per-call channels refuse the new shape file.
      const e = await gitEvidence(root, ["status", "--porcelain"]);
      expect(
        e.exitCode !== 0 && e.stderr.includes("EVIDENCE-REFUSED"),
        `control: gitEvidence status must refuse the post-attack info/attributes (exit=${e.exitCode})`,
      ).toBe(true);

      const st = await og.run(["status", "--porcelain"]);
      expect(
        st === null || st.trim().length > 0,
        `cached OriginGit status answered clean on foreign-encoded bytes (${JSON.stringify(st)})`,
      ).toBe(true);
    },
  );

  it(
    "CX-135b: `include.path` injected into .git/config AFTER the cached preflight arms `diff.external` — a session program execs inside the trusted diff and forges its output",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-incl-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const og = createOriginGit(root);
      await og.run(["status", "--porcelain"]); // fill the cache

      const attack = mkdtempSync(path.join(os.tmpdir(), "cx12-attack-"));
      dirs.push(attack);
      const marker = path.join(attack, "exec-marker");
      const script = path.join(attack, "evil-diff.sh");
      writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\necho FORGED-DIFF-OUTPUT\n`);
      chmodSync(script, 0o755);
      const inc = path.join(attack, "inc.cfg");
      writeFileSync(inc, `[diff]\n\texternal = ${script}\n`);
      gitIn(root, ["config", "include.path", inc]);
      // diff.external only runs when there is a diff to produce.
      writeFileSync(path.join(root, "a.txt"), "dirty\n");

      const out = await og.run(["diff", "HEAD", "--", "a.txt"]);
      const execed = existsSync(marker);
      expect(
        out === null || !out.includes("FORGED-DIFF-OUTPUT"),
        `cached OriginGit diff executed diff.external and served session output (${JSON.stringify(out)})`,
      ).toBe(true);
      expect(
        execed,
        "cached OriginGit diff.external exec'd the session program (marker exists)",
      ).toBe(false);
    },
  );

  it(
    "CX-135c: `core.worktree` set AFTER the cached preflight redirects trusted status/diff at a session twin worktree — clean verdict on a dirty real worktree",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-wt-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      writeFileSync(path.join(root, "b.txt"), "x\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const og = createOriginGit(root);
      await og.run(["status", "--porcelain"]); // fill the cache

      // Twin worktree holding the committed bytes; real worktree goes dirty.
      const twin = mkdtempSync(path.join(os.tmpdir(), "cx12-twin-"));
      dirs.push(twin);
      writeFileSync(path.join(twin, "a.txt"), "good\n");
      writeFileSync(path.join(twin, "b.txt"), "x\n");
      writeFileSync(path.join(root, "a.txt"), "dirty\n");

      // Premise: raw git answers clean through the redirect while the real
      // worktree is dirty.
      expect(gitIn(root, ["status", "--porcelain"])).toContain(" M a.txt");
      gitIn(root, ["config", "core.worktree", twin]);
      try {
        expect(gitIn(root, ["status", "--porcelain"])).toBe("");

        const st = await og.run(["status", "--porcelain"]);
        expect(
          st === null || st.trim().length > 0,
          `cached OriginGit status answered clean through the worktree redirect (${JSON.stringify(st)})`,
        ).toBe(true);
      } finally {
        gitIn(root, ["config", "--unset", "core.worktree"]);
      }
    },
  );

  it(
    "CX-135d: `filter.<f>.clean` injected AFTER the cached preflight is unpinned (the EXEC class pins `=cat` only for keys present in the captured dump) — a session program execs inside the trusted diff and rewrites the hashed worktree bytes",
    { timeout: 120_000 },
    async () => {
      const root = repo("cx12-filter-");
      writeFileSync(path.join(root, "a.txt"), "good\n");
      gitIn(root, ["add", "-A"]);
      gitIn(root, ["commit", "-qm", "seed"]);

      const og = createOriginGit(root);
      await og.run(["status", "--porcelain"]); // fill the cache

      const attack = mkdtempSync(path.join(os.tmpdir(), "cx12-filter-atk-"));
      dirs.push(attack);
      const marker = path.join(attack, "exec-marker");
      const script = path.join(attack, "evil-clean.sh");
      writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nprintf 'FILTERED\\n'\n`);
      chmodSync(script, 0o755);
      // Session program as the clean filter + attributes naming the file —
      // both injected post-preflight.
      gitIn(root, ["config", "filter.evil.clean", script]);
      mkdirSync(path.join(root, ".git/info"), { recursive: true });
      writeFileSync(path.join(root, ".git/info/attributes"), "a.txt filter=evil\n");
      writeFileSync(path.join(root, "a.txt"), "TOTALLY DIFFERENT\n");

      const out = await og.run(["diff", "HEAD", "--", "a.txt"]);
      const execed = existsSync(marker);
      expect(
        execed === false,
        "cached OriginGit diff exec'd the post-preflight filter.clean program (marker exists)",
      ).toBe(true);
      expect(
        out === null || !out.includes("FILTERED"),
        `cached OriginGit diff served filter-rewritten bytes (${JSON.stringify(out)})`,
      ).toBe(true);
    },
  );
});
