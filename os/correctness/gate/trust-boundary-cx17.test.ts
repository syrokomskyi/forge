/*
RFC-1616 round-17 independent adversarial probes — candidate commit
806c2b573 ("fix `1825885f7` + port `806c2b573`"), exported tree.

Every counterexample probe FAILS while its hole is live and PASSES only
after the hole is closed. Hold probes document classes this round
re-probed and found closed. Numbering continues from CX-158 (round 16).

Round-17 findings — all DOWNSTREAM polarity: the trusted channel fails
closed (-1 + EVIDENCE-REFUSED) but consumers map the refusal onto the
benign verdict the check exists to rule out. The r16 remediation fixed
the RFC twins and missed the ADR twins plus one envelope writer.

  CX-159 — `isAdrFileClean` (os/adr/handlers/implement-stamp.ts,
    gate ADR-IMP-04) was the un-remediated ADR twin of CX-157's
    `isRfcFileClean`: `execGit` mapped a refused path-scoped
    `status --porcelain` to `""` and `status.length === 0 → true` read
    unverifiable as clean. Closed with the CX-157 mapping verbatim —
    `exitCode === 0 && stdout.trim().length === 0`; a refused verdict
    is never clean.

  CX-160 — `execGitLog` (os/adr/handlers/validate.ts) was the
    un-remediated ADR twin of CX-158's drift check: a refused
    `log --since=<createdAt>` → `""` → `if (log)` false → the AV-16
    implement-drift warning was suppressed on a repo whose history
    carries `implement: ADR-*` commits. Closed with the CX-158 shape —
    nonzero read + repoShaped surface → `unverifiable` AV-16 warning;
    a genuinely absent repo skips honestly.

  CX-161 — `captureGitContext` (os/rfc/verification-evidence.ts)
    recorded `workingTreeDirty: false` into the attested evidence
    envelope when `status --porcelain` refused. Closed: a refused
    dirty verdict now records `true` — a signed envelope can never
    attest "clean" on an unprovable surface.

Holds re-probed this round:

  - `.git/config` symlinked to an always-unreadable regular file
    (/proc/self/mem): statSync sees a file, read fails EIO —
    `configUnproven` arms and EVERY spawn refuses; `collectDigest`
    never mints a clean digestId (it throws on the refused
    `--git-common-dir`, an honest if unhandled refusal).
  - `rev-list --notes`/`--show-notes`: rev-list errors honestly — the
    notes ref is never served (only log/show expand notes; both are
    argv-refused since CX-154).
  - classifyItem log-fallback under indexUnproven still carries the
    "contract" flag (CX-155 closure re-check).
  - `listDirtyPaths` under corrupt index still reports refused:true
    (CX-151 re-check).
  - `captureGitContext` on a healthy clean tree reports
    `workingTreeDirty:false` honestly (control).
*/

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { collectDigest } from "../../flow/digest.ts";
import { listDirtyPaths } from "../../compass/handlers/git-revision.ts";
import { runAdrImplementStamp } from "../../adr/handlers/implement-stamp.ts";
import { runAdrValidate } from "../../adr/handlers/validate.ts";
import { captureGitContext } from "../../rfc/verification-evidence.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx17-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  execFileSync("git", ["-C", root, "add", "f.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "c1"]);
  return root;
};

/** `.git/info/exclude` with one effective line → refuse-class shape. */
const plantInfoExclude = (root: string) => {
  mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  writeFileSync(path.join(root, ".git", "info", "exclude"), "*.key\n");
};

/** Corrupt `.git/index` → claims rebuild fails → indexUnproven: status/
 *  diff/ls-files refuse while rev-list/log/show/merge-base still answer.
 *  CX-r37: the judged index is mode-barriered — `chmod +w` (ctime-visible)
 *  first, then the in-place write lands. */
const corruptIndex = (root: string) => {
  const idx = path.join(root, ".git", "index");
  chmodSync(idx, 0o600);
  writeFileSync(idx, Buffer.from("not-an-index"));
};

/** io stub for collectDigest (ambient reads only — journal/registry absent). */
const stubIo = {
  readFile: async (p: string) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(p, "utf8");
  },
  exists: async (p: string) => {
    const { existsSync } = await import("node:fs");
    return existsSync(p);
  },
  exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
} as never;

/** Minimal ForgeRuntimeContext — json output keeps the logger unused. */
const mkCtx = (root: string) =>
  ({
    workspaceRoot: root,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
      section: () => {},
    },
    dryRun: false,
    outputFormat: "json",
  }) as never;

describe("CX-159 — ADR twin of CX-157: isAdrFileClean polarity inversion", () => {
  it("channel: corrupt index refuses path-scoped status while provenance reads answer", async () => {
    const root = mkRepo();
    corruptIndex(root);
    const status = await verifierGit(root, [
      "status",
      "--porcelain",
      "--",
      "docs/adrs/adr-0003-x.md",
    ]);
    expect(status.exitCode).toBe(-1);
    const anc = await verifierGit(root, ["merge-base", "--is-ancestor", "HEAD", "HEAD"]);
    expect(anc.exitCode).toBe(0);
  });

  it("runAdrImplementStamp stamps an unverifiable-dirty ADR (ADR-IMP-04 blind)", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "docs", "adrs"), { recursive: true });
    const adrRel = "docs/adrs/adr-0003-stamp-target.md";
    const adrAbs = path.join(root, adrRel);
    const base =
      "---\nid: ADR-0003\nstatus: accepted\ncreatedAt: 2025-01-01\ndecider: team\nscope: x\n---\n\n## Body\n";
    writeFileSync(adrAbs, base);
    execFileSync("git", ["-C", root, "add", adrRel]);
    execFileSync("git", ["-C", root, "commit", "-qm", "implement: ADR-0003 stamp target"]);
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // The ADR file is really dirty — ambient git sees it.
    writeFileSync(adrAbs, `${base}\nsession edit — must block the stamp\n`);
    const ambient = execFileSync("git", ["-C", root, "status", "--porcelain", "--", adrRel], {
      encoding: "utf8",
    });
    expect(ambient.trim().length).toBeGreaterThan(0);
    // Session corrupts the index → path-scoped status refuses →
    // implement-stamp's execGit maps -1 → "" → clean.
    corruptIndex(root);
    const channel = await verifierGit(root, ["status", "--porcelain", "--", adrRel]);
    expect(channel.exitCode).toBe(-1);
    // IMP-03 inputs still answer under indexUnproven (non-index reads).
    const anc = await verifierGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    expect(anc.exitCode).toBe(0);
    const msg = await verifierGit(root, ["log", "-1", "--format=%B", sha]);
    expect(msg.exitCode).toBe(0);
    expect(msg.stdout).toContain("ADR-0003");

    const result = await runAdrImplementStamp(
      { argv: [], flags: { id: "ADR-0003", "implementation-commit": sha } },
      mkCtx(root),
    );
    const rules = (result.data?.violations ?? []).map((v: { rule: string }) => v.rule);
    // Contract: an unverifiable dirty verdict must fire ADR-IMP-04 —
    // while the hole is live the stamp reports pass and mutates the file.
    expect(rules).toContain("ADR-IMP-04");
  });
});

describe("CX-160 — ADR twin of CX-158: AV-16 drift warning suppressed on refusal", () => {
  it("runAdrValidate reports no AV-16 when the log read refuses", async () => {
    const root = mkRepo();
    execFileSync("git", [
      "-C",
      root,
      "commit",
      "--allow-empty",
      "-qm",
      "implement: ADR-0007 drift",
    ]);
    mkdirSync(path.join(root, "docs", "adrs"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "adrs", "adr-0007-drift.md"),
      "---\nid: ADR-0007\nstatus: accepted\ncreatedAt: 2025-01-02\ndecider: team\nscope: x\n---\n\n## Body\n",
    );
    // Any refused-surface trigger: every channel read now refuses.
    plantInfoExclude(root);
    const log = await verifierGit(root, ["log", "--since=2025-01-02", "--oneline"]);
    expect(log.exitCode).toBe(-1);

    const result = await runAdrValidate({ argv: [], flags: {} }, mkCtx(root));
    const rules = (result.data?.violations ?? []).map((v: { rule: string }) => v.rule);
    // Contract: an unverifiable drift read must surface AV-16 (as
    // `unverifiable`, like the RFC twin's V-32) — never silence.
    expect(rules).toContain("AV-16");
  });
});

describe("CX-161 — captureGitContext records workingTreeDirty:false on a refused read", () => {
  it("control: a healthy clean tree reports workingTreeDirty:false honestly", async () => {
    const root = mkRepo();
    const ctx = await captureGitContext(root);
    expect(ctx.workingTreeDirty).toBe(false);
    expect(ctx.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("control: a healthy dirty tree reports workingTreeDirty:true", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "dirty\n");
    const ctx = await captureGitContext(root);
    expect(ctx.workingTreeDirty).toBe(true);
  });

  it("indexUnproven: a refused status must not record 'clean' in the envelope", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "f.txt"), "dirty\n");
    corruptIndex(root);
    const status = await verifierGit(root, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(-1);
    const ctx = await captureGitContext(root);
    // HEAD still resolves (non-index read) — the envelope pairs a real
    // sha with the downgraded dirty verdict.
    expect(ctx.commit).toMatch(/^[0-9a-f]{40}$/);
    // Contract: unverifiable ≠ clean. Any fix (conservative true, or a
    // tri-state unverifiable flag) satisfies this — only a curated
    // `false` violates it.
    expect(ctx.workingTreeDirty).toBe(true);
  });
});

describe("holds — re-probed classes from r1..r16", () => {
  it("hold: .git/config → unreadable file — configUnproven refuses every spawn; digest never mints a clean id", async () => {
    if (process.platform === "win32") return;
    const root = mkRepo();
    // Symlink to an always-EIO regular file: statSync/existsSync see a
    // file, safeReadBytes fails → configUnproven arms — while git's own
    // config read tolerates it as empty (verified: rev-parse --git-path,
    // config --list, and status all exit 0 under ambient git).
    unlinkSync(path.join(root, ".git", "config"));
    symlinkSync("/proc/self/mem", path.join(root, ".git", "config"));
    const r = await verifierGit(root, ["rev-parse", "HEAD"]);
    expect(r.exitCode).toBe(-1);
    const r2 = await verifierGit(root, ["status", "--porcelain"]);
    expect(r2.exitCode).toBe(-1);
    // The digest's honest outcome is a thrown refusal — never a clean
    // (or `refused-`-less normal) digestId over a refused channel.
    await expect(collectDigest(root, stubIo, { fetch: false })).rejects.toThrow();
  });

  it("hold: rev-list notes flags error honestly — planted notes never served", async () => {
    const root = mkRepo();
    execFileSync("git", [
      "-C",
      root,
      "notes",
      "--ref",
      "refs/notes/commits",
      "add",
      "-m",
      "session-note",
      "HEAD",
    ]);
    for (const args of [
      ["rev-list", "--notes", "HEAD"],
      ["rev-list", "--show-notes", "HEAD"],
    ]) {
      const r = await verifierGit(root, args);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain("session-note");
    }
  });

  it("hold (CX-155): classifyItem log-fallback keeps the contract flag under indexUnproven", async () => {
    const root = mkRepo();
    execFileSync("git", ["-C", root, "switch", "-q", "-c", "develop"]);
    mkdirSync(path.join(root, "docs", "specs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "specs", "x.schema.json"), "{}\n");
    execFileSync("git", ["-C", root, "add", "docs/specs/x.schema.json"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "feat: spec"]);
    const healthy = await collectDigest(root, stubIo, { fetch: false });
    const healthyItem = healthy.items.find((i) => i.subjects.includes("feat: spec"));
    expect(healthyItem?.flags).toContain("contract");
    corruptIndex(root);
    const narrowed = await collectDigest(root, stubIo, { fetch: false });
    const item = narrowed.items.find((i) => i.subjects.includes("feat: spec"));
    expect(item?.flags).toContain("contract");
  });

  it("hold (CX-151): listDirtyPaths reports refused:true under corrupt index", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "dirty.txt"), "x\n");
    corruptIndex(root);
    const r = await listDirtyPaths(root);
    expect(r.refused).toBe(true);
  });
});
