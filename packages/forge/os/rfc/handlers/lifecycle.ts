/*
<MODULE_CONTRACT>
<purpose>RFC command lifecycle validation — collects and reports RFC-CMD-* violations.</purpose>
<non-goals>
  <item>Do not introduce app-specific runtime composition or deployment behavior into this reusable package source file.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0303: extracted lifecycle logic from handlers.ts into handlers/lifecycle.ts.</item>
  <item>Post-refactor hardening: targeted lifecycle validation resolves RFC ids inside archive subdirectories.</item>
  <item>RFC-0465: added RFC_METADATA_CUTOFF check to RFC-CMD-02 and RFC-CMD-03 rules — pre-cutoff RFCs are exempt from command registration checks.</item>
  <item>RFC-0465 fix: added manifest-based fallback in getLiveCommands — reads docs/command-manifest.generated.yaml when commandRegistry returns empty (site-kernel mode).</item>
</CHANGE_SUMMARY>
*/

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as yamlParse } from "yaml";

import type { CommandRegistry } from "../../../src/types.ts";
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
import type {
  RfcStatus,
  RfcCommandLifecycleViolation,
  RfcCommandLifecycleValidationResult,
} from "../types.ts";
import { RFC_DIR, RFC_METADATA_CUTOFF } from "../types.ts";
import { commandBuckets } from "./shared.ts";

async function loadManifestCommandNames(workspaceRoot: string): Promise<Set<string>> {
  const manifestPath = path.join(workspaceRoot, "docs", "command-manifest.generated.yaml");
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const manifest = yamlParse(raw) as { commands?: Array<{ name: string }> };
    return new Set((manifest.commands ?? []).map((c) => c.name));
  } catch {
    return new Set();
  }
}

export async function collectRfcCommandLifecycleViolations(
  workspaceRoot: string,
  filesToValidate?: string[],
  preParsed?: Map<string, { fileName: string; parsed: ParsedRfc }>,
  commandRegistry?: CommandRegistry,
): Promise<{ checkedCount: number; violations: RfcCommandLifecycleViolation[] }> {
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const files = filesToValidate ?? (await listRfcFiles(rfcDirPath));

  let liveCommandsPromise: Promise<Set<string>> | undefined;
  async function getLiveCommands(): Promise<Set<string>> {
    if (!liveCommandsPromise) {
      const cmds = commandRegistry?.listCommands() ?? [];
      let names = new Set(cmds.map((c) => c.name));
      if (names.size === 0) {
        names = await loadManifestCommandNames(workspaceRoot);
      }
      liveCommandsPromise = Promise.resolve(names);
    }
    return liveCommandsPromise;
  }

  const violations: RfcCommandLifecycleViolation[] = [];

  const addViolation = (
    rfcId: string,
    file: string,
    rule: RfcCommandLifecycleViolation["rule"],
    message: string,
    severity: "error" | "warning",
    data: RfcCommandLifecycleViolation["data"],
  ): void => {
    violations.push({ rfcId, file, rule, message, severity, data });
  };

  let checkedCount = 0;
  for (const fileName of files) {
    const result = preParsed?.get(fileName) ?? (await readAndParseRfc(rfcDirPath, fileName));
    if (!result) continue;

    checkedCount += 1;
    const fm = result.parsed.frontmatter;
    const rfcId = String(fm["id"] ?? "UNKNOWN");
    const status = String(fm["status"] ?? "") as RfcStatus;
    const relFile = path.join(RFC_DIR, fileName);
    const buckets = commandBuckets(fm);
    const removed = new Set(buckets.removed);
    const createdAt = String(fm["createdAt"] ?? "");
    const isPostCutoff = createdAt >= RFC_METADATA_CUTOFF;

    for (const command of buckets.proposed) {
      if (
        status === "implemented" &&
        (await getLiveCommands()).has(command) &&
        !buckets.added.includes(command)
      ) {
        addViolation(
          rfcId,
          relFile,
          "RFC-CMD-01",
          `implemented RFC lists live command "${command}" under commands.proposed but not commands.added`,
          "error",
          { rfcId, command, status, bucket: "proposed" },
        );
      }
    }

    for (const command of buckets.added) {
      if (
        isPostCutoff &&
        status === "implemented" &&
        !(await getLiveCommands()).has(command) &&
        !removed.has(command)
      ) {
        addViolation(
          rfcId,
          relFile,
          "RFC-CMD-02",
          `implemented RFC lists "${command}" under commands.added, but no live command is registered`,
          "error",
          { rfcId, command, status, bucket: "added" },
        );
      }
      if ((status === "draft" || status === "reviewing") && !result.parsed.body.includes(command)) {
        addViolation(
          rfcId,
          relFile,
          "RFC-CMD-04",
          `non-accepted RFC lists "${command}" under commands.added without body rationale`,
          "warning",
          { rfcId, command, status, bucket: "added" },
        );
      }
    }

    for (const command of buckets.changed) {
      if (
        isPostCutoff &&
        status === "implemented" &&
        !(await getLiveCommands()).has(command) &&
        !removed.has(command)
      ) {
        addViolation(
          rfcId,
          relFile,
          "RFC-CMD-03",
          `implemented RFC lists "${command}" under commands.changed, but no live command is registered`,
          "error",
          { rfcId, command, status, bucket: "changed" },
        );
      }
    }

    for (const command of new Set([...buckets.added, ...buckets.changed])) {
      if (removed.has(command)) continue;
      const bucketCount =
        Number(buckets.added.includes(command)) + Number(buckets.changed.includes(command));
      if (bucketCount > 1) {
        addViolation(
          rfcId,
          relFile,
          "RFC-CMD-05",
          `command "${command}" appears in conflicting lifecycle buckets without commands.removed transition`,
          "warning",
          { rfcId, command, status, bucket: buckets.added.includes(command) ? "added" : "changed" },
        );
      }
    }
  }

  return { checkedCount, violations };
}

export async function runRfcCommandLifecycleValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<RfcCommandLifecycleValidationResult>> {
  const { workspaceRoot, logger, outputFormat } = context;
  const rfcDirPath = path.join(workspaceRoot, RFC_DIR);
  const targetId = input.flags["id"] as string | undefined;
  const allFiles = await listRfcFiles(rfcDirPath);
  const filesToValidate = targetId
    ? allFiles.filter((f) => rfcFileMatchesId(f, targetId))
    : allFiles;

  if (filesToValidate.length === 0) {
    if (targetId) {
      throw new Error(`No RFC file found for id ${targetId} in ${RFC_DIR}/`);
    }
    return {
      data: {
        command: "rfc.command-lifecycle.validate",
        status: "pass",
        count: 0,
        violations: [],
      },
      summary: "No RFC files found to validate",
    };
  }

  const { checkedCount, violations } = await collectRfcCommandLifecycleViolations(
    workspaceRoot,
    filesToValidate,
    undefined,
    context.commandRegistry,
  );
  const hasErrors = violations.some((v) => v.severity === "error");

  if (outputFormat === "pretty") {
    if (violations.length === 0) {
      logger.success(`All ${checkedCount} RFC(s) passed command lifecycle validation.`);
    } else {
      logger.section(`RFC Command Lifecycle Validation (${checkedCount} file(s))`);
      for (const v of violations) {
        logger[v.severity === "error" ? "error" : "warn"](
          `[${v.severity === "error" ? "ERROR" : "WARN"}] ${v.rfcId} ${v.rule}: ${v.message}`,
        );
      }
    }
  }

  return {
    data: {
      command: "rfc.command-lifecycle.validate",
      status: hasErrors ? "fail" : "pass",
      count: checkedCount,
      violations,
    },
    exitCode: hasErrors ? 1 : 0,
    summary: hasErrors
      ? `${violations.filter((v) => v.severity === "error").length} command lifecycle error(s) found`
      : `All ${checkedCount} RFC(s) passed command lifecycle validation`,
  };
}
