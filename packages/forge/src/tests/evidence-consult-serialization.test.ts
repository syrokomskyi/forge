/*
<MODULE_CONTRACT>
<purpose>RFC-1633: evidence-consult serialization + degraded reader mode —
AC-1/AC-4 lock serialization + dead-holder recovery on the
withEvidenceConsultLock seam, AC-2 bestEffort marks trusted:false and
never touches the lock, AC-3 assertJudgedEvidence boundary throw,
AC-5 EVIDENCE-BUDGET phase refusal, AC-7 concurrent holders serialize and
all complete. Plus the call-site scan: `mode: "bestEffort"` may appear
only in the enumerated non-judging call sites.</purpose>
<non-goals>
  <item>No full judged-consult e2e — the preflight/watch/settle machinery is
  RFC-1616's own suite; this file covers the scheduling layer.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1633: step 5 — serialization/mode/budget/scan-guard tests</item>
  <item>RFC-1633: serialize evidence consults + bestEffort reader mode (RFC-1633)</item>
  <item>RFC-1633: review round 1 — digest envInputs, package-wide bestEffort scan, holder command, serialized standalone preflight</item>
</CHANGE_SUMMARY>
*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { assertJudgedEvidence, evidenceBudgetBreach, gitEvidence } from "../../os/flow/git.ts";
import {
  EVIDENCE_CONSULT_LOCK_RELATIVE_PATH,
  resolveEvidenceCommonGitDir,
  withEvidenceConsultLock,
} from "../../os/flow/evidence-lock.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
}, 20_000);

const HOST = hostname();

async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ev-consult-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".git"));
  return dir;
}

async function realRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ev-real-"));
  dirs.push(dir);
  const init = spawnSync("git", ["init", "-q", dir]);
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return dir;
}

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("evidence-consult lock serialization (AC-1, AC-4, AC-7)", () => {
  it("AC-1: two overlapping consults on one commonGitDir never interleave", async () => {
    const repo = await scratchRepo();
    let inside = 0;
    let maxInside = 0;
    const gate = deferred<void>();
    const order: string[] = [];
    const first = withEvidenceConsultLock(repo, { waitMs: 5_000 }, async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      order.push("first-in");
      await gate.promise;
      inside--;
      order.push("first-out");
    });
    // Yield so the first consult holds the lock before the second starts.
    await new Promise((r) => setTimeout(r, 20));
    const second = withEvidenceConsultLock(repo, { waitMs: 5_000 }, async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      order.push("second-in");
      inside--;
      order.push("second-out");
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(maxInside).toBe(1);
    expect(order).toEqual(["first-in", "first-out", "second-in", "second-out"]);
  });

  it("AC-4: a dead holder's lock is broken without waiting", async () => {
    const repo = await scratchRepo();
    const common = resolveEvidenceCommonGitDir(repo);
    expect(common).not.toBeNull();
    const lockPath = join(common!, EVIDENCE_CONSULT_LOCK_RELATIVE_PATH);
    mkdirSync(join(common!, "forge"), { recursive: true });
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(deadPid).toBeDefined();
    await writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, host: HOST, at: new Date().toISOString() }),
    );
    let ran = false;
    await withEvidenceConsultLock(repo, { waitMs: 2_000 }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    // The lock released cleanly after fn.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("AC-7: three concurrent holders serialize and all complete", async () => {
    const repo = await scratchRepo();
    let inside = 0;
    let maxInside = 0;
    const holder = async () => {
      await withEvidenceConsultLock(repo, { waitMs: 5_000 }, async () => {
        inside++;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 15));
        inside--;
      });
    };
    await Promise.all([holder(), holder(), holder()]);
    expect(maxInside).toBe(1);
  });
});

describe("bestEffort mode (AC-2) + boundary (AC-3)", () => {
  it("AC-2: mode:'bestEffort' returns trusted:false and creates no lock", async () => {
    const repo = await realRepo();
    const r = await gitEvidence(repo, ["rev-parse", "--git-dir"], {
      mode: "bestEffort",
    });
    expect(r.exitCode).toBe(0);
    expect(r.trusted).toBe(false);
    // No preflight, no watch, no lock — the lock artifact never appears.
    const common = resolveEvidenceCommonGitDir(repo);
    expect(existsSync(join(common!, EVIDENCE_CONSULT_LOCK_RELATIVE_PATH))).toBe(false);
  });

  it("AC-3: assertJudgedEvidence throws EVIDENCE-MODE on trusted:false", () => {
    expect(() =>
      assertJudgedEvidence({ exitCode: 0, stdout: "", stderr: "", trusted: false }),
    ).toThrowError(/EVIDENCE-MODE/);
    expect(() =>
      assertJudgedEvidence({ exitCode: 0, stdout: "", stderr: "", trusted: true }),
    ).not.toThrow();
  });
});

describe("consult budget (AC-5)", () => {
  it("AC-5: a breach refuses EVIDENCE-BUDGET naming phase and elapsed vs budget", () => {
    const startedAt = Date.now() - 10_000;
    const refusal = evidenceBudgetBreach(["rev-parse", "--git-dir"], "arm", startedAt, 5_000);
    expect(refusal).not.toBeNull();
    expect(refusal!.exitCode).toBe(-1);
    expect(refusal!.stderr).toContain("EVIDENCE-BUDGET");
    expect(refusal!.stderr).toContain("arm");
    expect(refusal!.stderr).toMatch(/elapsed > 5000ms budget/);
    // No clock started → no budget accounting (preflight:false reads).
    expect(evidenceBudgetBreach(["x"], "arm", undefined, 5)).toBeNull();
  });
});

describe("bestEffort call-site scan", () => {
  it("mode:'bestEffort' appears only in the enumerated non-judging call sites", () => {
    const PKG_DIR = resolve(__dirname, "../..");
    const ALLOWLIST = new Set(["digest.ts"]);
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        const rel = relative(PKG_DIR, p).replaceAll("\\", "/");
        if (entry.isDirectory()) {
          if (rel === "src/tests" || entry.name === "tests" || entry.name === "node_modules") {
            continue;
          }
          scan(p);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const content = readFileSync(p, "utf8");
        if (/mode:\s*"bestEffort"/.test(content)) {
          if (!ALLOWLIST.has(entry.name)) offenders.push(p);
        }
      }
    };
    for (const root of [join(PKG_DIR, "os"), join(PKG_DIR, "src")]) {
      if (existsSync(root)) scan(root);
    }
    expect(offenders).toEqual([]);
  });
});
