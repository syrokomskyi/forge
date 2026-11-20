/*
CX-r35-D (held-file mint squat): Node ≤24 omits `fs.constants.O_TMPFILE`,
so the r35 verifier found the nameless fd branch dead — every held
image minted through a predictable `/tmp/forge-evidence-<stem>-<pid>-<seq>`
name. A same-UID session squats that name at 0666 O_RDWR BEFORE the
mint: the verifier's create truncates the squatted inode and `fchmod
0400` cannot revoke a write-capable DESCRIPTION already held — access
checks bind to descriptions, never inodes. The attacker then
mmap-flip→restores the held claims index through its leaked desc — no
chmodat, no /proc fd open, no ctime bump, no inotify (forged 10/10).

Fix: `O_TMPFILE` now passes the Linux literal `0o20200000` straight to
`open(2)` — the held inode is nameless from birth, nothing to squat.
The named fallback mints inside a verifier-private 0700 dir with
`O_EXCL` + mode 000 at create: a squatted name fails the mint outright
and an `IN_CREATE`-racing open hits EACCES, so no writable foreign
description can ever exist on a held inode.

The probe squats every predictable name the r35 attack used, then
runs the `unprovenIgnoredPaths` claims consult end to end — forged =
`x/hidden` omitted; honest = present; refused = null.
*/
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { heldEvidenceFile, unprovenIgnoredPaths } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

describe("CX-r35-D: squatted held-image names cannot leak a writable description", () => {
  it(
    "claims consult stays honest while every legacy predictable name is held O_RDWR",
    { timeout: 120_000 },
    async () => {
      // Squat the exact names the r35 attack pre-created — plus the
      // private-dir names the new fallback uses, in case enumeration
      // finds it. Every fd stays open and writable.
      const squatFds: number[] = [];
      try {
        for (const dir of [os.tmpdir()]) {
          for (let n = 1; n <= 64; n++) {
            for (const stem of ["index", "config"]) {
              const p = path.join(dir, `forge-evidence-${stem}-${process.pid}-${n}`);
              try {
                const f = openSync(p, 0o42 /* O_RDWR|O_CREAT */, 0o666);
                squatFds.push(f);
              } catch {
                /* name taken is fine — it squats the same slot */
              }
            }
          }
        }
        let forged = 0;
        let refused = 0;
        let honest = 0;
        for (let attempt = 0; attempt < 5; attempt++) {
          const root = mkdtempSync(path.join(os.tmpdir(), "cx35d-"));
          tmpdirs.push(root);
          try {
            execFileSync("git", ["init", "-q", "-b", "main", root]);
            git(root, ["config", "user.email", "t@t"]);
            git(root, ["config", "user.name", "t"]);
            writeFileSync(path.join(root, ".gitignore"), "visible\n");
            writeFileSync(path.join(root, "f.txt"), "v1\n");
            git(root, ["add", "-A"]);
            git(root, ["commit", "-qm", "c1"]);
            mkdirSync(path.join(root, "x"));
            writeFileSync(path.join(root, "x", ".gitignore"), "hidden\n");
            writeFileSync(path.join(root, "x", "hidden"), "x\n");
            writeFileSync(path.join(root, "x", "visible"), "y\n");
            let r: Set<string> | null;
            try {
              r = await unprovenIgnoredPaths(root, ["x/hidden"]);
            } catch {
              r = null;
            }
            if (r === null) refused++;
            else if (!r.has("x/hidden")) forged++;
            else honest++;
          } finally {
            /* tmpdirs cleanup */
          }
        }
        console.log(
          `cx35d name-squat consult: forged=${forged} refused=${refused} honest=${honest}`,
        );
        expect(forged).toBe(0);
      } finally {
        for (const f of squatFds) {
          try {
            closeSync(f);
          } catch {
            /* gone */
          }
        }
      }
    },
  );

  it(
    "held mint succeeds on an unenumerable inode (O_TMPFILE/nameless first)",
    { timeout: 60_000 },
    () => {
      const bytes = Buffer.alloc(4096, 0x41);
      bytes.write("DIRC", 0);
      const held = heldEvidenceFile(bytes, "index");
      expect(held).not.toBeNull();
      if (held?.fd !== undefined) closeSync(held.fd);
      if (held?.path !== undefined) rmSync(held.path, { force: true });
    },
  );
});
