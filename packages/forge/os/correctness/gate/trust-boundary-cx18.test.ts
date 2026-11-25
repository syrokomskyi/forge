/*
RFC-1616 round-18 independent adversarial probes — candidate commit
21c2759e9 ("r17-remediated candidate"), exported tree.

Every counterexample probe FAILS while its hole is live and PASSES only
after the hole is closed. Hold probes document classes this round
re-probed and found closed. Numbering continues from CX-161 (round 17).

Round-18 findings — two distinct residual classes:

  A. The channel's own pins fabricate output on a HEALTHY repo surface:
     `EVIDENCE_CONFIG_PINS` (src/utils/verifier-git.ts:329) injects
     `core.bare=` unconditionally. Git parses `core.bare=` (empty) as
     false, so `rev-parse --is-bare-repository` answers "false" on
     EVERY real bare repository — no adversarial surface required and
     nothing refused. `isBare` (os/flow/git.ts:476) is therefore
     constant-false, and every bare-aware consumer silently re-derives
     repository identity from WORKTREE-path filesystem reads a bare
     repo never serves. (`worktree list --porcelain` derives bareness
     per entry, not from `core.bare` — its `bare` attribute stays
     honest; held green below.)

  B. Unjudged git reads bypassing the channel entirely: ambient-io
     `io.exec("git", ...)` inherits the session's full environment
     (GIT_DIR/GIT_INDEX_FILE/GIT_CONFIG_*), and `execSync("git ...")` /
     `execFileSync("git", ...)` consumers run the ambient binary under
     ambient config. On these paths session config levers
     (`status.showUntrackedFiles`, session-authored `.gitignore`) that
     the judged channel pins or refuses are honored verbatim.

  CX-162 — `core.bare=` pin → `isBare` constant-false →
    `detectRepoKind` (os/flow/repo-kind.ts:60-93) takes the NON-bare
    branch of `readRepoRootFile` and reads `<bare>/forge.generated.yaml`
    / `<bare>/forge.yaml` from the filesystem — bytes git never
    committed and never serves. A governed bare repo (forge.yaml
    committed on develop, provable via `git show` through the same
    channel) reports "ungoverned" via `detectRepoKind` AND
    `collectFlowCheck` (empty diagnostics), reports "exempt" if a
    session plants a marker file inside the bare dir, and reports
    `isFlowAdopted === false` on a fully adopted bare repo.

  CX-163 — `filterLedgerEligiblePaths` (os/compass/handlers/
    compass-audit-handler.ts) runs `check-ignore --stdin` through a raw
    execFileSync: binary-resolved and env-scrubbed, but the repo config
    AND the worktree's untracked, session-authored `.gitignore` files
    are honored without judgment. A planted `.gitignore` marks an
    authored-but-untracked file "ignored" → ledger-ineligible →
    `compass.audit.validate --strict` reports OK and skips the
    never-audited file the check exists to flag.

  CX-164 — `restoreTrackedLockfile` (os/mission/lockfile.ts:41-49)
    reads `git show HEAD:pnpm-lock.yaml` through `io.exec` — ambient
    env. `GIT_DIR` pointing into a session repo substitutes the
    committed bytes wholesale; the helper writes them over the
    worktree lockfile and returns "restored". Called from
    docs.archive's post-mission safety net and mission.archive's
    importer pruning.

  CX-165 — `gitIsClean` (os/program/discovery.ts) runs
    `execSync("git status --porcelain")` — ambient binary, ambient env,
    ambient config. `status.showUntrackedFiles=no` in .git/config makes
    the porcelain read empty on a tree carrying untracked files, and
    `program.packet.validate` (runValidate → validateSealTransition)
    emits status:"pass" with the PROGRAM-PACKET-10 dirty-tree guard
    never firing.

Holds re-probed this round (r17 closures):

  - `isAdrFileClean` — a refused path-scoped status still blocks the
    stamp with ADR-IMP-04 (CX-159 polarity holds).
  - AV-16 — a refused `log --since` read still yields the
    `unverifiable` drift warning, never silence (CX-160).
  - `captureGitContext` — a refused status read still records
    `workingTreeDirty: true` (CX-161); a healthy tree reports
    honestly (control).
*/

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ambientIo } from "../../../src/utils/io.ts";
import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { gitEvidence, worktreeList } from "../../flow/git.ts";
import { detectRepoKind } from "../../flow/repo-kind.ts";
import { isFlowAdopted } from "../../flow/index.ts";
import { renderManagedPreCommit } from "../../flow/guard-files.ts";
import { collectFlowCheck } from "../../flow/handlers/flow-check.ts";
import { runCompassAuditValidate } from "../../compass/handlers/compass-audit-handler.ts";
import { restoreTrackedLockfile } from "../../../src/utils/lockfile.ts";
import { runValidate as runProgramPacketValidate } from "../../program/handlers/validate.ts";
import { runAdrImplementStamp } from "../../adr/handlers/implement-stamp.ts";
import { runAdrValidate } from "../../adr/handlers/validate.ts";
import { captureGitContext } from "../../rfc/verification-evidence.ts";
import { listDirtyPaths } from "../../compass/handlers/git-revision.ts";

const tmpdirs: string[] = [];
afterEach(() => {
  while (tmpdirs.length > 0) rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const git = (root: string, args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const mkRepo = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cx18-"));
  tmpdirs.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  writeFileSync(path.join(root, "f.txt"), "v1\n");
  git(root, ["add", "f.txt"]);
  git(root, ["commit", "-qm", "c1"]);
  return root;
};

/** Bare repo seeded from a scratch work repo; HEAD → refs/heads/develop. */
const mkBareRepo = (seedFiles: Record<string, string>) => {
  const work = mkdtempSync(path.join(os.tmpdir(), "cx18-seed-"));
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
  const bare = mkdtempSync(path.join(os.tmpdir(), "cx18-bare-"));
  tmpdirs.push(bare);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(work, ["push", "-q", bare, "HEAD:refs/heads/develop"]);
  git(bare, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
  return bare;
};

/** `include.path` in repo config → refusedKeys → every judged read -1.
 * Works identically for `<bare>/config` and `.git/config`. */
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

const GOVERNED_BARE_FILES = {
  "forge.yaml": "schema: forge/config@1\nproject:\n  name: governed-fixture\n",
};

describe("CX-162 — core.bare= pin fabricates non-bare on every bare repo", () => {
  it("channel sanity: include.path in <bare>/config refuses every judged read", async () => {
    const bare = mkBareRepo(GOVERNED_BARE_FILES);
    plantConfigInclude(bare, path.join(bare, "session-include.cfg"));
    const r = await gitEvidence(bare, ["rev-parse", "--is-bare-repository"]);
    expect(r.exitCode).toBe(-1);
  });

  it("rev-parse --is-bare-repository answers 'false' on a real bare repo — no refusal", async () => {
    const bare = mkBareRepo(GOVERNED_BARE_FILES);
    // Ambient git tells the truth; the judged channel must match it.
    const ambient = git(bare, ["rev-parse", "--is-bare-repository"]);
    expect(ambient).toBe("true");
    const r = await gitEvidence(bare, ["rev-parse", "--is-bare-repository"]);
    expect(r.exitCode).toBe(0);
    // Contract: truthful output or refusal — a pinned "false" on a
    // real bare repo is a fabricated answer the channel itself
    // produces (EVIDENCE_CONFIG_PINS `core.bare=`).
    expect(r.stdout.trim()).toBe("true");
  });

  it("detectRepoKind reports 'ungoverned' on a governed bare repo — healthy channel", async () => {
    const bare = mkBareRepo(GOVERNED_BARE_FILES);
    // The committed marker surface is real: the same channel proves it.
    const healthyShow = await gitEvidence(bare, ["show", "refs/heads/develop:forge.yaml"]);
    expect(healthyShow.exitCode).toBe(0);
    expect(healthyShow.stdout).toContain("governed-fixture");
    const healthy = await detectRepoKind(bare, ambientIo);
    // Contract: repo identity must come from committed evidence or be
    // unverifiable — a fabricated "ungoverned" on a governed bare repo
    // is a curated clean verdict.
    expect(healthy).toEqual({ ok: true, repoKind: { kind: "governed" } });
  });

  it("a marker file planted inside the bare dir fabricates 'exempt'", async () => {
    const bare = mkBareRepo({ "some.txt": "x\n" });
    // Session plants a marker FILE inside the bare dir — git never
    // serves it, but the non-bare fs branch reads it as repo identity.
    writeFileSync(
      path.join(bare, "forge.generated.yaml"),
      "schema: forge/generated@1\ngenerator: session\nsource: session\n",
    );
    const detection = await detectRepoKind(bare, ambientIo);
    // Contract: exemption must come from committed evidence only — a
    // planted file inside a bare dir is not an adoption marker.
    expect(detection.ok && detection.repoKind.kind === "exempt").toBe(false);
  });

  it("collectFlowCheck reports a silent benign verdict on a governed bare repo", async () => {
    const bare = mkBareRepo(GOVERNED_BARE_FILES);
    const outcome = await collectFlowCheck(bare, ambientIo);
    const benign = outcome.data.repoKind === "ungoverned" || outcome.data.repoKind === "exempt";
    // Contract: unverifiable/misread adoption state must carry a
    // diagnostic — "ungoverned, 0 diagnostics" is a curated clean.
    expect(outcome.data.repoKind).toBe("governed");
    expect(benign && outcome.diagnostics.length === 0).toBe(false);
  });

  it("isFlowAdopted reports false on a fully adopted bare repo", async () => {
    const bare = mkBareRepo({
      ...GOVERNED_BARE_FILES,
      "hooks/pre-commit": renderManagedPreCommit(),
    });
    // Same channel proves every adoption input exists at develop.
    expect((await gitEvidence(bare, ["show", "develop:hooks/pre-commit"])).exitCode).toBe(0);
    // Contract: adoption = committed marker + develop branch + managed
    // pre-commit block — all present; reporting false is a fabricated
    // "not adopted" verdict that blocks flow lifecycle commands.
    expect(await isFlowAdopted(bare, ambientIo)).toBe(true);
  });
});

describe("CX-163 — raw check-ignore honors a session-authored .gitignore", () => {
  const SRC = "src/audit-me.ts";
  const writeAuthoredFile = (root: string) => {
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, SRC),
      "// <MODULE_CONTRACT>\n// purpose: authored fixture file for audit ledger eligibility\n// </MODULE_CONTRACT>\nexport const v = 1;\n",
    );
  };

  it("control: an authored untracked file is audit-due under --strict", async () => {
    const root = mkRepo();
    writeAuthoredFile(root);
    const result = await runCompassAuditValidate(
      { argv: [], flags: { strict: true } },
      mkCtx(root),
    );
    expect(result.data?.dueCount).toBeGreaterThan(0);
    expect(
      (result.data?.diagnostics ?? []).some(
        (d: { ruleId: string }) => d.ruleId === "COMPASS-AUDIT-01",
      ),
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("a session-planted untracked .gitignore hides the file from the ledger gate", async () => {
    const root = mkRepo();
    writeAuthoredFile(root);
    // The judged channel sees the planted rule file as ordinary
    // untracked dirt — no refusal, nothing to judge.
    writeFileSync(path.join(root, ".gitignore"), "src/**\n");
    const status = await verifierGit(root, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("?? .gitignore");

    const result = await runCompassAuditValidate(
      { argv: [], flags: { strict: true } },
      mkCtx(root),
    );
    // Contract: a session-authored ignore rule must not narrow the
    // audit ledger's eligible set — the check-ignore read honors it
    // verbatim and the file reports "ledger-ineligible" (skipped) with
    // zero diagnostics. Expected: COMPASS-AUDIT-01 fires (or an
    // unverifiable verdict), never silent skip + pass.
    const suppressed =
      result.exitCode === 0 &&
      !(result.data?.diagnostics ?? []).some(
        (d: { ruleId: string }) => d.ruleId === "COMPASS-AUDIT-01",
      );
    expect(suppressed).toBe(false);
  });
});

describe("CX-164 — io.exec ambient env: GIT_DIR substitutes committed bytes", () => {
  it("restoreTrackedLockfile writes session-repo bytes into the worktree", async () => {
    const real = mkRepo();
    writeFileSync(path.join(real, "pnpm-lock.yaml"), "REAL-LOCK-BYTES\n");
    git(real, ["add", "pnpm-lock.yaml"]);
    git(real, ["commit", "-qm", "lockfile"]);

    const evil = mkRepo();
    writeFileSync(path.join(evil, "pnpm-lock.yaml"), "FORGED-LOCK-BYTES\n");
    git(evil, ["add", "pnpm-lock.yaml"]);
    git(evil, ["commit", "-qm", "evil"]);

    const prevGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(evil, ".git");
    try {
      // Sanity: the ambient channel serves the session's committed bytes.
      const probe = await ambientIo.exec("git", ["show", "HEAD:pnpm-lock.yaml"], {
        cwd: real,
      });
      expect(probe.stdout).toContain("FORGED-LOCK-BYTES");

      const restored = await restoreTrackedLockfile(real, ambientIo);
      const content = readFileSync(path.join(real, "pnpm-lock.yaml"), "utf8");
      // Contract: under a redirected committed-blob read the helper must
      // refuse (restored:false, no write) or serve the REAL repo's
      // bytes. Writing session-substituted bytes and reporting
      // "restored" lands forged evidence as a worktree mutation.
      expect(restored === true && content.includes("FORGED-LOCK-BYTES")).toBe(false);
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
    }
  });
});

describe("CX-165 — program.packet: raw git status honors status.showUntrackedFiles", () => {
  const writeProgramFixture = (root: string) => {
    const dir = path.join(root, "docs", "plans", "prog-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "program.yaml"),
      [
        "schema: forge/program@1",
        "program: RFC-9999",
        "title: trust-boundary fixture",
        "state: executing",
        "currentPacket: p1",
        'steward: "human:op"',
        "sequential: true",
        "parallelism: 1",
        "packets:",
        "  - order: 0",
        "    packetId: p1",
        "    file: p1.md",
        "    state: draft",
        "    governingDecision: RFC-9999",
        "    decisionKind: rfc",
        "    resolvedRfc: null",
        "    dependsOnPacket: null",
        "    baseCommit: null",
        "    sealCommit: null",
        "    completion: null",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(dir, "p1.md"),
      [
        "---",
        "schema: forge/program-packet@1",
        "program: RFC-9999",
        "packetId: p1",
        "state: draft",
        "governingDecision: RFC-9999",
        "decisionKind: rfc",
        "resolvedRfc: null",
        "dependsOnPacket: null",
        "baseCommit: null",
        'steward: "human:op"',
        "normativeSources: []",
        'allowedFiles: ["src/**"]',
        "forbiddenFiles: []",
        "permittedTransitionDiagnostics: []",
        "requiredValidations: []",
        "---",
        "",
        "# Packet p1",
        "",
      ].join("\n"),
    );
    git(root, ["add", "docs/plans/prog-1"]);
    git(root, ["commit", "-qm", "program fixture"]);
  };

  it("control: a dirty tree fails validate with PROGRAM-PACKET-10", async () => {
    const root = mkRepo();
    writeProgramFixture(root);
    writeFileSync(path.join(root, "untracked-dirty.txt"), "x\n");
    const result = await runProgramPacketValidate(
      { argv: [], flags: { program: "RFC-9999", packet: "p1" } },
      mkCtx(root),
    );
    expect(result.data?.status).toBe("fail");
    expect(
      (result.data?.violations ?? []).some((v: { rule: string }) => v.rule === "PROGRAM-PACKET-10"),
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("status.showUntrackedFiles=no forges a clean tree for the packet gate", async () => {
    const root = mkRepo();
    writeProgramFixture(root);
    writeFileSync(path.join(root, "untracked-dirty.txt"), "x\n");
    git(root, ["config", "status.showUntrackedFiles", "no"]);

    // The judged channel pins -uall argv-side — it still sees the dirt.
    const judged = await verifierGit(root, ["status", "--porcelain"]);
    expect(judged.exitCode).toBe(0);
    expect(judged.stdout).toContain("?? untracked-dirty.txt");

    const result = await runProgramPacketValidate(
      { argv: [], flags: { program: "RFC-9999", packet: "p1" } },
      mkCtx(root),
    );
    // Contract: the dirty-tree guard must not consult session-narrowed
    // porcelain output — expected PROGRAM-PACKET-10 (or a refusal),
    // never status:"pass" on a dirty tree.
    const passedDirty =
      result.data?.status === "pass" &&
      !(result.data?.violations ?? []).some(
        (v: { rule: string }) => v.rule === "PROGRAM-PACKET-10",
      );
    expect(passedDirty).toBe(false);
  });
});

describe("holds — r17 closures re-probed", () => {
  it("HOLD: worktree list --porcelain retains the 'bare' attribute through the channel", async () => {
    const bare = mkBareRepo(GOVERNED_BARE_FILES);
    const ambient = git(bare, ["worktree", "list", "--porcelain"]);
    expect(ambient).toContain("\nbare");
    const worktrees = await worktreeList(bare, ambientIo);
    // The topology read derives bareness per worktree entry, not from
    // `core.bare` config — the pin does not reach it. Keeping this
    // honest is what the CX-162 fix must not regress.
    expect(worktrees.some((w) => w.bare)).toBe(true);
  });

  it("HOLD CX-159: ADR-IMP-04 still fires when the dirty read is refused", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "docs", "adrs"), { recursive: true });
    const adrRel = "docs/adrs/adr-0003-stamp-target.md";
    writeFileSync(
      path.join(root, adrRel),
      "---\nid: ADR-0003\nstatus: accepted\ncreatedAt: 2025-01-01\ndecider: team\nscope: workspace\n---\n\n## Body\n",
    );
    git(root, ["add", adrRel]);
    git(root, ["commit", "-qm", "implement: ADR-0003 stamp target"]);
    const sha = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, ".git", "index"), Buffer.from("not-an-index"));
    const status = await verifierGit(root, ["status", "--porcelain", "--", adrRel]);
    expect(status.exitCode).toBe(-1);
    const result = await runAdrImplementStamp(
      { argv: [], flags: { id: "ADR-0003", "implementation-commit": sha } },
      mkCtx(root),
    );
    expect(
      (result.data?.violations ?? []).some((v: { rule: string }) => v.rule === "ADR-IMP-04"),
    ).toBe(true);
  });

  it("HOLD CX-160: AV-16 reports unverifiable when the drift read refuses", async () => {
    const root = mkRepo();
    mkdirSync(path.join(root, "docs", "adrs"), { recursive: true });
    writeFileSync(
      path.join(root, "docs", "adrs", "adr-0007-drift.md"),
      "---\nid: ADR-0007\nstatus: accepted\ncreatedAt: 2025-01-02\ndecider: team\nscope: workspace\n---\n\n## Body\n",
    );
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    writeFileSync(path.join(root, ".git", "info", "exclude"), "*.key\n");
    const log = await verifierGit(root, ["log", "--since=2025-01-02", "--oneline"]);
    expect(log.exitCode).toBe(-1);
    const result = await runAdrValidate({ argv: [], flags: {} }, mkCtx(root));
    expect(
      (result.data?.violations ?? []).some(
        (v: { rule: string; message: string }) =>
          v.rule === "AV-16" && v.message.includes("unverifiable"),
      ),
    ).toBe(true);
  });

  it("HOLD CX-161: captureGitContext records dirty:true on a refused status read", async () => {
    const root = mkRepo();
    writeFileSync(path.join(root, ".git", "index"), Buffer.from("not-an-index"));
    const status = await verifierGit(root, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(-1);
    const ctx = await captureGitContext(root);
    expect(ctx.workingTreeDirty).toBe(true);
  });

  it("CONTROL: a healthy clean tree answers every surface honestly", async () => {
    const root = mkRepo();
    const ctx = await captureGitContext(root);
    expect(ctx.workingTreeDirty).toBe(false);
    expect(ctx.commit).toMatch(/^[0-9a-f]{40}$/);
    const dirty = await listDirtyPaths(root);
    expect(dirty.refused).toBe(false);
    expect(dirty.paths).toEqual([]);
    const detection = await detectRepoKind(root, ambientIo);
    if (!detection.ok) throw new Error("detectRepoKind refused a healthy repo");
    expect(detection.repoKind.kind).toBe("ungoverned");
    const status = await verifierGit(root, ["status", "--porcelain"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout.trim()).toBe("");
  });
});
