/*
RFC-1616 round-41 adversarial probes — the clean-context verifier
refuted R40 with three deterministic classes:

CX-r41-F1 — `pruneIgnoredDirs` deleted each check-ignore-verdict
ignored dir's member set and `.gitignore` slot from the captured
surface on the premise "the enumeration never descends interiors".
The premise is false on the channel's own transformed argv: `ls-files
-o` spawns with every exclusion flag stripped and opens every ignored
interior; `status` gains `--ignored`, which opens the dirs and probes
interior `.gitignore` even when output collapses to `!!` lines; the
anchored `add`/`reset` residual `ls-files -o -z` descends the same
way. A hide/plant inside a pruned dir left no armed channel (42/42
forged across both channels). Fix: capture stays TOTAL — ignored dirs
are recorded (`markIgnoredDirs`) and the ARM subtracts them only when
`consultDescendsIgnoredDirs` proves the judged argv never reads their
interiors (`check-ignore`, plain `add`, `ls-files -o --directory`
without `--no-empty-directory`); every other consult arms them fully.

CX-r41-F2 — `evidenceSpawnArgs` stripped only `=`-form exclusion
flags. `-X <file>`, space-form `--exclude-from <file>`,
`--exclude-per-directory <file>`, and `grep -f <file>` passed the
judged argv verbatim, and the named files sat outside every armed
surface (30/30 forged). Fix: `stripLsFilesExclusions` walks argv by
mechanism — long names match exact-member or abbreviation prefix and
consume the following token when the matched member takes a value,
`-x`/`-X` inside a short cluster take the cluster tail or next token
as value, and `grep`'s `-f`/`--file` join the forbid table. Every
`--pathspec-from-file`/`--pathspec-file-nul` on an admitted read op is
forbidden the same way (a session-named file shaping the enumeration
with no pin or watch) — parity with the anchored channel's existing
`add`/`reset` forbid.

CX-r41-F3 — `evidencePinEnv` emitted the `__evidence_dead__` upstream
pins only for HEAD branch names matching /^[\w][\w./-]*$/, but Git
arms `[branch "<n>"]` far wider: `a%b`, `a|b`, `a=b`, `feat/üñï` all
resolve session `branch.<n>.{remote,merge}` claims, and `status`
echoes them verbatim (12/12 deterministic, no timing). Fix: the pin
emits for EVERY non-empty branch name — the flat `-c` dotted form
needs no name grammar (everything between the first and last dot is
the subsection verbatim), and a dead pin on a name config cannot
express is harmless while a missed armable name fabricates a claim.

Attack shape: identical to cx40 — a python watcher enumerates
/proc/<vpid>/task/<tid>/children, fires on the judged child's argv,
and restores on zombie. Outcomes: refused = exitCode -1; honest =
true state at read instant; forged = verdict accepted attacker bytes
— must stay 0.
*/

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  consultDescendsIgnoredDirs,
  evidenceSpawnArgs,
  isEvidenceGitQuery,
  verifierGit,
} from "../../../src/utils/verifier-git.ts";
import { gitEvidence } from "../../flow/git.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input }).trim();

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;

/**
 * Repo with a tracked `.gitignore` naming `ig/` and a populated
 * ignored interior — the R41 F1 fixture (`check-ignore` verdicts `ig`
 * ignored; judged consults that descend read it).
 */
const mkRepo = (igFiles = 30) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx41-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, ".gitignore"), "ig/\n");
  writeFileSync(path.join(root, "policy.txt"), "COMMITTED\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "c1"]);
  mkdirSync(path.join(root, "ig"));
  mkdirSync(path.join(root, "ig", "deep"));
  for (let i = 0; i < igFiles; i++) {
    writeFileSync(path.join(root, "ig", `inner${i}`), `I${i}\n`);
    writeFileSync(path.join(root, "ig", "deep", `d${i}.txt`), `D${i}\n`);
  }
  return root;
};

const startChildWatcher = (vpid: number, want: string, act: string, undo: string) => {
  const script =
    "import os,sys,time\n" +
    "vpid=int(sys.argv[1]); want=sys.argv[2]\n" +
    "def kids():\n" +
    "    out=[]\n" +
    "    try:\n" +
    "        for t in os.listdir('/proc/%s/task'%vpid):\n" +
    "            try: out+=open('/proc/%s/task/%s/children'%(vpid,t)).read().split()\n" +
    "            except: pass\n" +
    "    except: pass\n" +
    "    return out\n" +
    "def argv(k):\n" +
    "    try: return open('/proc/%s/cmdline'%k,'rb').read().split(b'\\0')\n" +
    "    except: return []\n" +
    "end=time.time()+60; done=False\n" +
    "while time.time()<end and not done:\n" +
    "    for k in kids():\n" +
    "        if k==str(os.getpid()): continue\n" +
    "        if want.encode() in argv(k):\n" +
    "            " +
    act +
    "\n" +
    "            for _ in range(400000):\n" +
    "                try:\n" +
    "                    stt=open('/proc/%s/stat'%k).read().rsplit(')',1)[1].split()[0]\n" +
    "                    if stt=='Z': break\n" +
    "                except: break\n" +
    "                time.sleep(0.00002)\n" +
    "            " +
    undo +
    "\n" +
    "            done=True\n" +
    "    time.sleep(0.00002)\n";
  const child = spawn("python3", ["-c", script, String(vpid), want], { stdio: "ignore" });
  child.unref();
  return {
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* done */
      }
    },
  };
};

const pyStr = (s: string) => `'${s.replaceAll("'", "\\x27")}'`;

describe("CX-r41-F1: the ignored-dir arm subset follows consult descent", () => {
  it(
    "mid-window hide inside an ignored dir on `ls-files -o` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        const target = path.join(root, "ig", "inner0");
        const h = startChildWatcher(
          process.pid,
          "-o",
          `os.unlink(${pyStr(target)})`,
          `open(${pyStr(target)},'w').write('I0\\n')`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-o"]);
          if (r.exitCode === -1) {
            refused++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          writeFileSync(target, "I0\n");
        }
      }
      // The enumeration always matches live state, so a forgery reads
      // as refusal — the ARMED interior catching the mutation (pre-fix
      // these probes forged 42/42 because `ig/` carried no coverage).
      expect(refused + honest).toBe(6);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it(
    "mid-window plant inside an ignored dir on `status -uall` refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        const planted = path.join(root, "ig", "planted-evil");
        const h = startChildWatcher(
          process.pid,
          "-uall",
          `open(${pyStr(planted)},'w').write('EVIL\\n')`,
          `os.unlink(${pyStr(planted)})`,
        );
        try {
          const r = await verifierGit(root, ["status", "--porcelain", "-uall"]);
          if (r.exitCode === -1) {
            refused++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          try {
            rmSync(planted);
          } catch {
            /* absent */
          }
        }
      }
      expect(refused + honest).toBe(6);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it(
    "mid-window `.git` boundary removal inside an ignored dir refuses",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        // An embedded `.git` marker inside the ignored dir: removing
        // it mid-window changes whether the child descends `ig/sub`.
        const sub = path.join(root, "ig", "sub");
        const marker = path.join(sub, ".git");
        mkdirSync(sub);
        writeFileSync(marker, "gitdir: /nonexistent\n");
        const h = startChildWatcher(
          process.pid,
          "-o",
          `os.unlink(${pyStr(marker)})`,
          `open(${pyStr(marker)},'w').write('gitdir: /nonexistent\\n')`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-o"]);
          if (r.exitCode === -1) {
            refused++;
          } else {
            honest++;
          }
        } finally {
          h.stop();
          writeFileSync(marker, "gitdir: /nonexistent\n");
        }
      }
      expect(refused + honest).toBe(6);
      expect(refused).toBeGreaterThan(0);
    },
  );

  it("classifier: descent is admit-listed per argv, never flag-presence", () => {
    // `status` post-transform always carries `--ignored` — it descends
    // unless the untracked walk is off entirely.
    expect(consultDescendsIgnoredDirs(["status"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "-uall"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "--porcelain"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "--ignored=matching"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["status", "-uno"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["status", "--untracked-files", "no"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["status", "--untracked-files=no"])).toBe(false);
    // `ls-files` descends on `-o`/`--others` (and abbreviations) unless
    // the `--directory` collapse holds without `--no-empty-directory`.
    expect(consultDescendsIgnoredDirs(["ls-files", "-o"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "--others"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "--oth"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "-co"])).toBe(true);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--directory"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["ls-files", "-o", "--dir", "--no-empty-directory"])).toBe(
      true,
    );
    expect(consultDescendsIgnoredDirs(["ls-files", "-k"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["ls-files", "-s"])).toBe(false);
    // Mutation consults descend only under force.
    expect(consultDescendsIgnoredDirs(["add", "."])).toBe(false);
    expect(consultDescendsIgnoredDirs(["add", "-f", "."])).toBe(true);
    expect(consultDescendsIgnoredDirs(["add", "-nf", "."])).toBe(true);
    expect(consultDescendsIgnoredDirs(["add", "--force", "."])).toBe(true);
    // Non-descending reads stay prunable.
    expect(consultDescendsIgnoredDirs(["check-ignore", "-v", "x"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["diff", "HEAD"])).toBe(false);
    expect(consultDescendsIgnoredDirs(["grep", "x", "HEAD"])).toBe(false);
  });
});

describe("CX-r41-F2: argv-named auxiliary files are stripped or refused", () => {
  it("ls-files exclusion flags strip by mechanism — space, attached, cluster, abbrev", () => {
    // `-X <file>` space form — flag and value both drop.
    expect(evidenceSpawnArgs(["ls-files", "-o", "-X", "/tmp/x"])).toEqual(["ls-files", "-o"]);
    // Attached `-X<file>`.
    expect(evidenceSpawnArgs(["ls-files", "-o", "-X/tmp/x"])).toEqual(["ls-files", "-o"]);
    // Space-form `--exclude-from <file>` — the pair drops.
    expect(evidenceSpawnArgs(["ls-files", "-o", "--exclude-from", "/tmp/x"])).toEqual([
      "ls-files",
      "-o",
    ]);
    // `=` form keeps working.
    expect(evidenceSpawnArgs(["ls-files", "-o", "--exclude-from=/tmp/x"])).toEqual([
      "ls-files",
      "-o",
    ]);
    // `--exclude-per-directory` space form — a rule-file name consulted
    // inside descended dirs drops too.
    expect(evidenceSpawnArgs(["ls-files", "-o", "--exclude-per-directory", ".myx"])).toEqual([
      "ls-files",
      "-o",
    ]);
    // `--exclude <pat>` space form consumes the pattern.
    expect(evidenceSpawnArgs(["ls-files", "-o", "--exclude", "pat"])).toEqual(["ls-files", "-o"]);
    // Cluster `-coX` — `-X` ends the cluster and eats the next token.
    expect(evidenceSpawnArgs(["ls-files", "-coX", "pat"])).toEqual(["ls-files", "-co"]);
    // Cluster `-oXi` — the `-X` tail is the value, `-i` never parses.
    expect(evidenceSpawnArgs(["ls-files", "-oXi"])).toEqual(["ls-files", "-o"]);
    // `-i` (=`--ignored`) drops inside a cluster, siblings stay.
    expect(evidenceSpawnArgs(["ls-files", "-cio"])).toEqual(["ls-files", "-co"]);
    // Abbreviated long forms match their mechanism (`--exclude-s` is
    // `--exclude-standard`; `--exclude-f` is `--exclude-from`, valued).
    expect(evidenceSpawnArgs(["ls-files", "-o", "--exclude-s"])).toEqual(["ls-files", "-o"]);
    expect(evidenceSpawnArgs(["ls-files", "-o", "--exclude-f", "/tmp/x"])).toEqual([
      "ls-files",
      "-o",
    ]);
    // Negation forms strip too.
    expect(evidenceSpawnArgs(["ls-files", "-o", "--no-exclude-standard"])).toEqual([
      "ls-files",
      "-o",
    ]);
    // Tokens after `--` are pathspec literals, never flags.
    expect(evidenceSpawnArgs(["ls-files", "-o", "--", "-X", "a"])).toEqual([
      "ls-files",
      "-o",
      "--",
      "-X",
      "a",
    ]);
  });

  it(
    "in-window `-X` file flip is honest — the file is never consulted",
    { timeout: 300_000 },
    async (ctx) => {
      if (!HAS_PY) return ctx.skip();
      let forged = 0;
      let refused = 0;
      let honest = 0;
      for (let i = 0; i < 6; i++) {
        const root = mkRepo();
        const aux = mkdtempSync(path.join(os.tmpdir(), "cx41-aux-"));
        tmpdirs.push(aux);
        const rules = path.join(aux, "rules.txt");
        writeFileSync(rules, "policy.txt\n");
        const h = startChildWatcher(
          process.pid,
          "-o",
          `open(${pyStr(rules)},'w').write('policy.txt\\nig/\\n')`,
          `open(${pyStr(rules)},'w').write('policy.txt\\n')`,
        );
        try {
          const r = await verifierGit(root, ["ls-files", "-o", "-X", rules]);
          if (r.exitCode === -1) {
            refused++;
          } else if (r.stdout.includes("ig/inner0")) {
            // The `-X` flag is stripped — the child enumerates every
            // untracked file regardless of what the rules file holds.
            honest++;
          } else {
            forged++;
          }
        } finally {
          h.stop();
        }
      }
      expect(forged, "-X file flip forged the ls-files enumeration").toBe(0);
      expect(refused + honest).toBe(6);
    },
  );

  it("grep `-f`/`--file` and `--pathspec-from-file` on read ops refuse at argv judgment", () => {
    expect(isEvidenceGitQuery(["grep", "-f", "/tmp/pats", "--", "x"])).toBe(false);
    expect(isEvidenceGitQuery(["grep", "-nf", "/tmp/pats", "--", "x"])).toBe(false);
    expect(isEvidenceGitQuery(["grep", "--file=/tmp/pats", "--", "x"])).toBe(false);
    expect(isEvidenceGitQuery(["status", "--pathspec-from-file=/tmp/ps"])).toBe(false);
    expect(isEvidenceGitQuery(["status", "--pathspec-from-file", "/tmp/ps"])).toBe(false);
    expect(isEvidenceGitQuery(["status", "--pathspec-file-nul"])).toBe(false);
    expect(isEvidenceGitQuery(["ls-files", "--pathspec-from-file=/tmp/ps"])).toBe(false);
    expect(isEvidenceGitQuery(["ls-tree", "--pathspec-from-file=/tmp/ps", "HEAD"])).toBe(false);
    expect(isEvidenceGitQuery(["diff", "--pathspec-from-file=/tmp/ps", "HEAD"])).toBe(false);
    expect(isEvidenceGitQuery(["log", "--pathspec-from-file", "/tmp/ps"])).toBe(false);
    expect(isEvidenceGitQuery(["show", "--pathspec-from-file=/tmp/ps"])).toBe(false);
    // Unrelated argv stays admitted.
    expect(isEvidenceGitQuery(["status", "--porcelain"])).toBe(true);
    expect(isEvidenceGitQuery(["ls-files", "-o", "-X", "/tmp/x"])).toBe(true);
    expect(isEvidenceGitQuery(["grep", "-n", "pat", "HEAD"])).toBe(true);
    expect(isEvidenceGitQuery(["diff", "--stat", "HEAD"])).toBe(true);
  });

  it("gitEvidence channel refuses `grep -f` identically", async () => {
    const root = mkRepo(2);
    const aux = mkdtempSync(path.join(os.tmpdir(), "cx41-aux-"));
    tmpdirs.push(aux);
    const pats = path.join(aux, "pats.txt");
    writeFileSync(pats, "COMMITTED\n");
    const r = await gitEvidence(root, ["grep", "-f", pats, "--", "policy.txt"]);
    expect(r.exitCode).toBe(-1);
  });
});

describe("CX-r41-F3: every non-empty HEAD branch name gets a dead upstream pin", () => {
  it("status on `a%b` emits no session-authored upstream claim", async () => {
    const root = mkRepo(2);
    git(root, ["checkout", "-qb", "a%b"]);
    // A session-authored upstream the dead pin must neutralize.
    git(root, ["config", "branch.a%b.remote", "origin"]);
    git(root, ["config", "branch.a%b.merge", "refs/heads/main"]);
    const r = await verifierGit(root, ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/ahead|behind|up to date|gone/i);
    const rg = await gitEvidence(root, ["status"]);
    expect(rg.exitCode).toBe(0);
    expect(rg.stdout).not.toMatch(/ahead|behind|up to date|gone/i);
  });

  it.each(["a|b", "a=b", "a&b", "a b", "feat/üñï"])(
    "status on armable name %j emits no upstream claim",
    async (branch) => {
      const root = mkRepo(2);
      try {
        git(root, ["checkout", "-qb", branch]);
      } catch {
        return; // name not git-initable on this git — nothing to arm
      }
      git(root, ["config", `branch.${branch}.remote`, "origin"]);
      git(root, ["config", `branch.${branch}.merge`, "refs/heads/main"]);
      const r = await verifierGit(root, ["status"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toMatch(/ahead|behind|up to date|gone/i);
    },
  );

  it("status on an ordinary branch still emits the dead-pin-clean output", async () => {
    const root = mkRepo(2);
    const r = await verifierGit(root, ["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("On branch main");
  });
});
