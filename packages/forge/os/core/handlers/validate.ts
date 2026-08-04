/*
<MODULE_CONTRACT>
<purpose>forge.validate — execute validate commands for all artifacts declared in the active stack profile. Supports --dry-run, --json, --artifact filtering, and violation parsing.</purpose>
<non-goals>
  <item>Do not implement dev or build logic — those are separate handlers.</item>
  <item>Do not import from @warpgogol/* — this module is portable.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0674: initial forge.validate handler with profile resolution, --dry-run, and per-artifact execution.</item>
  <item>RFC-0677: extended with --artifact filtering, violation parsing (outputFormat: json/plain), passed/allPassed fields.</item>
</CHANGE_SUMMARY>
*/

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";
import { resolveActiveProfile, resolveLifecycleFlags } from "./profile-resolve.ts";

const execAsync = promisify(exec);

export interface ValidateViolation {
  file: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
}

export interface ForgeValidateArtifactResult {
  id: string;
  command: string;
  exitCode: number;
  passed: boolean;
  violations: ValidateViolation[];
  stdout: string;
  stderr: string;
}

export interface ForgeValidateResult {
  command: "forge.validate";
  profileId: string;
  artifacts: ForgeValidateArtifactResult[];
  allPassed: boolean;
}

function parseViolations(
  output: string,
  outputFormat: "plain" | "json" | undefined,
  violationPattern: string | undefined,
): ValidateViolation[] {
  if (outputFormat === "json") {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
          .map((v) => ({
            file: String(v["file"] ?? ""),
            line: typeof v["line"] === "number" ? v["line"] : undefined,
            column: typeof v["column"] === "number" ? v["column"] : undefined,
            severity: (v["severity"] === "warning" ? "warning" : "error") as "error" | "warning",
            message: String(v["message"] ?? ""),
          }))
          .filter((v) => v.file || v.message);
      }
      return [];
    } catch {
      return [];
    }
  }

  if (outputFormat === "plain" && violationPattern) {
    try {
      const regex = new RegExp(violationPattern, "g");
      const violations: ValidateViolation[] = [];
      let match: RegExpExecArray | null;
      while ((match = regex.exec(output)) !== null) {
        const groups = match.groups ?? {};
        violations.push({
          file: String(groups["file"] ?? ""),
          line: groups["line"] ? Number(groups["line"]) : undefined,
          column: groups["column"] ? Number(groups["column"]) : undefined,
          severity: (groups["severity"] === "warning" ? "warning" : "error") as "error" | "warning",
          message: String(groups["message"] ?? match[0]),
        });
        if (regex.lastIndex === match.index) regex.lastIndex++;
      }
      return violations;
    } catch {
      return [];
    }
  }

  return [];
}

export async function runValidate(
  input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<ForgeValidateResult>> {
  const { workspaceRoot, logger } = context;
  const { dryRun, profileIdOverride } = resolveLifecycleFlags(input, context);
  const artifactFilter =
    typeof input.flags["artifact"] === "string" ? (input.flags["artifact"] as string) : undefined;

  const resolved = resolveActiveProfile(workspaceRoot, context.forgeRoot, profileIdOverride);
  if (!resolved) {
    return {
      data: {
        command: "forge.validate",
        profileId: "",
        artifacts: [],
        allPassed: false,
      },
      exitCode: 1,
      summary: "No active profile found. Set `profile` in forge.yaml or use --profile <id>.",
      nextSteps: [{ action: "Set profile in forge.yaml or use --profile <id>", kind: "required" }],
    };
  }

  const { profile } = resolved;

  if (!profile.artifacts || profile.artifacts.length === 0) {
    return {
      data: {
        command: "forge.validate",
        profileId: profile.id,
        artifacts: [],
        allPassed: false,
      },
      exitCode: 1,
      summary: `Profile ${profile.id} does not declare any artifacts.`,
      nextSteps: [{ action: `Add artifacts section to profile ${profile.id}`, kind: "required" }],
    };
  }

  if (artifactFilter) {
    const found = profile.artifacts.find((a) => a.id === artifactFilter);
    if (!found) {
      return {
        data: {
          command: "forge.validate",
          profileId: profile.id,
          artifacts: [],
          allPassed: false,
        },
        exitCode: 1,
        summary: `Artifact ${artifactFilter} not declared in profile ${profile.id}.`,
        nextSteps: [{ action: `Check artifacts in profile ${profile.id}`, kind: "required" }],
      };
    }
  }

  const artifactsToValidate = artifactFilter
    ? profile.artifacts.filter((a) => a.id === artifactFilter)
    : profile.artifacts;

  if (dryRun) {
    const commands = artifactsToValidate
      .filter((a) => a.validate)
      .map((a) => ({ artifactId: a.id, command: a.validate!.command }));
    logger.info(`[dry-run] forge.validate — profile: ${profile.id}`);
    for (const cmd of commands) {
      logger.info(`  ${cmd.artifactId}: ${cmd.command}`);
    }
    return {
      data: {
        command: "forge.validate",
        profileId: profile.id,
        artifacts: commands.map((c) => ({
          id: c.artifactId,
          command: c.command,
          exitCode: 0,
          passed: true,
          violations: [],
          stdout: "",
          stderr: "",
        })),
        allPassed: true,
      },
      summary: `[dry-run] ${commands.length} validate command(s) resolved`,
    };
  }

  const results: ForgeValidateArtifactResult[] = [];

  for (const artifact of artifactsToValidate) {
    if (!artifact.validate) {
      logger.warn(`Skipping artifact ${artifact.id}: no validate command declared`);
      results.push({
        id: artifact.id,
        command: "",
        exitCode: 0,
        passed: true,
        violations: [],
        stdout: "",
        stderr: "skipped: no validate command",
      });
      continue;
    }

    const cmd = artifact.validate.command;
    const outputFormat = artifact.validate.outputFormat;
    const violationPattern = artifact.validate.violationPattern;
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: workspaceRoot });
      const violations = parseViolations(stdout + "\n" + stderr, outputFormat, violationPattern);
      results.push({
        id: artifact.id,
        command: cmd,
        exitCode: 0,
        passed: true,
        violations,
        stdout,
        stderr,
      });
      logger.success(`  ${artifact.id}: OK`);
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
      const rawStdout = e.stdout ?? "";
      const rawStderr = e.stderr ?? e.message;
      const violations = parseViolations(
        rawStdout + "\n" + rawStderr,
        outputFormat,
        violationPattern,
      );
      results.push({
        id: artifact.id,
        command: cmd,
        exitCode: e.code ?? 1,
        passed: false,
        violations,
        stdout: rawStdout,
        stderr: rawStderr,
      });
      logger.error(`  ${artifact.id}: FAILED (exit ${e.code ?? 1})`);
    }
  }

  const allPassed = results.every((r) => r.passed);

  return {
    data: {
      command: "forge.validate",
      profileId: profile.id,
      artifacts: results,
      allPassed,
    },
    exitCode: allPassed ? 0 : 1,
    summary: allPassed
      ? `forge.validate: all ${results.length} artifact(s) passed`
      : `forge.validate: ${results.filter((r) => !r.passed).length} artifact(s) failed`,
  };
}
