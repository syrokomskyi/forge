/*
<MODULE_CONTRACT>
<purpose>
RFC-0727: adr.implement.stamp — the exclusive atomic path for
accepted/proposed → implemented ADR transitions. Validates preconditions
and atomically mutates ADR frontmatter.
</purpose>
<non-goals>
  <item>Does not transition ADRs not in accepted or proposed status.</item>
  <item>Does not add acceptance criteria or evidence checks — ADRs do not have these.</item>
  <item>Does not call the GitHub API or require network access.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0727: initial implementation — mirrors rfc.implement.stamp for ADRs.</item>
</CHANGE_SUMMARY>
*/

import { execFile } from "node:child_process";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { writeFileAtomic } from "../../../src/utils/fs-atomic.ts";

import { listAdrFiles, readAndParseAdr, adrFileMatchesId } from "../frontmatter-io.ts";
import { ADR_DIR } from "../types.ts";
import type {
  AdrStatus,
  AdrImplementStampViolation,
  AdrImplementStampResult,
} from "../types.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

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

async function isAdrFileClean(workspaceRoot: string, adrRelPath: string): Promise<boolean> {
  const status = await execGit(workspaceRoot, ["status", "--porcelain", "--", adrRelPath]);
  return status.length === 0;
}

async function commitReachableFromHead(
  workspaceRoot: string,
  commitSha: string,
): Promise<boolean> {
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

async function acquireAdrLock(
  workspaceRoot: string,
  adrId: string,
): Promise<{ acquired: boolean; lockPath: string }> {
  const lockPath = lockFilePath(workspaceRoot, adrId);
  const lockDir = dirname(lockPath);
  await mkdir(lockDir, { recursive: true });

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

async function releaseAdrLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
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

  // ── ADR-IMP-04: ADR file must be clean (no uncommitted edits to the target ADR) ──
  const adrRelPath = join(ADR_DIR, targetFile);
  const adrFileClean = await isAdrFileClean(workspaceRoot, adrRelPath);
  if (!adrFileClean) {
    violations.push({
      rule: "ADR-IMP-04",
      message: `ADR file ${adrRelPath} has uncommitted changes. Commit the ADR file before stamping.`,
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
    const referencesAdr = await commitReferencesAdr(
      workspaceRoot,
      implementationCommit,
      targetId,
    );
    if (!referencesAdr) {
      violations.push({
        rule: "ADR-IMP-03",
        message: `Implementation commit ${implementationCommit} does not reference ${targetId} in its message or changed files.`,
      });
    }
  }

  // If any violations found, return without mutation
  if (violations.length > 0) {
    return stampFailResult(violations, isDryRun, outputFormat, logger);
  }

  // ── ADR-IMP-05: acquire ADR-specific exclusive lock ───────────────────────
  const { acquired, lockPath } = await acquireAdrLock(workspaceRoot, targetId);
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
    const adrSource = await readFile(adrFilePath, "utf-8");

    const today = toIsoDate(new Date());
    const stampedAt = new Date().toISOString();
    const mutatedSource = mutateAdrFrontmatter(adrSource, "implemented", today, today);

    if (isDryRun) {
      if (outputFormat === "pretty") {
        logger.success(`[dry-run] ${targetId} would be stamped as implemented`);
        logger.info(`  implementation commit: ${implementationCommit}`);
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
        },
        violations: [],
      },
      exitCode: 0,
      summary: `adr.implement.stamp: ${targetId} stamped as implemented`,
    };
  } finally {
    await releaseAdrLock(lockPath);
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
    summary: `${prefix}adr.implement.stamp: ${violations.length} violation(s)`,
  };
}
