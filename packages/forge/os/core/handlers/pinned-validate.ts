/*
<MODULE_CONTRACT>
<purpose>forge pinned.validate — checks the working tree against .forge/pinned.yaml.
Scans git diff (staged or last-commit) for delete/move/modify operations on
pinned files. Supports --allow-pinned-override for audited escape hatch,
--json for structured output, and --mode ci for CI integration.</purpose>
<non-goals>
  <item>Does not create or modify the manifest — use pinned.init.</item>
  <item>Does not install hooks or CI workflows — use pinned.init.</item>
  <item>Does not block archive commands — that is the pre-check utility in pinned-check.ts.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0733: initial pinned.validate handler with staged/ci modes, override, audit log, manifest integrity check.</item>
  <item>Gap fix: read FORGE_PINNED_OVERRIDE env var for pre-commit hook override support.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  loadPinnedManifest,
  isPinned,
  PINNED_MANIFEST_PATH,
  PinnedManifestMalformedError,
} from "./pinned-check.ts";
import type {
  PinnedManifest,
  PinnedValidateMode,
  PinnedValidateResult,
  PinnedViolation,
} from "./pinned-types.ts";

const execAsync = promisify(exec);
const AUDIT_LOG_PATH = path.join(".forge", "pinned-audit.log");

/**
 * Parse git diff --name-status output into file entries with operation types.
 * Git status codes:
 *   D = deleted, R = renamed (move), M = modified, A = added, C = copied
 * Format: "R100\tdocs/old.md\tdocs/new.md" or "D\tdocs/file.md"
 */
function parseGitNameStatus(
  output: string,
): Array<{ relPath: string; operation: PinnedViolation["operation"] }> {
  const entries: Array<{ relPath: string; operation: PinnedViolation["operation"] }> = [];
  const lines = output.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    const statusCode = parts[0] ?? "";
    const oldPath = parts[1] ?? "";
    const newPath = parts[2] ?? oldPath;

    if (statusCode.startsWith("D")) {
      entries.push({ relPath: oldPath, operation: "delete" });
    } else if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      entries.push({ relPath: oldPath, operation: "move" });
      if (newPath !== oldPath) {
        entries.push({ relPath: newPath, operation: "move" });
      }
    } else if (statusCode.startsWith("M")) {
      entries.push({ relPath: oldPath, operation: "modify" });
    }
  }

  return entries;
}

/**
 * Check manifest integrity by comparing current manifest against the last-committed version.
 * If entries have been removed, return a tampered violation.
 */
async function checkManifestIntegrity(
  repoRoot: string,
  manifest: PinnedManifest,
): Promise<PinnedViolation | null> {
  try {
    const { stdout } = await execAsync(`git show HEAD:${PINNED_MANIFEST_PATH}`, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    // Parse the committed manifest to compare entry paths
    const { parse: parseYaml } = await import("yaml");
    const committedParsed = parseYaml(stdout) as Record<string, unknown> | null;
    if (!committedParsed || !Array.isArray(committedParsed["pinned"])) {
      return null;
    }
    const committedEntries = (committedParsed["pinned"] as Array<Record<string, unknown>>).map(
      (e) => String(e["path"] ?? ""),
    );
    const currentPaths = new Set(manifest.pinned.map((e) => e.path));

    for (const committedPath of committedEntries) {
      if (!currentPaths.has(committedPath)) {
        return {
          path: PINNED_MANIFEST_PATH,
          mode: "freeze",
          operation: "modify",
          reason: `PINNED_MANIFEST_TAMPERED: entry "${committedPath}" was removed from the manifest`,
        };
      }
    }
  } catch {
    // No committed manifest — nothing to compare against. This is normal for new repos.
  }

  return null;
}

/**
 * Append an override event to the audit log. Uses fs.appendFile for atomic per-line writes.
 */
async function appendAuditLog(
  repoRoot: string,
  entry: {
    timestamp: string;
    path: string;
    mode: string;
    reason: string;
  },
): Promise<void> {
  const logPath = path.join(repoRoot, AUDIT_LOG_PATH);
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(logPath, line, "utf8");
}

export async function runPinnedValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<PinnedValidateResult>> {
  const { workspaceRoot, logger, outputFormat } = context;

  const mode: PinnedValidateMode =
    (input.flags["mode"] as PinnedValidateMode | undefined) ?? "staged";
  const json = input.flags["json"] === true || outputFormat === "json";
  const flagRaw = input.flags["allow-pinned-override"];
  const flagOverrides: string[] = flagRaw
    ? Array.isArray(flagRaw)
      ? (flagRaw as string[])
      : [flagRaw as string]
    : [];

  // Gap fix: also read FORGE_PINNED_OVERRIDE env var (comma-separated paths).
  // This allows the pre-commit hook to support overrides without changing the hook script.
  // Operator sets: FORGE_PINNED_OVERRIDE=docs/rfcs/rfc-0076.md git commit
  const envOverride = process.env["FORGE_PINNED_OVERRIDE"];
  const envOverrides: string[] = envOverride
    ? envOverride
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const overrides: string[] = [...flagOverrides, ...envOverrides];

  // Load manifest
  let manifest: PinnedManifest | null;
  try {
    manifest = await loadPinnedManifest(workspaceRoot);
  } catch (err) {
    if (err instanceof PinnedManifestMalformedError) {
      return {
        data: {
          command: "pinned.validate",
          status: "fail",
          violations: [],
          overrides: [],
        },
        exitCode: 2,
        summary: `Error: ${err.message}`,
      };
    }
    throw err;
  }

  if (!manifest) {
    const msg = "No .forge/pinned.yaml found — pinned-files protection inactive.";
    if (!json) {
      logger.info(msg);
    }
    return {
      data: {
        command: "pinned.validate",
        status: "pass",
        violations: [],
        overrides: [],
      },
      summary: msg,
    };
  }

  // Get git diff
  let diffOutput: string;
  try {
    if (mode === "ci") {
      const { stdout } = await execAsync("git diff --name-status HEAD~1 HEAD", {
        cwd: workspaceRoot,
        encoding: "utf8",
      });
      diffOutput = stdout;
    } else {
      const { stdout } = await execAsync("git diff --cached --name-status", {
        cwd: workspaceRoot,
        encoding: "utf8",
      });
      diffOutput = stdout;
    }
  } catch {
    diffOutput = "";
  }

  const changedFiles = parseGitNameStatus(diffOutput);

  // Check each changed file against the manifest
  const allViolations: PinnedViolation[] = [];
  for (const { relPath, operation } of changedFiles) {
    const entry = isPinned(manifest, relPath);
    if (entry) {
      // For protect mode, only delete and move are violations — modify is allowed
      if (entry.mode === "protect" && operation === "modify") {
        continue;
      }
      allViolations.push({
        path: relPath,
        mode: entry.mode,
        operation,
        reason: entry.reason,
      });
    }
  }

  // Check manifest integrity (tamper detection)
  const tamperViolation = await checkManifestIntegrity(workspaceRoot, manifest);
  if (tamperViolation) {
    allViolations.push(tamperViolation);
  }

  // Filter out overridden violations
  const overrideSet = new Set(overrides);
  const remainingViolations: PinnedViolation[] = [];
  const appliedOverrides: string[] = [];

  for (const v of allViolations) {
    if (overrideSet.has(v.path)) {
      appliedOverrides.push(v.path);
      // Log to audit file
      await appendAuditLog(workspaceRoot, {
        timestamp: new Date().toISOString(),
        path: v.path,
        mode: v.mode,
        reason: v.reason,
      });
    } else {
      remainingViolations.push(v);
    }
  }

  const status: "pass" | "fail" = remainingViolations.length > 0 ? "fail" : "pass";
  const result: PinnedValidateResult = {
    command: "pinned.validate",
    status,
    violations: remainingViolations,
    overrides: appliedOverrides,
  };

  if (!json) {
    if (status === "pass") {
      if (appliedOverrides.length > 0) {
        logger.success(
          `pinned.validate: passed with ${appliedOverrides.length} override(s) (logged to audit)`,
        );
      } else {
        logger.success("pinned.validate: no violations");
      }
    } else {
      logger.error(`pinned.validate: ${remainingViolations.length} violation(s) found`);
      for (const v of remainingViolations) {
        logger.error(`  ${v.operation}: ${v.path} (mode: ${v.mode}) — ${v.reason}`);
      }
    }
  }

  return {
    data: result,
    exitCode: status === "pass" ? 0 : 1,
    summary:
      status === "pass"
        ? `No violations${appliedOverrides.length > 0 ? ` (${appliedOverrides.length} override(s) applied)` : ""}`
        : `${remainingViolations.length} violation(s) found`,
  };
}
