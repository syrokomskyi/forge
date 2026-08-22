/*
<MODULE_CONTRACT>
<purpose>
session.validate handler — checks session frontmatter schema (SES-01),
id-filename match (SES-02), RFC-id existence (SES-03), raw file hygiene
(SES-04), non-markdown file detection (SES-05), and missing checkpoint
fields in implementation/mission sessions (SES-06, RFC-0884).
</purpose>
<non-goals>
  <item>Does not move or modify files — that is session.archive.</item>
  <item>Does not check transcript content quality — that is the fo-session-save skill.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0537: implement session.validate command handler.</item>
  <item>RFC-0884: add SES-06 warning for missing checkpoint fields in implementation/mission sessions.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import {
  listSessionFiles,
  listNonMarkdownSessionFiles,
  listRawFiles,
  readAndParseSession,
} from "../frontmatter-io.ts";
import { listRfcFiles, readAndParseRfc } from "../../rfc/frontmatter-io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import {
  SESSION_DIR,
  SESSION_KNOWN_KEYS,
  SESSION_REQUIRED_KEYS,
  SESSION_TYPES,
  SES_RULES,
  type SessionValidationResult,
  type SessionValidationViolation,
} from "../types.ts";

const RFC_DIR = "docs/rfcs";

async function loadRfcIds(workspaceRoot: string): Promise<Set<string>> {
  const rfcIds = new Set<string>();
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const files = await listRfcFiles(rfcDirPath);
  for (const fileName of files) {
    const result = await readAndParseRfc(rfcDirPath, fileName);
    const id = result && "parsed" in result ? String(result.parsed.frontmatter["id"] ?? "") : "";
    if (id) rfcIds.add(id);
  }
  return rfcIds;
}

export async function runSessionValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<SessionValidationResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const sessionDirPath = path.join(workspaceRoot, SESSION_DIR);

  const targetId = input.flags["id"] as string | undefined;

  const allFiles = await listSessionFiles(sessionDirPath);
  const filesToValidate = targetId
    ? allFiles.filter((f) => path.basename(f).toLowerCase().startsWith(targetId.toLowerCase()))
    : allFiles;

  if (filesToValidate.length === 0) {
    if (outputFormat === "pretty") {
      logger.info("No session files found to validate.");
    }
    return {
      data: {
        command: "session.validate",
        status: "pass",
        violations: [],
        checked: 0,
      },
      summary: "No session files found to validate",
    };
  }

  const knownRfcIds = await loadRfcIds(workspaceRoot);
  const knownKeys = new Set<string>(SESSION_KNOWN_KEYS);
  const violations: SessionValidationViolation[] = [];

  for (const fileName of filesToValidate) {
    const result = await readAndParseSession(sessionDirPath, fileName);
    if (!result) continue;

    const fm = result.parsed.frontmatter;
    const id = String(fm["id"] ?? "");
    const relFile = path.join(SESSION_DIR, fileName);
    const basename = path.basename(fileName, ".md");

    // SES-01: Required frontmatter fields
    for (const key of SESSION_REQUIRED_KEYS) {
      if (!(key in fm) || fm[key] === undefined || fm[key] === null) {
        violations.push({
          rule: SES_RULES.SES_01,
          file: relFile,
          message: `Required field "${key}" is missing`,
          severity: "error",
        });
      }
    }

    // SES-01: Check types is a valid array
    // typesArray is also used by SES-06 below — hoisted here to make the coupling explicit.
    const typesValue = fm["types"];
    const typesArray = Array.isArray(typesValue) ? (typesValue as string[]) : [];
    if (Array.isArray(typesValue)) {
      for (const t of typesValue) {
        if (!SESSION_TYPES.includes(t as never)) {
          violations.push({
            rule: SES_RULES.SES_01,
            file: relFile,
            message: `Invalid session type "${t}". Must be one of: ${SESSION_TYPES.join(", ")}`,
            severity: "error",
          });
        }
      }
    } else if (typesValue !== undefined) {
      violations.push({
        rule: SES_RULES.SES_01,
        file: relFile,
        message: `Field "types" must be an array`,
        severity: "error",
      });
    }

    // SES-01: Warn on unknown keys
    for (const key of Object.keys(fm)) {
      if (!knownKeys.has(key)) {
        violations.push({
          rule: SES_RULES.SES_01,
          file: relFile,
          message: `Unknown frontmatter key "${key}"`,
          severity: "warning",
        });
      }
    }

    // SES-02: id matches filename
    if (id && id !== basename) {
      violations.push({
        rule: SES_RULES.SES_02,
        file: relFile,
        message: `id "${id}" does not match filename "${basename}"`,
        severity: "error",
      });
    }

    // SES-03: relatedRfcs reference existing RFCs
    const relatedRfcs = Array.isArray(fm["relatedRfcs"]) ? (fm["relatedRfcs"] as string[]) : [];
    for (const rfcId of relatedRfcs) {
      if (!knownRfcIds.has(rfcId)) {
        violations.push({
          rule: SES_RULES.SES_03,
          file: relFile,
          message: `relatedRfcs references non-existent RFC "${rfcId}"`,
          severity: "error",
        });
      }
    }

    // SES-06: Missing checkpoint fields in implementation/mission sessions
    // typesArray is extracted by SES-01 above.
    const isImplOrMission = typesArray.includes("implementation") || typesArray.includes("mission");
    if (isImplOrMission) {
      const hasCheckpointFields =
        "systemDelta" in fm ||
        "diagrams" in fm ||
        "evidence" in fm ||
        "remainingIssues" in fm ||
        "checkpoint" in fm;
      if (!hasCheckpointFields) {
        violations.push({
          rule: SES_RULES.SES_06,
          file: relFile,
          message:
            "Implementation/mission session missing checkpoint frontmatter fields (systemDelta, diagrams, evidence, remainingIssues, checkpoint). Agent should populate these during fo-session-save.",
          severity: "warning",
        });
      }
    }
  }

  // SES-04: Raw files in .raw/ that haven't been processed (warning)
  const rawFiles = await listRawFiles(sessionDirPath);
  for (const rawFile of rawFiles) {
    violations.push({
      rule: SES_RULES.SES_04,
      file: path.join(SESSION_DIR, ".raw", rawFile),
      message: `Unprocessed raw file in .raw/ — run session.save to convert`,
      severity: "warning",
    });
  }

  // SES-05: Non-markdown files in docs/sessions/ (excluding .raw/ and archive/)
  const nonMdFiles = await listNonMarkdownSessionFiles(sessionDirPath);
  for (const nonMdFile of nonMdFiles) {
    violations.push({
      rule: SES_RULES.SES_05,
      file: path.join(SESSION_DIR, nonMdFile),
      message: `Non-markdown file in docs/sessions/ — only .md files are allowed (excluding .raw/ and archive/)`,
      severity: "error",
    });
  }

  const hasErrors = violations.some((v) => v.severity === "error");
  const resultStatus = hasErrors ? "fail" : "pass";

  if (outputFormat === "pretty") {
    if (violations.length === 0) {
      logger.success(`All ${filesToValidate.length} session file(s) passed validation.`);
    } else {
      logger.section(`Session Validation (${filesToValidate.length} file(s))`);
      for (const v of violations) {
        const prefix = v.severity === "error" ? "ERROR" : "WARN";
        logger[v.severity === "error" ? "error" : "warn"](
          `[${prefix}] ${v.rule}: ${v.file}: ${v.message}`,
        );
      }
      const errorCount = violations.filter((v) => v.severity === "error").length;
      const warnCount = violations.filter((v) => v.severity === "warning").length;
      const parts: string[] = [];
      if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
      if (warnCount > 0) parts.push(`${warnCount} warning${warnCount === 1 ? "" : "s"}`);
      const counts = parts.join(", ");
      if (errorCount > 0) {
        logger.error(counts);
      } else {
        logger.warn(`${counts} — passed`);
      }
    }
  }

  return {
    data: {
      command: "session.validate",
      status: resultStatus,
      violations,
      checked: filesToValidate.length,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.filter((v) => v.severity === "error").length} error${violations.filter((v) => v.severity === "error").length === 1 ? "" : "s"} found`
      : `All ${filesToValidate.length} session file(s) passed validation`,
    nextSteps: hasErrors
      ? [
          {
            action: `Fix the ${violations.filter((v) => v.severity === "error").length} error${violations.filter((v) => v.severity === "error").length === 1 ? "" : "s"} above, then re-run: pnpm exec forge run session.validate`,
            kind: "required",
          },
        ]
      : undefined,
  };
}
