/*
<MODULE_CONTRACT>
<purpose>RFC validation handler — V-01..V-22 frontmatter, section, and referential integrity checks.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: extracted validate handler from handlers.ts into handlers/validate.ts.</item>
  <item>Post-refactor hardening: targeted validation resolves RFC ids inside archive subdirectories.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";

import {
  listRfcFiles,
  readAndParseRfc,
  rfcFileMatchesId,
  type ParsedRfc,
} from "../frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import type { RfcValidationViolation, RfcValidationResult } from "../types.ts";
import { RFC_DIR, RFC_KNOWN_KEYS } from "../types.ts";
import { DNA_DOCS, AP_DOCS, loadInvariantIds } from "./shared.ts";
import { collectRfcCommandLifecycleViolations } from "./lifecycle.ts";
import { validateSingleRfc } from "./validate-rules.ts";

export async function runRfcValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcValidationResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);

  const targetId = input.args[0] as string | undefined;

  const allFiles = await listRfcFiles(rfcDirPath);
  const filesToValidate = targetId
    ? allFiles.filter((f) => rfcFileMatchesId(f, targetId))
    : allFiles;

  if (filesToValidate.length === 0) {
    if (targetId) {
      throw new Error(`No RFC file found for id ${targetId} in ${RFC_DIR}/`);
    }
    logger.info("No RFC files found to validate.");
    return {
      data: { command: "rfc.validate", status: "pass", count: 0, violations: [] },
      summary: "No RFC files found to validate",
    };
  }

  const allParsed: Map<string, { fileName: string; parsed: ParsedRfc }> = new Map();
  const allParsedByFile: Map<string, { fileName: string; parsed: ParsedRfc }> = new Map();
  for (const f of allFiles) {
    const result = await readAndParseRfc(rfcDirPath, f);
    if (result) {
      const id = String(result.parsed.frontmatter["id"] ?? "");
      allParsed.set(id, result);
      allParsedByFile.set(f, result);
    }
  }

  const validDnaIds = await loadInvariantIds(workspaceRoot, DNA_DOCS, "DNA");
  const validApIds = await loadInvariantIds(workspaceRoot, AP_DOCS, "AP");
  const knownKeys = new Set<string>(RFC_KNOWN_KEYS);

  const violations: RfcValidationViolation[] = [];

  function addViolation(
    rfcId: string,
    file: string,
    rule: string,
    message: string,
    severity: "error" | "warning" = "error",
  ): void {
    violations.push({ rfcId, file, rule, message, severity });
  }

  const seenIds = new Map<string, string>();
  const seenFilenameNumbers = new Map<number, string>();

  for (const fileName of filesToValidate) {
    const result = allParsedByFile.get(fileName);
    if (!result) continue;

    await validateSingleRfc(
      fileName,
      result.parsed,
      allParsed,
      seenIds,
      validDnaIds,
      validApIds,
      knownKeys,
      workspaceRoot,
      addViolation,
      seenFilenameNumbers,
    );
  }

  const lifecycle = await collectRfcCommandLifecycleViolations(
    workspaceRoot,
    filesToValidate,
    allParsedByFile,
    context.commandRegistry,
  );
  for (const violation of lifecycle.violations) {
    addViolation(
      violation.rfcId,
      violation.file,
      violation.rule,
      violation.message,
      violation.severity,
    );
  }

  const hasErrors = violations.some((v) => v.severity === "error");
  const resultStatus = hasErrors ? "fail" : "pass";

  if (outputFormat === "pretty") {
    if (violations.length === 0) {
      logger.success(`All ${filesToValidate.length} RFC(s) passed validation.`);
    } else {
      logger.section(`RFC Validation (${filesToValidate.length} file(s))`);
      for (const v of violations) {
        const prefix = v.severity === "error" ? "ERROR" : "WARN";
        logger[v.severity === "error" ? "error" : "warn"](
          `[${prefix}] ${v.rfcId} ${v.rule}: ${v.message}`,
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
      command: "rfc.validate",
      status: resultStatus,
      count: filesToValidate.length,
      violations,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.filter((v) => v.severity === "error").length} error(s) found`
      : `All ${filesToValidate.length} RFC(s) passed validation`,
  };
}
