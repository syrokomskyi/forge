/*
CX-r35-B (capture→mint ordering): the r35 verifier's S1b flipped
`refs/heads/main` C→C' via mmap before the anchored `reset -q -- .`
consult — the op resolved HEAD→C', staged C' blob ids into the real
index, and the coverage proof's `diff --cached HEAD` resolved the
same forged ref (forged 10/10). A flip that lands BETWEEN the
fingerprint's stat capture and the consult surface's baseline leaves
{ino, ctime, size} untouched — no stat layer can see it.

Fix: the fingerprint now pins `consultBytes` — the bytes of every
overlay-consultable `.git` file at capture. The overlay mint proves
each copied source equals its pin; a persistent post-capture flip
mismatches and the mint fails → `refUnproven` → the consult refuses
(EVIDENCE-REFUSED) before a single child spawns. A pre-capture
persistent flip is indistinguishable from the surface itself (the
reported "indistinguishable to every layer" boundary — the consult
faithfully answers the only state observable), so this probe drives
the CLOSABLE ordering: capture first, flip after, hold through the
consult.

forged = `reset` exits 0 with a C' blob staged; refused = exit -1;
honest = exit 0 with C blobs.
*/
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeEvidenceIndex,
  evidenceAnchoredGit,
  evidenceRepoPreflight,
} from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], env?: NodeJS.ProcessEnv) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const HAS_MMAP = HAS_PY && spawnSync("python3", ["-c", "import mmap"]).status === 0;

/** Persistent mmap flip: map read-first, store C', hold 30s. */
const startPersistentFlip = (refPath: string, cPrime: string, vpid: number) => {
  const script =
    "import os,sys,mmap,time\n" +
    "refpath,forged_hex,vpid=sys.argv[1:4]\n" +
    "fd=os.open(refpath,os.O_RDWR); st0=os.fstat(fd)\n" +
    "m=mmap.mmap(fd,st0.st_size,mmap.MAP_SHARED,mmap.PROT_READ|mmap.PROT_WRITE)\n" +
    "_=m[0]\n" +
    "m[:]=(forged_hex+'\\n').encode()\n" +
    "time.sleep(30)\n";
  const child = spawn("python3", ["-c", script, refPath, cPrime, String(vpid)], {
    stdio: "ignore",
  });
  child.unref();
  return child;
};

describe("CX-r35-B: post-capture persistent ref flip on the anchored-mutation channel", () => {
  it(
    "evidenceAnchoredGit reset refuses when refs/heads/main drifted since capture",
    { timeout: 300_000 },
    async () => {
      if (!HAS_MMAP) return;
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const root = mkdtempSync(path.join(os.tmpdir(), "cx35b-"));
        tmpdirs.push(root);
        try {
          execFileSync("git", ["init", "-q", "-b", "main", root]);
          git(root, ["config", "user.email", "t@t"]);
          git(root, ["config", "user.name", "t"]);
          writeFileSync(path.join(root, "f.txt"), "v1\n");
          git(root, ["add", "-A"]);
          git(root, ["commit", "-qm", "c1"]);
          const cOid = git(root, ["rev-parse", "refs/heads/main"]);
          const cBlob = git(root, ["rev-parse", "HEAD:f.txt"]);
          writeFileSync(path.join(root, "f.txt"), "FORGED-CONTENT\n");
          const tmpIdx = path.join(root, ".git", "cx35-tmpindex");
          execFileSync("cp", [path.join(root, ".git", "index"), tmpIdx]);
          const env2 = { ...process.env, GIT_INDEX_FILE: tmpIdx };
          git(root, ["add", "f.txt"], env2);
          const tree2 = git(root, ["write-tree"], env2);
          const cPrime = git(root, ["commit-tree", tree2, "-p", cOid, "-m", "forged"], {
            ...env2,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          });
          const cPrimeBlob = git(root, ["rev-parse", `${cPrime}:f.txt`]);
          writeFileSync(path.join(root, "f.txt"), "v1\n");
          const refPath = path.join(root, ".git", "refs", "heads", "main");
          // Capture the honest baseline FIRST — the flip lands strictly
          // after `consultBytes` pins refs/heads/main=C.
          const preflight = await evidenceRepoPreflight(root);
          if (preflight === null) {
            refused++;
            continue;
          }
          const hijack = startPersistentFlip(refPath, cPrime, process.pid);
          await new Promise((r) => setTimeout(r, 150));
          let r;
          try {
            r = await evidenceAnchoredGit(root, ["reset", "-q", "--", "."], { preflight });
          } catch {
            r = { exitCode: -1, stdout: "", stderr: "" };
          } finally {
            closeEvidenceIndex(preflight);
            hijack.kill("SIGKILL");
          }
          const staged = git(root, ["ls-files", "-s"]);
          const stagedBlob = /100644 ([0-9a-f]{40}) 0\tf.txt/.exec(staged)?.[1];
          if (r.exitCode === -1) refused++;
          else if (stagedBlob === cPrimeBlob) forged++;
          else if (stagedBlob === cBlob) honest++;
        } finally {
          /* tmpdirs cleanup */
        }
      }
      console.log(
        `cx35b post-capture ref flip on anchored reset: forged=${forged} refused=${refused} honest=${honest}`,
      );
      expect(forged).toBe(0);
      // The consultBytes mint-compare must refuse every flip; a hijacker
      // that never landed leaves the honest C-blob verdict.
      expect(refused + honest).toBe(8);
    },
  );
});
