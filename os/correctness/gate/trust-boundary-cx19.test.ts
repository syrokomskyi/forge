/*
RFC-1616 round-19 independent adversarial probes — candidate commit
338aa25c, exported tree.

Every counterexample probe asserts the CONTRACT outcome (truthful
result or explicit refusal) — it FAILS while its hole is live.
Numbering continues from CX-165 (round 18).

Round-19 findings:

  CX-166 — ignoreRuleSourcesProven (os/compass/handlers/
    compass-audit-handler.ts) proves only the STRUCTURAL exclude
    candidates: a linked-worktree metadir `commondir` file redirect —
    and a `.git/info/exclude` reachable only through it — is never
    checked, so `check-ignore` honors a session exclude the verifier
    never saw; and for a subdir cwd the real `.git` and every parent
    `.gitignore` escape the walk. filterLedgerEligiblePaths then marks
    a never-audited authored file ineligible → compass.audit.validate
    --strict passes.

  CX-167 — sessionIgnoreRulePaths walks only the passed cwd:
    gitIsClean/statusDirty/listDirtyPaths report clean on a dirty
    repo when the session-authored `.gitignore` sits in a parent dir
    of the workspaceRoot the helper was handed.

  CX-168 — getFileRevisionFromHistory (os/compass/handlers/
    git-revision.ts) collapses a refused judged read to revision 1:
    under a channel-wide refusal (planted include.path) every audited
    ledger entry reads `current=1` → not due → --strict validate goes
    green.

  CX-169 — pinnedGitAdd (os/mission/lockfile.ts) runs `git add` on
    cwd discovery with no GIT_DIR anchor and no `.git` indirection
    judgment: a `.git` swap between the judged `show` and the `add`
    repoints the mutation into a foreign repo's index while
    `staged:true` is reported; `info/attributes` filter.*.clean also
    execs inside the pinned spawn.

  CX-170 — ambient io.exec("git", …) evidence reads remain in
    system.outbox.scan, codebase.measure, archive-regen and
    core.module: GIT_DIR/GIT_INDEX_FILE env redirects or narrows the
    read and non-zero exits map to benign verdicts.

  CX-171 — isBare (os/flow/git.ts) maps a channel refusal to `false`
    and topologicalBare misclassifies path shapes: a bare repo whose
    gitdir sits under a `worktrees/`-named parent (or is literally
    named `.git`) refuses every judged read or pins core.bare=false →
    isBare reports non-bare → detectRepoKind's fs branch fabricates
    "exempt"/"ungoverned" from planted files (CX-162 via path shape).
*/

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { gitEvidence, isBare, statusDirty } from "../../flow/git.ts";
import { detectRepoKind } from "../../flow/repo-kind.ts";
import { runCompassAuditValidate } from "../../compass/handlers/compass-audit-handler.ts";
import { gitAncestorOf, gitChangedFilesBetween, gitIsClean } from "../../program/discovery.ts";
import { pruneMissionImportersFromLockfile } from "../../mission/lockfile.ts";
import { getRevisionByPath, listDirtyPaths } from "../../compass/handlers/git-revision.ts";
import { runSystemOutboxScan } from "../../system/handlers/system-outbox-scan.ts";
import { runCodebaseMeasure } from "../../codebase/handlers/codebase-measure.ts";
import { planInstall } from "../../flow/handlers/flow-install.ts";
import {
  VALID_EDGES_YAML,
  VALID_PRODUCTS_YAML,
  VALID_SYSTEM_YAML,
  localMapFor,
  makeContext,
  makeProduct,
  makeSystemRepo,
} from "../../system/tests/helpers.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx19-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

const mkBareRepo = (dest: string, seedFiles: Record<string, string>) => {
  const work = mkdtempSync(path.join(os.tmpdir(), "cx19-seed-"));
  tmpdirs.push(work);
  execFileSync("git", ["init", "-q", "-b", "develop", work]);
  git(work, ["config", "user.email", "t@t"]);
  git(work, ["config", "user.name", "t"]);
  for (const [rel, body] of Object.entries(seedFiles)) {
    const abs = path.join(work, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    git(work, ["add", rel]);
  }
  git(work, ["commit", "-qm", "seed"]);
  mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", dest]);
  tmpdirs.push(dest);
  git(work, ["push", "-q", dest, "HEAD:refs/heads/develop"]);
  git(dest, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
  return dest;
};

const GOVERNED = {
  "forge.yaml": "schema: forge/config@1\nproject:\n  name: governed-fixture\n",
};

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

/** include.path → refusedKeys → every judged read -1. */
const plantConfigInclude = (gitDir: string, includeFile: string) => {
  writeFileSync(includeFile, "# session include\n");
  execFileSync("git", [
    "-C",
    gitDir,
    "config",
    "--file",
    path.join(gitDir, "config"),
    "--add",
    "include.path",
    includeFile,
  ]);
};

const AUTHORED = "src/audit-me.ts";
const writeAuthoredFile = (root: string) => {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, AUTHORED),
    "// <MODULE_CONTRACT>\n// purpose: authored fixture file\n// </MODULE_CONTRACT>\nexport const v = 1;\n",
  );
};

describe("CX-166 — ignoreRuleSourcesProven misses commondir redirect + subdir cwd", () => {
  it("control: an authored untracked file is audit-due under --strict", async () => {
    const root = mkRepo();
    writeAuthoredFile(root);
    const result = await runCompassAuditValidate(
      { argv: [], flags: { strict: true } },
      mkCtx(root),
    );
    expect(result.data?.dueCount).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
  });

  it("a forged metadir commondir points info/exclude outside every scanned candidate", async () => {
    // Primary repo + real linked worktree.
    const main = mkRepo();
    const wt = path.join(main, "wt1");
    git(main, ["worktree", "add", wt, "-b", "auto/x"]);
    writeAuthoredFile(wt);
    // Evil common dir: a full gitdir whose info/exclude hides the file.
    const evil = mkdtempSync(path.join(os.tmpdir(), "cx19-evil-"));
    tmpdirs.push(evil);
    cpSync(path.join(main, ".git"), evil, { recursive: true });
    mkdirSync(path.join(evil, "info"), { recursive: true });
    writeFileSync(path.join(evil, "info", "exclude"), "src/**\n");
    // The metadir (<main>/.git/worktrees/wt1) is session-writable .git
    // state — rewrite its commondir to the forged common dir.
    const meta = path.join(main, ".git", "worktrees", path.basename(wt));
    writeFileSync(path.join(meta, "commondir"), `${evil}\n`);
    // Sanity: ambient check-ignore in wt honors the forged common exclude.
    const ci = execFileSync("git", ["-C", wt, "check-ignore", "-v", AUTHORED], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(ci).toContain("info/exclude");
    // The judged channel correctly refuses the forged indirection — but
    // ignoreRuleSourcesProven never consults it when no .gitignore exists.
    const judged = await verifierGit(wt, ["status", "--porcelain"]);
    expect(judged.exitCode).toBe(-1);
    const result = await runCompassAuditValidate({ argv: [], flags: { strict: true } }, mkCtx(wt));
    const suppressed =
      result.exitCode === 0 &&
      !(result.data?.diagnostics ?? []).some(
        (d: { ruleId: string }) => d.ruleId === "COMPASS-AUDIT-01",
      );
    // Contract: an unproven ignore source must not narrow the ledger
    // set — expected COMPASS-AUDIT-01 (or an unverifiable verdict),
    // never a silent skip + pass.
    expect(suppressed).toBe(false);
  });

  it("a .git/info/exclude reachable from a subdir cwd is never proven — payload hidden, gate passes", async () => {
    const root = mkRepo();
    const sub = path.join(root, "pkg");
    mkdirSync(sub, { recursive: true });
    writeAuthoredFile(sub); // pkg/src/audit-me.ts
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    writeFileSync(path.join(root, ".git", "info", "exclude"), "pkg/**\n");
    const result = await runCompassAuditValidate({ argv: [], flags: { strict: true } }, mkCtx(sub));
    const suppressed =
      result.exitCode === 0 &&
      !(result.data?.diagnostics ?? []).some(
        (d: { ruleId: string }) => d.ruleId === "COMPASS-AUDIT-01",
      );
    expect(suppressed).toBe(false);
  });
});

describe("CX-167 — sessionIgnoreRulePaths misses parent-scope .gitignore rules", () => {
  it("gitIsClean reports clean from a subdir while a parent rule hides payloads", async () => {
    const root = mkRepo();
    const sub = path.join(root, "work");
    mkdirSync(sub, { recursive: true });
    // Untracked session rule at repo root: self-hides AND hides payload.
    writeFileSync(path.join(root, ".gitignore"), "*\n");
    writeFileSync(path.join(sub, "payload.ts"), "export const p = 1;\n");
    // Sanity: judged status from the subdir surfaces the ignored rule
    // file — porcelain paths are repository-root-relative (CX-167).
    const st = await verifierGit(sub, ["status", "--porcelain"]);
    expect(st.exitCode).toBe(0);
    expect(st.stdout).toContain("!! .gitignore");
    // Contract: dirty evidence must be truthful or refused — never
    // "clean".
    expect(await gitIsClean(sub)).toBe(false);
    const dirty = await statusDirty(sub, ambientIo);
    expect(dirty.entries.length).toBeGreaterThan(0);
    const listed = await listDirtyPaths(sub);
    expect(listed.paths === null || listed.paths.length > 0).toBe(true);
  });
});

describe("CX-168 — refused history read collapses to revision 1 inside the audit gate", () => {
  it("a dead channel suppresses every audited entry under --strict", async () => {
    const root = mkRepo();
    writeAuthoredFile(root);
    git(root, ["add", AUTHORED]);
    git(root, ["commit", "-qm", "authored"]);
    // Ledger: audited at revision 5, threshold 2.
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "compass-audit-ledger.generated.yaml"),
      [
        "revisionThreshold: 2",
        "entries:",
        `  - path: ${AUTHORED}`,
        "    entityId: e1",
        "    auditedRevision: 5",
        "    auditedHash: sha256-x",
        "    auditedAt: '2026-01-01T00:00:00Z'",
        "    verdict: pass",
        "    agent: human:t",
        "",
      ].join("\n"),
    );
    // Refuse every judged read: include.path is a refusedKeys entry.
    plantConfigInclude(path.join(root, ".git"), path.join(root, "session-include.cfg"));
    const probe = await verifierGit(root, ["status", "--porcelain"]);
    expect(probe.exitCode).toBe(-1);
    const result = await runCompassAuditValidate(
      { argv: [], flags: { strict: true } },
      mkCtx(root),
    );
    // Contract: unverifiable revision evidence must fail closed —
    // never a clean pass built on fabricated revision:1 answers.
    expect(result.exitCode).not.toBe(0);
  });

  it("getRevisionByPath itself reports a fabricated revision on refusal", async () => {
    const root = mkRepo();
    writeAuthoredFile(root);
    git(root, ["add", AUTHORED]);
    git(root, ["commit", "-qm", "authored"]);
    plantConfigInclude(path.join(root, ".git"), path.join(root, "session-include.cfg"));
    const rev = await getRevisionByPath(root, AUTHORED);
    // Contract: revision evidence is truthful or unverifiable — never
    // 1 on refusal.
    expect(rev.revision).not.toBe(1);
  });
});

describe("CX-169 — pinnedGitAdd repoints the staged mutation after a .git swap", () => {
  const LOCKFILE = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies: {}",
    "",
    "  missions/m1/workpiece:",
    "    devDependencies: {}",
    "",
  ].join("\n");

  it("a .git flip between judged show and add stages into a foreign repo; staged:true lies", async () => {
    const real = mkRepo();
    const evil = mkRepo();
    writeFileSync(path.join(real, "pnpm-lock.yaml"), LOCKFILE);
    git(real, ["add", "pnpm-lock.yaml"]);
    git(real, ["commit", "-qm", "lockfile"]);
    const evilIndexBefore = git(evil, ["ls-files", "-s"]);
    // Move the real .git aside mid-call via the io.writeFile seam — the
    // session's deterministic interleaving point between judged read
    // and add.
    const io = {
      exec: ambientIo.exec,
      writeFile: async (target: string, content: string) => {
        renameSync(path.join(real, ".git"), path.join(real, ".git-real"));
        writeFileSync(path.join(real, ".git"), `gitdir: ${path.join(evil, ".git")}\n`);
        writeFileSync(target, content);
      },
    };
    const outcome = await pruneMissionImportersFromLockfile(real, ["m1"], io as never);
    // Restore the real .git for assertions.
    rmSync(path.join(real, ".git"));
    renameSync(path.join(real, ".git-real"), path.join(real, ".git"));
    // Contract: staged:true must mean the JUDGED repo's index carries
    // the pruned bytes — a foreign-index landing is fabricated staging.
    if (outcome.staged) {
      const realIndex = git(real, ["ls-files", "-s", "pnpm-lock.yaml"]);
      const realHeadBlob = git(real, ["rev-parse", "HEAD:pnpm-lock.yaml"]);
      expect(realIndex).not.toContain(realHeadBlob);
      const evilIndexAfter = git(evil, ["ls-files", "-s"]);
      expect(evilIndexAfter).toBe(evilIndexBefore);
    }
  });

  it("info/attributes filter.*.clean must never rewrite staged bytes inside the pinned add", async () => {
    const real = mkRepo();
    const prog = path.join(real, "evil-clean.sh");
    writeFileSync(prog, "#!/bin/sh\necho FORGED-BYTES\n");
    execFileSync("chmod", ["+x", prog]);
    mkdirSync(path.join(real, ".git", "info"), { recursive: true });
    writeFileSync(path.join(real, ".git", "info", "attributes"), "pnpm-lock.yaml filter=evil\n");
    git(real, ["config", "filter.evil.clean", prog]);
    writeFileSync(path.join(real, "pnpm-lock.yaml"), LOCKFILE);
    git(real, ["add", "pnpm-lock.yaml"]);
    git(real, ["commit", "-qm", "lockfile"]);
    const outcome = await pruneMissionImportersFromLockfile(real, ["m1"], {
      exec: ambientIo.exec,
      writeFile: ambientIo.writeFile,
    } as never);
    if (outcome.staged) {
      const stagedBlob = git(real, ["show", ":pnpm-lock.yaml"]);
      // Contract: the staged bytes must be the file the helper wrote —
      // a filter-program rewrite inside the pinned mutation is
      // fabrication.
      expect(stagedBlob).not.toContain("FORGED-BYTES");
    }
  });
});

describe("CX-170 — ambient io.exec git reads inherit the session environment", () => {
  const OUTBOX_ENTRY = `schema: forge/outbox@1
id: OB-9001
contract: alpha-contract
need: "a stable surface"
why: "forged entry"
state: open
`;

  it("system.outbox.scan: GIT_DIR forges a product's committed outbox entries", async () => {
    const alpha = await makeProduct();
    const beta = await makeProduct();
    const systemRoot = await makeSystemRepo({
      "system/system.yaml": VALID_SYSTEM_YAML,
      "system/products.yaml": VALID_PRODUCTS_YAML,
      "system/edges.yaml": VALID_EDGES_YAML,
      "system/products.local.yaml": localMapFor({ alpha, beta }),
    });
    // Clean scan: no product carries committed outbox entries — nothing
    // may be created.
    const clean = await runSystemOutboxScan(
      { argv: [], flags: { create: true } },
      makeContext(systemRoot),
    );
    expect(clean.data?.created ?? []).toEqual([]);
    // Evil repo: a forged outbox entry at develop:docs/outbox/.
    const evil = mkRepo();
    mkdirSync(path.join(evil, "docs", "outbox"), { recursive: true });
    writeFileSync(path.join(evil, "docs", "outbox", "OB-9001.yaml"), OUTBOX_ENTRY);
    writeFileSync(path.join(evil, "forge.yaml"), 'schema: "forge/workspace@1"\n');
    git(evil, ["add", "."]);
    git(evil, ["commit", "-qm", "evil"]);
    git(evil, ["branch", "develop"]);
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(evil, ".git");
    try {
      const forged = await runSystemOutboxScan(
        { argv: [], flags: { create: true } },
        makeContext(systemRoot),
      );
      // Contract: tasks derive only from the PRODUCT's own develop —
      // a session GIT_DIR redirect must never author them.
      expect(forged.data?.created ?? []).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
  });

  it("codebase.measure: GIT_INDEX_FILE narrows the measured file set", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, "src.ts"), "export const a = 1;\n");
    git(root, ["add", "src.ts"]);
    git(root, ["commit", "-qm", "src"]);
    const realTotal = 2; // f.txt + src.ts
    // Curated foreign index: a repo missing src.ts.
    const evil = mkRepo();
    const prev = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = path.join(evil, ".git", "index");
    try {
      const result = await runCodebaseMeasure({ argv: [], flags: {} }, mkCtx(root));
      const measured = Object.values(
        (result.data as { totals?: Record<string, { files: number }> } | undefined)?.totals ?? {},
      ).reduce((sum, t) => sum + t.files, 0);
      // Contract: the measured set is the repo's real tracked set or
      // an explicit failure — never a session-narrowed index.
      expect(measured).toBeGreaterThanOrEqual(realTotal);
    } finally {
      if (prev === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prev;
    }
  });
});

describe("CX-171 — isBare refusal→false + topological path misclassification", () => {
  it("a bare repo under a worktrees/-named parent reports non-bare then exempt", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "cx19-wtp-"));
    tmpdirs.push(base);
    const bare = mkBareRepo(path.join(base, "worktrees", "x"), GOVERNED);
    const ambient = git(bare, ["rev-parse", "--is-bare-repository"]);
    expect(ambient).toBe("true");
    const judged = await gitEvidence(bare, ["rev-parse", "--is-bare-repository"]);
    // Contract: truthful output or explicit refusal — never a
    // fabricated "false" that detectRepoKind maps into the filesystem
    // branch.
    expect(judged.exitCode === 0 ? judged.stdout.trim() : "-1").not.toBe("false");
    expect(await isBare(bare, ambientIo)).toBe(true);
  });

  it("a bare repo literally named .git answers non-bare through the channel", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "cx19-dotgit-"));
    tmpdirs.push(base);
    const bare = mkBareRepo(path.join(base, ".git"), GOVERNED);
    const ambient = git(bare, ["rev-parse", "--is-bare-repository"]);
    expect(ambient).toBe("true");
    const judged = await gitEvidence(bare, ["rev-parse", "--is-bare-repository"]);
    expect(judged.exitCode === 0 ? judged.stdout.trim() : "-1").not.toBe("false");
    expect(await isBare(bare, ambientIo)).toBe(true);
  });

  it("detectRepoKind on a misclassified bare repo fabricates exempt from a planted marker", async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "cx19-wtp2-"));
    tmpdirs.push(base);
    const bare = mkBareRepo(path.join(base, "worktrees", "x"), GOVERNED);
    writeFileSync(
      path.join(bare, "forge.generated.yaml"),
      "schema: forge/generated@1\ngenerator: session\nsource: session\n",
    );
    const detection = await detectRepoKind(bare, ambientIo);
    // Contract: repo identity must come from committed evidence or be
    // unverifiable — a planted file inside a bare dir is not an
    // exemption.
    expect(detection.ok && detection.repoKind.kind === "exempt").toBe(false);
  });

  it("hold: a governed bare repo on a normal path is refused at install plan, before any write", async () => {
    const bare = mkBareRepo(
      path.join(mkdtempSync(path.join(os.tmpdir(), "cx19-b-")), "repo.git"),
      GOVERNED,
    );
    const plan = await planInstall(bare, ambientIo);
    expect(plan.refusal?.ruleId).toBe("FLOW-ADOPT-05");
    expect(plan.steps.some((s) => s.status === "done" && s.step === "detect")).toBe(true);
  });
});

describe("holds — r18 closures re-probed", () => {
  it("HOLD: refused diff is unverifiable, never an empty change set", async () => {
    const root = mkRepo();
    const sha = git(root, ["rev-parse", "HEAD"]);
    plantConfigInclude(path.join(root, ".git"), path.join(root, "session-include.cfg"));
    const changed = await gitChangedFilesBetween(root, sha, sha);
    expect(changed).toBe(null);
  });

  it("HOLD: gitAncestorOf refusal maps to false (fail-closed at callers)", async () => {
    const root = mkRepo();
    const sha = git(root, ["rev-parse", "HEAD"]);
    plantConfigInclude(path.join(root, ".git"), path.join(root, "session-include.cfg"));
    expect(await gitAncestorOf(root, sha, sha)).toBe(false);
  });
});
