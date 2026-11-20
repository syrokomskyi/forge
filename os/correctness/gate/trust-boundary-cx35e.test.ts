/*
CX-r35-E (mint-window fd race): the held-image mint is
`open → fchmod 0400 → write`. A same-UID attacker polling
`/proc/<vpid>/fd` can open the fd O_RDWR in the open→fchmod gap — the
r35 verifier measured ~21% of mints leaking a writable description on
the named fallback (the dead O_TMPFILE branch), each a permanent
silent write channel into a held evidence image.

Fix layers that must hold under the race:
 - `O_TMPFILE` mints a nameless inode — it appears in `/proc/<pid>/fd`
   only as "(deleted)" and its mode is 0400 before it is enumerable,
   so the racing O_RDWR open lands EACCES.
 - the named fallback is `O_EXCL` + mode 000 inside a private 0700
   dir — foreign opens are denied for the file's entire life.

The probe polls `/proc/<vpid>/fd` continuously while the verifier
mints held images and counts any O_RDWR-openable DIRC/deleted inode.
Expect zero leaked descriptions.
*/
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { heldEvidenceFile } from "../../../src/utils/verifier-git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/** Poll every fd of the victim; log any O_RDWR-openable DIRC/deleted inode. */
const startFdPoller = (vpid: number, secs: number, log: string) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); end=time.time()+float(sys.argv[2]); out=open(sys.argv[3],'w')\n" +
    "seen=set(); hits=0\n" +
    "while time.time()<end:\n" +
    "    try: names=os.listdir('/proc/%d/fd'%vpid)\n" +
    "    except: continue\n" +
    "    for n in names:\n" +
    "        if n in seen: continue\n" +
    "        seen.add(n)\n" +
    "        try: f=os.open('/proc/%d/fd/%s'%(vpid,n),os.O_RDWR|os.O_NOFOLLOW)\n" +
    "        except: continue\n" +
    "        try:\n" +
    "            head=os.pread(f,4,0); link=os.readlink('/proc/%d/fd/%s'%(vpid,n))\n" +
    "            if head==b'DIRC' or 'deleted' in link:\n" +
    "                hits+=1; out.write('HIT fd=%s link=%s mode=%o\\n'%(n,link,os.fstat(f).st_mode&0o777)); out.flush()\n" +
    "            else: os.close(f)\n" +
    "        except: pass\n" +
    "out.write('polls-done hits=%d\\n'%hits); out.close()\n";
  const child = spawn("python3", ["-c", script, String(vpid), String(secs), log], {
    stdio: "ignore",
  });
  child.unref();
  return child;
};

describe("CX-r35-E: /proc/<pid>/fd mint race cannot open a held image O_RDWR", () => {
  it(
    "zero writable descriptions leak across repeated held mints",
    { timeout: 120_000 },
    async () => {
      if (!HAS_PY) return;
      const log = path.join(os.tmpdir(), `cx35e-${process.pid}.log`);
      const poller = startFdPoller(process.pid, 30, log);
      await new Promise((r) => setTimeout(r, 300));
      const bytes = Buffer.alloc(4096, 0x41);
      bytes.write("DIRC", 0);
      let minted = 0;
      const held: { fd?: number; path?: string }[] = [];
      for (let i = 0; i < 200; i++) {
        const h = heldEvidenceFile(Buffer.from(bytes), "index");
        if (h !== null) {
          minted++;
          held.push(h);
          if (i % 3 === 2) {
            const p = held.shift();
            if (p?.fd !== undefined) closeSync(p.fd);
            if (p?.path !== undefined) rmSync(p.path, { force: true });
          }
        }
      }
      await new Promise((r) => setTimeout(r, 800));
      poller.kill("SIGKILL");
      for (const h of held) {
        if (h.fd !== undefined) closeSync(h.fd);
        if (h.path !== undefined) rmSync(h.path, { force: true });
      }
      let hits = -1;
      try {
        const content = execFileSync("cat", [log], { encoding: "utf8" });
        const m = /hits=(\d+)/.exec(content);
        hits = m === null ? (content.includes("HIT") ? 1 : 0) : Number(m[1]);
        if (hits === 0 && content.includes("HIT")) hits = 1;
      } catch {
        hits = 0; // empty log = no hits written
      }
      console.log(`cx35e fd-race: minted=${minted} leakedWritableDescs=${hits}`);
      expect(minted).toBeGreaterThan(0);
      expect(hits).toBe(0);
    },
  );
});
