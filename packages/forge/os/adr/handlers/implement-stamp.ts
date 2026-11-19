/*
<MODULE_CONTRACT>
<purpose>
RFC-0727: adr.implement.stamp — the exclusive atomic path for
accepted/proposed → implemented ADR transitions. Validates preconditions
and atomically mutates ADR frontmatter.
</purpose>
<non-goals>
  <item>Does not transition ADRs not in accepted or proposed status.</item>
  <item>Does not author acceptance criteria — it only enforces completeness of an existing "## Acceptance criteria" section on post-cutoff ADRs (ADR-IMP-02, mirroring AV-17).</item>
  <item>Does not call the GitHub API or require network access.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0727: initial implementation — mirrors rfc.implement.stamp for ADRs.</item>
  <item>RFC-1504: step 4 — shared stamp lock for rfc and adr stamp handlers</item>
  <item>RFC-1504: review fixes — legacy acquiredAt fallback, atomic break claim, verified stamp release, onStale warnings</item>
  <item>RFC-1616: close RFC-1616 r9 trust-boundary counterexamples

Independent clean-context verification (round 9, candidate 4436339db)
returned REFUTED with ten live counterexamples against the r8-hardened
evidence channel — this commit closes all root causes.

- Pack-carried objects get the loose-sweep integrity anchor: every
  .idx/.pack pair under objects/pack is verify-pack -s'd at preflight
  and the sweep memo key is the unforgeable (ino, ctimeMs, size) stat
  triple (CX-113/114); pack.useBitmapIndex=false pins the bitmap
  reachability cache off.
- Every trusted-path git call routes through the judged/preflighted
  channel: execGit/readCommittedEnvelope/readAcceptanceReports/
  listWorkspaceFiles and the snapshot gitGrep closure now run
  verifierGit/createOriginGit with structured fail-closed dirty
  verdicts (CX-115/118/120/122).
- Export materialization no longer trusts git archive, ambient tar, or
  committed .gitattributes: exportTree enumerates ls-tree -r -z and
  materializes committed bytes through the re-hashed cat-file --batch
  channel, bounding symlink targets to the export root (CX-116/117).
- Index-consulting reads run on a verifier-owned claims rebuild:
  prepareEvidenceIndex copies staged object claims into a fresh index
  with zeroed stat metadata, so status/diff content-hash the worktree
  instead of trusting a session-written stat tuple (CX-121).
- The heredoc lexer is quote-aware: a << inside quotes is string
  content, never an operator (CX-119).
- Pins ride GIT_CONFIG_* env so the spawned argv stays the judged
  query verbatim; diff.external moved from a broken pin to
  refuse-on-presence; OriginGit.run/runExit now judge caller argv with
  the same read table; batch stdin is EPIPE-safe.
- kernel-source-scan models the two channel files as judged bodies so
  the channel migration does not read as new unguarded subprocess hits
  in the werkstatt-site mutation ratchet.

The independent r9 probe file and acceptance report land in the
follow-up port commit.</item>
  <item>RFC-1616: close r17 refusal-polarity consumers — ADR stamp/validate twins + attested dirty verdict</item>
</CHANGE_SUMMARY>
*/

import { verifierGit } from "../../../src/utils/verifier-git.ts";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";

import { join } from "node:path";

import { acquireStampLock } from "../../core/stamp-lock.ts";
import type { StampLockHeld, StampLockOptions } from "../../core/stamp-lock.ts";

import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";

import { listAdrFiles, readAndParseAdr, adrFileMatchesId } from "../frontmatter-io.ts";
import { evaluateAcceptanceCriteria } from "../../rfc/handlers/validate-rules.ts";
import { ADR_DIR, ADR_ACCEPTANCE_CRITERIA_CUTOFF } from "../types.ts";
import type { AdrStatus, AdrImplementStampViolation, AdrImplementStampResult } from "../types.ts";

// Ambient default for helper fns without a context param — handlers override
// with `const io = resolveIo(context.io)` inside their own scope.
const io = ambientIo;
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

// ─── Git helpers ─────────────────────────────────────────────────────────────

// ADR stamp reads go through verifierGit: the dirty verdict and the
// ancestry check are evidence, and ambient GIT_* selectors or a forged
// `.git/index` must not reshape them (CX-121/CX-122).
async function execGit(workspaceRoot: string, args: string[]): Promise<string> {
  const r = await verifierGit(workspaceRoot, args);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

async function isAdrFileClean(workspaceRoot: string, adrRelPath: string): Promise<boolean> {
  // A refused or failed read is NOT a clean file — the dirty verdict is
  // unverifiable, so `exitCode !== 0 → false` (CX-159: the `execGit`
  // nonzero→"" mapping reads a refusal as clean and skips ADR-IMP-04 on
  // exactly the dirty file it guards; the indexUnproven asymmetry keeps
  // every other stamp gate answering honestly, making this the only
  // blind gate — the ADR twin of CX-157).
  const r = await verifierGit(workspaceRoot, ["status", "--porcelain", "--", adrRelPath]);
  return r.exitCode === 0 && r.stdout.trim().length === 0;
}

async function commitReachableFromHead(workspaceRoot: string, commitSha: string): Promise<boolean> {
  const r = await verifierGit(workspaceRoot, ["merge-base", "--is-ancestor", commitSha, "HEAD"]);
  return r.exitCode === 0;
}

async function commitReferencesAdr(
  workspaceRoot: string,
  commitSha: string,
  adrId: string,
): Promise<boolean> {
  const commitMsg = await execGit(workspaceRoot, ["log", "-1", "--format=%B", commitSha]);
  if (commitMsg.includes(adrId)) return true;

  const changedFiles = await execGit(workspaceRoot, [
    "show",
    "--name-only",
    "--format=",
    commitSha,
  ]);
  const slug = adrId.toLowerCase();
  if (changedFiles.toLowerCase().includes(slug)) return true;

  return false;
}

// ─── ADR-specific exclusive lock ─────────────────────────────────────────────

function lockFilePath(workspaceRoot: string, adrId: string): string {
  const slug = adrId.toLowerCase();
  return join(workspaceRoot, ".adr-locks", `${slug}.lock`);
}

// RFC-1504: shared dead-holder recovery — a lock recording this host and a
// dead pid (or a foreign boot id) is broken and retried; a live pid still
// returns acquired:false → ADR-IMP-05. Exported for the lock tests.
export async function acquireAdrLock(
  workspaceRoot: string,
  adrId: string,
  opts: StampLockOptions = {},
): Promise<{ acquired: boolean; lockPath: string; held?: StampLockHeld }> {
  const lockPath = lockFilePath(workspaceRoot, adrId);
  return acquireStampLock(lockPath, opts);
}

// RFC-1504: release only the lock we hold — after a dead/stale break a
// contender may have written a fresh payload, and unlinking it would break
// mutual exclusion entirely. Mirrors withFlowLock's ownership check.
async function releaseAdrLock(lockPath: string, held?: StampLockHeld): Promise<void> {
  try {
    if (held !== undefined) {
      const parsed = JSON.parse(await io.readFile(lockPath)) as { pid?: number; at?: string };
      if (parsed.pid !== held.pid || parsed.at !== held.at) return;
    }
    await io.rm(lockPath);
  } catch {
    // Lock file already removed — safe
  }
}

// ─── Frontmatter mutation ────────────────────────────────────────────────────

function mutateAdrFrontmatter(
  source: string,
  status: "implemented",
  implementedAt: string,
  updatedAt: string,
): string {
  let content = source;

  content = content.replace(/^status: \w+$/m, `status: ${status}`);

  if (/^implementedAt:.*$/m.test(content)) {
    content = content.replace(/^implementedAt:.*$/m, `implementedAt: ${implementedAt}`);
  } else {
    content = content.replace(
      /^updatedAt: .*$/m,
      `updatedAt: ${updatedAt}\nimplementedAt: ${implementedAt}`,
    );
  }

  content = content.replace(/^updatedAt: .*$/m, `updatedAt: ${updatedAt}`);

  return content;
}

function toIsoDate(date: Date): string {
  return date.toISOString().split("T")[0]!;
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function runAdrImplementStamp(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AdrImplementStampResult>> {
  const io = resolveIo(context.io);
  const { workspaceRoot, logger, outputFormat, dryRun } = context;
  const adrDirPath = join(workspaceRoot, ADR_DIR);

  const targetId = input.flags["id"] as string | undefined;
  const implementationCommit = input.flags["implementation-commit"] as string | undefined;

  // ── Flag validation ───────────────────────────────────────────────────────
  if (!targetId) {
    throw new Error("adr.implement.stamp requires --id flag (e.g. --id ADR-0003).");
  }
  if (!implementationCommit) {
    throw new Error(
      "adr.implement.stamp requires --implementation-commit flag (the SHA of the implementation commit).",
    );
  }

  const violations: AdrImplementStampViolation[] = [];
  const isDryRun = dryRun || input.flags["dry-run"] === true;

  // ── Find the target ADR ───────────────────────────────────────────────────
  const files = await listAdrFiles(adrDirPath);
  const targetFile = files.find((f) => adrFileMatchesId(f, targetId));

  if (!targetFile) {
    violations.push({
      rule: "ADR-IMP-01",
      message: `ADR ${targetId} not found in ${ADR_DIR}.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  const targetParsed = await readAndParseAdr(adrDirPath, targetFile);
  if (!targetParsed) {
    violations.push({
      rule: "ADR-IMP-01",
      message: `Could not parse target ADR ${targetId}.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  const fm = targetParsed.parsed.frontmatter;
  const currentStatus = String(fm["status"] ?? "") as AdrStatus;

  // ── ADR-IMP-01: must be in accepted or proposed status ─────────────────────
  if (currentStatus !== "accepted" && currentStatus !== "proposed") {
    violations.push({
      rule: "ADR-IMP-01",
      message: `ADR ${targetId} has status "${currentStatus}" — only "accepted" or "proposed" ADRs can be stamped to "implemented".`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── ADR-IMP-02: acceptance criteria completeness (mirrors AV-17 / RFC-IMP-02) ──
  // Post-cutoff ADRs with an "## Acceptance criteria" section must have all
  // criteria checked with inline (evidence: ...) before stamping — otherwise
  // adr.validate fails with AV-17 after the status transition.
  const createdAtStr = String(fm["createdAt"] ?? "");
  const criteriaEval =
    createdAtStr >= ADR_ACCEPTANCE_CRITERIA_CUTOFF
      ? evaluateAcceptanceCriteria(targetParsed.parsed.body)
      : undefined;
  if (criteriaEval && criteriaEval.totalUnchecked > 0) {
    violations.push({
      rule: "ADR-IMP-02",
      message: `${criteriaEval.totalUnchecked} acceptance criteria are unchecked. All criteria must be checked before stamping: ${criteriaEval.uncheckedLines.join("; ")}`,
    });
  }
  if (criteriaEval && criteriaEval.checkedWithoutEvidence.length > 0) {
    violations.push({
      rule: "ADR-IMP-02",
      message: `${criteriaEval.checkedWithoutEvidence.length} checked criteria lack inline (evidence: ...) annotation: ${criteriaEval.checkedWithoutEvidence.join("; ")}`,
    });
  }

  // ── ADR-IMP-04: ADR file must be clean (no uncommitted edits to the target ADR) ──
  const adrRelPath = join(ADR_DIR, targetFile);
  const adrFileClean = await isAdrFileClean(workspaceRoot, adrRelPath);
  if (!adrFileClean) {
    violations.push({
      rule: "ADR-IMP-04",
      message: `ADR file ${adrRelPath} has uncommitted changes or its dirty state could not be verified. Commit the ADR file before stamping.`,
    });
  }

  // ── ADR-IMP-03: implementation commit validation ──────────────────────────
  const reachable = await commitReachableFromHead(workspaceRoot, implementationCommit);
  if (!reachable) {
    violations.push({
      rule: "ADR-IMP-03",
      message: `Implementation commit ${implementationCommit} is not reachable from HEAD. The commit must be an ancestor of the current HEAD.`,
    });
  } else {
    const referencesAdr = await commitReferencesAdr(workspaceRoot, implementationCommit, targetId);
    if (!referencesAdr) {
      violations.push({
        rule: "ADR-IMP-03",
        message: `Implementation commit ${implementationCommit} does not reference ${targetId} in its message or changed files.`,
        fixHint: `The message check is case-sensitive on the uppercase id (${targetId}, not a lowercase scope like "docs(adr-xxxx):"). For post-hoc ADRs whose historic implementation commit never mentions the id, pass the "adr: accept" or "trace:" commit instead — both qualify; a commit whose changed-file list contains the adr-xxxx-* slug also qualifies.`,
      });
    }
  }

  // If any violations found, return without mutation
  if (violations.length > 0) {
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── ADR-IMP-05: acquire ADR-specific exclusive lock ───────────────────────
  const { acquired, lockPath, held } = await acquireAdrLock(workspaceRoot, targetId, {
    onStale: (info) =>
      logger.warn(
        `broke ${info.reason} stamp lock ${info.path} (pid ${info.pid ?? "?"} on ${info.host ?? "?"})`,
      ),
  });
  if (!acquired) {
    violations.push({
      rule: "ADR-IMP-05",
      message: `A concurrent stamp operation is in progress for ${targetId}. Wait for it to complete and retry.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  try {
    // ── Atomic mutation ──────────────────────────────────────────────────────
    const adrFilePath = join(adrDirPath, targetFile);
    const adrSource = await io.readFile(adrFilePath);

    const today = toIsoDate(new Date());
    const stampedAt = new Date().toISOString();
    const mutatedSource = mutateAdrFrontmatter(adrSource, "implemented", today, today);

    if (isDryRun) {
      if (outputFormat === "pretty") {
        logger.success(`[dry-run] ${targetId} would be stamped as implemented`);
        logger.info(`  implementation commit: ${implementationCommit}`);
        if (criteriaEval) {
          logger.info(`  criteria checked: ${criteriaEval.totalChecked}`);
        }
        logger.info(`  stamped at: ${stampedAt}`);
      }
      return {
        data: {
          command: "adr.implement.stamp",
          status: "pass",
          data: {
            adrId: targetId,
            implementationCommit,
            stampedAt,
            ...(criteriaEval ? { criteriaChecked: criteriaEval.totalChecked } : {}),
          },
          violations: [],
        },
        exitCode: 0,
        summary: `adr.implement.stamp: dry-run — ${targetId} would be stamped`,
      };
    }

    await writeFileAtomic(adrFilePath, mutatedSource);

    if (outputFormat === "pretty") {
      logger.success(`${targetId} stamped as implemented`);
      logger.info(`  implementation commit: ${implementationCommit}`);
      if (criteriaEval) {
        logger.info(`  criteria checked: ${criteriaEval.totalChecked}`);
      }
      logger.info(`  stamped at: ${stampedAt}`);
    }

    return {
      data: {
        command: "adr.implement.stamp",
        status: "pass",
        data: {
          adrId: targetId,
          implementationCommit,
          stampedAt,
          ...(criteriaEval ? { criteriaChecked: criteriaEval.totalChecked } : {}),
        },
        violations: [],
      },
      exitCode: 0,
      summary: `adr.implement.stamp: ${targetId} stamped as implemented`,
      nextSteps: [
        {
          action: `Commit the stamp: pnpm exec forge run ecosystem.commit`,
          kind: "optional",
        },
      ],
    };
  } finally {
    await releaseAdrLock(lockPath, held);
  }
}

function stampFailResult(
  violations: AdrImplementStampViolation[],
  isDryRun: boolean,
  outputFormat: string,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): ForgeCommandResult<AdrImplementStampResult> {
  const prefix = isDryRun ? "[dry-run] " : "";
  if (outputFormat === "pretty") {
    for (const v of violations) {
      logger.warn(`${prefix}${v.rule}: ${v.message}`);
    }
  }
  return {
    data: {
      command: "adr.implement.stamp",
      status: "fail",
      violations,
    },
    exitCode: 1,
    summary: `${prefix}adr.implement.stamp: ${violations.length} violation${violations.length === 1 ? "" : "s"}`,
  };
}
