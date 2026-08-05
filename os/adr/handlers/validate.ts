/*
<MODULE_CONTRACT>
<purpose>ADR validation handler — frontmatter, section, referential integrity checks, and implementation commit drift detection (AV-16).</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0366: implement fail-hard ADR validation for the new adrModule.</item>
  <item>Post-refactor hardening: allow ADRs to be superseded by existing RFC decisions.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { execFile } from "node:child_process";
import {
  listAdrFiles,
  readAndParseAdr,
  adrFileMatchesId,
  type ParsedAdr,
} from "../frontmatter-io.ts";
import { listRfcFiles, readAndParseRfc } from "../../rfc/frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type { AdrValidationViolation, AdrValidationResult, AdrStatus, AdrScope } from "../types.ts";
import {
  ADR_DIR,
  ADR_ID_PATTERN,
  ADR_KNOWN_KEYS,
  ADR_REQUIRED_SECTIONS,
  ADR_SCOPES,
  ADR_STATUSES,
} from "../types.ts";
import { RFC_DIR } from "../../rfc/types.ts";

async function loadRfcIds(workspaceRoot: string): Promise<Set<string>> {
  const rfcIds = new Set<string>();
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const files = await listRfcFiles(rfcDirPath);
  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    const id = String(result?.parsed.frontmatter["id"] ?? "");
    if (id) rfcIds.add(id);
  }
  return rfcIds;
}

export async function runAdrValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<AdrValidationResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const adrDirPath = path.join(workspaceRoot, ADR_DIR);

  const targetId = input.flags["id"] as string | undefined;

  const allFiles = await listAdrFiles(adrDirPath);
  const filesToValidate = targetId
    ? allFiles.filter((f) => adrFileMatchesId(f, targetId))
    : allFiles;

  if (filesToValidate.length === 0) {
    if (targetId) {
      throw new Error(`No ADR file found for id ${targetId} in ${ADR_DIR}/`);
    }
    if (outputFormat === "pretty") {
      logger.info("No ADR files found to validate.");
    }
    return {
      data: { command: "adr.validate", status: "pass", count: 0, violations: [] },
      summary: "No ADR files found to validate",
    };
  }

  const allParsed: Map<string, { fileName: string; parsed: ParsedAdr }> = new Map();
  const allParsedByFile: Map<string, { fileName: string; parsed: ParsedAdr }> = new Map();
  for (const f of allFiles) {
    const result = await readAndParseAdr(adrDirPath, f);
    if (result) {
      const id = String(result.parsed.frontmatter["id"] ?? "");
      allParsed.set(id, result);
      allParsedByFile.set(f, result);
    }
  }

  const knownKeys = new Set<string>(ADR_KNOWN_KEYS);
  const knownRfcIds = await loadRfcIds(workspaceRoot);
  const violations: AdrValidationViolation[] = [];
  const seenIds = new Map<string, string>();

  function addViolation(
    adrId: string,
    file: string,
    rule: string,
    message: string,
    severity: "error" | "warning" = "error",
  ): void {
    violations.push({ adrId, file, rule, message, severity });
  }

  for (const fileName of filesToValidate) {
    const result = allParsedByFile.get(fileName);
    if (!result) continue;

    await validateSingleAdr(
      fileName,
      result.parsed,
      allParsed,
      knownRfcIds,
      seenIds,
      knownKeys,
      workspaceRoot,
      addViolation,
    );
  }

  const hasErrors = violations.some((v) => v.severity === "error");
  const resultStatus = hasErrors ? "fail" : "pass";

  if (outputFormat === "pretty") {
    if (violations.length === 0) {
      logger.success(`All ${filesToValidate.length} ADR(s) passed validation.`);
    } else {
      logger.section(`ADR Validation (${filesToValidate.length} file(s))`);
      for (const v of violations) {
        const prefix = v.severity === "error" ? "ERROR" : "WARN";
        logger[v.severity === "error" ? "error" : "warn"](
          `[${prefix}] ${v.adrId} ${v.rule}: ${v.message}`,
        );
      }
      const errorCount = violations.filter((v) => v.severity === "error").length;
      const warnCount = violations.filter((v) => v.severity === "warning").length;
      if (errorCount > 0) {
        logger.error(`${errorCount} error(s), ${warnCount} warning(s)`);
      } else {
        logger.warn(`${warnCount} warning(s), 0 errors — passed`);
      }
    }
  }

  return {
    data: {
      command: "adr.validate",
      status: resultStatus,
      count: filesToValidate.length,
      violations,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.filter((v) => v.severity === "error").length} error(s) found`
      : `All ${filesToValidate.length} ADR(s) passed validation`,
  };
}

async function validateSingleAdr(
  fileName: string,
  parsed: ParsedAdr,
  allParsed: Map<string, { fileName: string; parsed: ParsedAdr }>,
  knownRfcIds: Set<string>,
  seenIds: Map<string, string>,
  knownKeys: Set<string>,
  workspaceRoot: string,
  addViolation: (
    adrId: string,
    file: string,
    rule: string,
    message: string,
    severity?: "error" | "warning",
  ) => void,
): Promise<void> {
  const fm = parsed.frontmatter;
  const body = parsed.body;
  const relFile = path.join(ADR_DIR, fileName);
  const adrId = String(fm["id"] ?? "UNKNOWN");

  if (!ADR_ID_PATTERN.test(adrId)) {
    addViolation(adrId, relFile, "AV-01", `id "${adrId}" does not match format ADR-XXXX`);
  }

  const prevFile = seenIds.get(adrId);
  if (prevFile) {
    addViolation(adrId, relFile, "AV-02", `Duplicate id "${adrId}" — also in ${prevFile}`);
  } else {
    seenIds.set(adrId, relFile);
  }

  const status = String(fm["status"] ?? "");
  if (!ADR_STATUSES.includes(status as AdrStatus)) {
    addViolation(
      adrId,
      relFile,
      "AV-03",
      `Invalid status "${status}". Must be one of: ${ADR_STATUSES.join(", ")}`,
    );
  }

  const scope = String(fm["scope"] ?? "");
  if (!ADR_SCOPES.includes(scope as AdrScope)) {
    addViolation(
      adrId,
      relFile,
      "AV-04",
      `Invalid scope "${scope}". Must be one of: ${ADR_SCOPES.join(", ")}`,
    );
  }

  const decider = String(fm["decider"] ?? "");
  if (!decider) {
    addViolation(adrId, relFile, "AV-05", "decider must be a non-empty string");
  }

  const createdAt = String(fm["createdAt"] ?? "");
  const updatedAt = String(fm["updatedAt"] ?? "");
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(createdAt)) {
    addViolation(
      adrId,
      relFile,
      "AV-06",
      `createdAt "${createdAt}" is not a valid ISO 8601 date (YYYY-MM-DD)`,
    );
  }
  if (!datePattern.test(updatedAt)) {
    addViolation(
      adrId,
      relFile,
      "AV-06",
      `updatedAt "${updatedAt}" is not a valid ISO 8601 date (YYYY-MM-DD)`,
    );
  }

  const supersedes = fm["supersedes"];
  if (Array.isArray(supersedes)) {
    for (const ref of supersedes) {
      const refStr = String(ref);
      if (!refStr) continue;
      if (!allParsed.has(refStr)) {
        addViolation(
          adrId,
          relFile,
          "AV-07",
          `supersedes "${refStr}" does not match any existing ADR`,
        );
      } else {
        const otherBy = String(allParsed.get(refStr)!.parsed.frontmatter["supersededBy"] ?? "");
        if (otherBy !== adrId) {
          addViolation(
            adrId,
            relFile,
            "AV-08",
            `${adrId}.supersedes includes ${refStr}, but ${refStr}.supersededBy is "${otherBy || "(empty)"}" (expected ${adrId})`,
            "warning",
          );
        }
      }
    }
  }

  const supersededBy = fm["supersededBy"] as string | undefined;
  if (supersededBy && /^ADR-\d{4}$/.test(supersededBy) && !allParsed.has(supersededBy)) {
    addViolation(
      adrId,
      relFile,
      "AV-09",
      `supersededBy "${supersededBy}" does not match any existing ADR`,
    );
  } else if (supersededBy && /^RFC-\d{4}$/.test(supersededBy) && !knownRfcIds.has(supersededBy)) {
    addViolation(
      adrId,
      relFile,
      "AV-09",
      `supersededBy "${supersededBy}" does not match any existing RFC`,
    );
  } else if (supersededBy && !/^(ADR|RFC)-\d{4}$/.test(supersededBy)) {
    addViolation(
      adrId,
      relFile,
      "AV-09",
      `supersededBy "${supersededBy}" is not a recognized ADR/RFC id`,
    );
  }

  if (status === "superseded" && !supersededBy) {
    addViolation(adrId, relFile, "AV-10", `status is "superseded" but supersededBy is empty`);
  }

  const related = fm["related"];
  if (Array.isArray(related)) {
    for (const ref of related) {
      const refStr = String(ref).trim();
      if (!refStr) continue;
      if (/^ADR-\d{4}$/.test(refStr)) {
        if (!allParsed.has(refStr)) {
          addViolation(
            adrId,
            relFile,
            "AV-11",
            `related "${refStr}" does not match any existing ADR`,
            "warning",
          );
        }
      } else if (!/^(RFC|DNA|AP)-\d+$/.test(refStr)) {
        addViolation(
          adrId,
          relFile,
          "AV-11",
          `related "${refStr}" is not a recognized RFC/ADR/DNA/AP reference`,
          "warning",
        );
      }
    }
  }

  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  for (const section of ADR_REQUIRED_SECTIONS) {
    if (!headings.includes(section)) {
      addViolation(adrId, relFile, "AV-12", `Missing required section "## ${section}"`);
    }
  }

  const titleStr = String(fm["title"] ?? "");
  const headingMatch = body.match(/^#\s+(?:ADR-\d{4}:\s*)?(.+)$/m);
  if (headingMatch && titleStr) {
    const headingTitle = headingMatch[1]!.trim();
    if (headingTitle !== titleStr) {
      addViolation(
        adrId,
        relFile,
        "AV-13",
        `Frontmatter title "${titleStr}" does not match body heading "${headingTitle}"`,
        "warning",
      );
    }
  }

  const lowerAdrId = adrId.toLowerCase();
  const fileBasename = fileName.split("/").pop()!.split("\\").pop()!;
  if (!fileBasename.startsWith(lowerAdrId)) {
    addViolation(
      adrId,
      relFile,
      "AV-14",
      `Filename "${fileBasename}" must start with lowercase "${lowerAdrId}"`,
    );
  } else if (!/^[a-z0-9-]+\.md$/.test(fileBasename)) {
    addViolation(
      adrId,
      relFile,
      "AV-14",
      `Filename "${fileName}" is not lowercase kebab-case (only a-z, 0-9, hyphens allowed)`,
    );
  }

  for (const key of Object.keys(fm)) {
    if (!knownKeys.has(key)) {
      addViolation(
        adrId,
        relFile,
        "AV-15",
        `unknown frontmatter key "${key}" (not in the ADR schema)`,
        "warning",
      );
    }
  }

  // AV-16: implementation commit drift detection (RFC-0625)
  // Warns when implement: ADR-XXXX commits exist in git history since createdAt
  // but the ADR status is not yet "implemented".
  if (status !== "implemented") {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (datePattern.test(createdAt)) {
      const log = await execGitLog(workspaceRoot, ["log", `--since=${createdAt}`, "--oneline"]);
      if (log) {
        const pattern = new RegExp(`implement:\\s+${adrId}\\b`, "i");
        const matchingLines = log.split("\n").filter((line) => pattern.test(line.trim()));
        if (matchingLines.length > 0) {
          addViolation(
            adrId,
            relFile,
            "AV-16",
            `${adrId} has ${matchingLines.length} implement: commit(s) in git history since ${createdAt} but status is still "${status}". Set status: implemented and implementedAt to complete.`,
            "warning",
          );
        }
      }
    }
  }
}

function execGitLog(workspaceRoot: string, args: string[]): Promise<string> {
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
