/*
<MODULE_CONTRACT>
<purpose>
RFC-0476: rfc.implement.stamp — the exclusive atomic path for every
accepted → implemented RFC transition. Validates preconditions, records
verification evidence, and atomically mutates RFC frontmatter.
</purpose>
<non-goals>
  <item>Does not transition non-accepted RFCs.</item>
  <item>Does not bypass V-26/V-27 criterion semantics — reuses evaluateAcceptanceCriteria.</item>
  <item>Does not call the GitHub API or require network access.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0476: initial implementation.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";
import { parse as yamlParse } from "yaml";

import { listRfcFiles, readAndParseRfc, rfcFileMatchesId } from "../frontmatter-io.ts";
import { evaluateAcceptanceCriteria } from "./validate-rules.ts";
import { toIsoDate } from "./shared.ts";
import { RFC_DIR, RFC_METADATA_CUTOFF } from "../types.ts";
import type {
  RfcStatus,
  RfcImplementStampData,
  RfcImplementStampViolation,
  RfcImplementStampResult,
} from "../types.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

const VERIFICATION_DIR = join(RFC_DIR, "verification");

// ─── Git helpers ─────────────────────────────────────────────────────────────

function execGit(workspaceRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: workspaceRoot, timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve("");
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function isRfcFileClean(workspaceRoot: string, rfcRelPath: string): Promise<boolean> {
  const status = await execGit(workspaceRoot, ["status", "--porcelain", "--", rfcRelPath]);
  return status.length === 0;
}

async function commitReachableFromHead(workspaceRoot: string, commitSha: string): Promise<boolean> {
  const result = await execGit(workspaceRoot, ["merge-base", "--is-ancestor", commitSha, "HEAD"]);
  // merge-base --is-ancestor exits 0 if ancestor, 1 if not, >1 on error
  // execGit returns "" on error (non-zero exit), trimmed stdout on success
  // So we need a different approach: check exit code directly
  return new Promise((resolve) => {
    execFile(
      "git",
      ["merge-base", "--is-ancestor", commitSha, "HEAD"],
      { cwd: workspaceRoot, timeout: 10000 },
      (err) => {
        resolve(!err);
      },
    );
  });
}

async function commitReferencesRfc(
  workspaceRoot: string,
  commitSha: string,
  rfcId: string,
): Promise<boolean> {
  // Check the commit message and the diff for the RFC ID
  const commitMsg = await execGit(workspaceRoot, ["log", "-1", "--format=%B", commitSha]);
  if (commitMsg.includes(rfcId)) return true;

  // Also check if the commit touched a file whose name contains the RFC id
  const changedFiles = await execGit(workspaceRoot, [
    "show",
    "--name-only",
    "--format=",
    commitSha,
  ]);
  const slug = rfcId.toLowerCase();
  if (changedFiles.toLowerCase().includes(slug)) return true;

  return false;
}

// ─── RFC-specific exclusive lock ─────────────────────────────────────────────

function lockFilePath(workspaceRoot: string, rfcId: string): string {
  const slug = rfcId.toLowerCase();
  return join(workspaceRoot, ".rfc-locks", `${slug}.lock`);
}

async function acquireRfcLock(
  workspaceRoot: string,
  rfcId: string,
): Promise<{ acquired: boolean; lockPath: string }> {
  const lockPath = lockFilePath(workspaceRoot, rfcId);
  const lockDir = dirname(lockPath);
  await mkdir(lockDir, { recursive: true });

  // Atomic lock acquisition via O_EXCL file creation
  const { open } = await import("node:fs/promises");
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    );
    await handle.close();
    return { acquired: true, lockPath };
  } catch {
    return { acquired: false, lockPath };
  }
}

async function releaseRfcLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Lock file already removed — safe
  }
}

// ─── Evidence helpers ────────────────────────────────────────────────────────

async function checkExistingEvidence(
  workspaceRoot: string,
  rfcId: string,
): Promise<{ exists: boolean; overall: string }> {
  const slug = rfcId.toLowerCase();
  const evidencePath = join(workspaceRoot, VERIFICATION_DIR, `${slug}.generated.yaml`);
  try {
    const content = await readFile(evidencePath, "utf-8");
    const evidence = yamlParse(content) as { overall?: string };
    return { exists: true, overall: String(evidence.overall ?? "") };
  } catch {
    return { exists: false, overall: "missing" };
  }
}

// ─── Frontmatter mutation ────────────────────────────────────────────────────

function mutateFrontmatter(
  source: string,
  status: "implemented",
  implementedAt: string,
  updatedAt: string,
): string {
  let content = source;

  // Replace status
  content = content.replace(/^status: \w+$/m, `status: ${status}`);

  // Replace implementedAt (may be empty or already set)
  if (/^implementedAt:.*$/m.test(content)) {
    content = content.replace(/^implementedAt:.*$/m, `implementedAt: ${implementedAt}`);
  } else {
    // Insert after updatedAt
    content = content.replace(
      /^updatedAt: .*$/m,
      `updatedAt: ${updatedAt}\nimplementedAt: ${implementedAt}`,
    );
  }

  // Replace updatedAt
  content = content.replace(/^updatedAt: .*$/m, `updatedAt: ${updatedAt}`);

  return content;
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function runRfcImplementStamp(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcImplementStampResult>> {
  const { workspaceRoot, logger, outputFormat, dryRun } = context;
  const rfcDirPath = join(workspaceRoot, RFC_DIR);

  const targetId = input.flags["id"] as string | undefined;
  const implementationCommit = input.flags["implementation-commit"] as string | undefined;

  // ── Flag validation ───────────────────────────────────────────────────────
  if (!targetId) {
    throw new Error("rfc.implement.stamp requires --id flag (e.g. --id RFC-0476).");
  }
  if (!implementationCommit) {
    throw new Error(
      "rfc.implement.stamp requires --implementation-commit flag (the SHA of the implementation commit).",
    );
  }

  const violations: RfcImplementStampViolation[] = [];
  const isDryRun = dryRun || input.flags["dry-run"] === true;

  // ── Find the target RFC ───────────────────────────────────────────────────
  const files = await listRfcFiles(rfcDirPath);
  const targetFile = files.find((f) => rfcFileMatchesId(f, targetId));

  if (!targetFile) {
    violations.push({
      rule: "RFC-IMP-01",
      message: `RFC ${targetId} not found in ${RFC_DIR}.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  const targetParsed = await readAndParseRfc(rfcDirPath, targetFile);
  if (!targetParsed) {
    violations.push({
      rule: "RFC-IMP-01",
      message: `Could not parse target RFC ${targetId}.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }
  if ("error" in targetParsed) {
    violations.push({
      rule: "RFC-IMP-01",
      message: `Could not parse target RFC ${targetId}: ${targetParsed.error}`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  const fm = targetParsed.parsed.frontmatter;
  const body = targetParsed.parsed.body;
  const currentStatus = String(fm["status"] ?? "") as RfcStatus;

  // ── RFC-IMP-01: must be in accepted status ────────────────────────────────
  if (currentStatus !== "accepted") {
    violations.push({
      rule: "RFC-IMP-01",
      message: `RFC ${targetId} has status "${currentStatus}" — only "accepted" RFCs can be stamped to "implemented".`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── RFC-IMP-02: criterion checks (V-26/V-27 semantics) ────────────────────
  const criteriaEval = evaluateAcceptanceCriteria(body);
  if (criteriaEval.totalUnchecked > 0) {
    violations.push({
      rule: "RFC-IMP-02",
      message: `${criteriaEval.totalUnchecked} acceptance criteria are unchecked. All criteria must be checked before stamping: ${criteriaEval.uncheckedLines.join("; ")}`,
    });
  }
  if (criteriaEval.checkedWithoutEvidence.length > 0) {
    violations.push({
      rule: "RFC-IMP-02",
      message: `${criteriaEval.checkedWithoutEvidence.length} checked criteria lack inline (evidence: ...) annotation: ${criteriaEval.checkedWithoutEvidence.join("; ")}`,
    });
  }

  // ── RFC-IMP-04: RFC file must be clean (no uncommitted edits to the target RFC) ──
  // Only the RFC file being stamped is checked, not the entire working tree.
  // This allows multi-agent workflows where other agents may have uncommitted
  // changes in unrelated files.
  const rfcRelPath = join(RFC_DIR, targetFile);
  const rfcFileClean = await isRfcFileClean(workspaceRoot, rfcRelPath);
  if (!rfcFileClean) {
    violations.push({
      rule: "RFC-IMP-04",
      message: `RFC file ${rfcRelPath} has uncommitted changes. Commit the RFC file before stamping.`,
    });
  }

  // ── RFC-IMP-03: implementation commit validation ──────────────────────────
  const reachable = await commitReachableFromHead(workspaceRoot, implementationCommit);
  if (!reachable) {
    violations.push({
      rule: "RFC-IMP-03",
      message: `Implementation commit ${implementationCommit} is not reachable from HEAD. The commit must be an ancestor of the current HEAD.`,
    });
  } else {
    const referencesRfc = await commitReferencesRfc(workspaceRoot, implementationCommit, targetId);
    if (!referencesRfc) {
      violations.push({
        rule: "RFC-IMP-03",
        message: `Implementation commit ${implementationCommit} does not reference ${targetId} in its message or changed files.`,
      });
    }
  }

  // ── RFC-IMP-06: probe-bearing RFCs require passing evidence ───────────────
  const acceptance = fm["acceptance"];
  const hasProbes = Array.isArray(acceptance) && (acceptance as unknown[]).length > 0;
  const createdAtStr = String(fm["createdAt"] ?? "");
  const requiresEvidence = createdAtStr >= RFC_METADATA_CUTOFF && hasProbes;

  let evidenceRelPath: string | undefined;

  if (requiresEvidence) {
    const evidenceCheck = await checkExistingEvidence(workspaceRoot, targetId);
    if (!evidenceCheck.exists || evidenceCheck.overall !== "pass") {
      violations.push({
        rule: "RFC-IMP-06",
        message: `RFC ${targetId} declares acceptance probes but evidence file is missing or overall is not "pass" (got "${evidenceCheck.overall}"). Run: site-kernel run rfc.verification.emit --id ${targetId}`,
      });
    } else {
      const slug = targetId.toLowerCase();
      evidenceRelPath = join(VERIFICATION_DIR, `${slug}.generated.yaml`);
    }
  }

  // If any violations found, return without mutation
  if (violations.length > 0) {
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── RFC-IMP-05: acquire RFC-specific exclusive lock ───────────────────────
  const { acquired, lockPath } = await acquireRfcLock(workspaceRoot, targetId);
  if (!acquired) {
    violations.push({
      rule: "RFC-IMP-05",
      message: `A concurrent stamp operation is in progress for ${targetId}. Wait for it to complete and retry.`,
    });
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  try {
    // ── Atomic mutation ──────────────────────────────────────────────────────
    const rfcFilePath = join(rfcDirPath, targetFile);
    const rfcSource = await readFile(rfcFilePath, "utf-8");

    const today = toIsoDate(new Date());
    const stampedAt = new Date().toISOString();
    const mutatedSource = mutateFrontmatter(rfcSource, "implemented", today, today);

    if (isDryRun) {
      if (outputFormat === "pretty") {
        logger.success(`[dry-run] ${targetId} would be stamped as implemented`);
        logger.info(`  implementation commit: ${implementationCommit}`);
        logger.info(`  criteria checked: ${criteriaEval.totalChecked}`);
        if (evidenceRelPath) {
          logger.info(`  evidence: ${evidenceRelPath}`);
        }
      }
      return {
        data: {
          command: "rfc.implement.stamp",
          status: "pass",
          data: {
            rfcId: targetId,
            implementationCommit,
            stampedAt,
            criteriaChecked: criteriaEval.totalChecked,
            ...(evidenceRelPath ? { evidencePath: evidenceRelPath } : {}),
          },
          violations: [],
        },
        exitCode: 0,
        summary: `rfc.implement.stamp: dry-run — ${targetId} would be stamped`,
      };
    }

    // Write the mutated RFC file atomically
    await writeFileAtomic(rfcFilePath, mutatedSource);

    // ── Re-emit evidence if probes exist (to update with new status) ─────────
    if (hasProbes && requiresEvidence && evidenceRelPath) {
      // Evidence already exists and passed — no need to re-emit on stamp
      // The evidence was generated before stamping; the status change is
      // recorded in the RFC frontmatter, not in the evidence file.
    }

    if (outputFormat === "pretty") {
      logger.success(`${targetId} stamped as implemented`);
      logger.info(`  implementation commit: ${implementationCommit}`);
      logger.info(`  criteria checked: ${criteriaEval.totalChecked}`);
      if (evidenceRelPath) {
        logger.info(`  evidence: ${evidenceRelPath}`);
      }
      logger.info(`  stamped at: ${stampedAt}`);
    }

    return {
      data: {
        command: "rfc.implement.stamp",
        status: "pass",
        data: {
          rfcId: targetId,
          implementationCommit,
          stampedAt,
          criteriaChecked: criteriaEval.totalChecked,
          ...(evidenceRelPath ? { evidencePath: evidenceRelPath } : {}),
        },
        violations: [],
      },
      exitCode: 0,
      summary: `rfc.implement.stamp: ${targetId} stamped as implemented`,
    };
  } finally {
    await releaseRfcLock(lockPath);
  }
}

function stampFailResult(
  violations: RfcImplementStampViolation[],
  isDryRun: boolean,
  outputFormat: string,
  logger: { warn: (msg: string) => void; info: (msg: string) => void },
): ForgeCommandResult<RfcImplementStampResult> {
  const prefix = isDryRun ? "[dry-run] " : "";
  if (outputFormat === "pretty") {
    for (const v of violations) {
      logger.warn(`${prefix}${v.rule}: ${v.message}`);
    }
  }
  return {
    data: {
      command: "rfc.implement.stamp",
      status: "fail",
      violations,
    },
    exitCode: 1,
    summary: `${prefix}rfc.implement.stamp: ${violations.length} violation(s)`,
  };
}
