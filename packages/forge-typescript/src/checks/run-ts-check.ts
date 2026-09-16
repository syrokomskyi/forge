/*
<MODULE_CONTRACT>
<purpose>defineTsCheck — harness that turns a pure (model) => Diagnostic[] rule
into a complete KernelCommandDefinition. Owns workspace-model construction
(once per execute call), the --globs flag, the empty-workspace pass, diagnostics
accumulation, summary/status/exitCode mapping, and the KernelCommandResult
envelope for all six ts.*.validate commands (RFC-1099).</purpose>

<non-goals>
  <item>Does not contain rule logic — each validator supplies its own check function.</item>
  <item>Does not perform file I/O inside rules — rules consume TsWorkspaceModel facts only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1099: initial check harness — replaces per-validator boilerplate (walk, read, envelope shaping) with one defineTsCheck seam.</item>
</CHANGE_SUMMARY>
*/

import type {
  KernelCommandDefinition,
  KernelCommandResult,
  Diagnostic,
} from "@warpgogol/werkstatt-engine/kernel/types";
import { buildWorkspaceModel, type TsWorkspaceModel } from "../model/workspace-model.ts";
import { emptySummary, buildSummary } from "./diagnostic-helpers.ts";

export interface TsCheckData {
  command: string;
  status: "pass" | "warn" | "fail";
  diagnostics: Diagnostic[];
  summary: { error: number; warning: number; info: number };
  scannedFiles: number;
}

export interface DefineTsCheckInput {
  name: string;
  description: string;
  reads: string[];
  contract: string;
  rules: string[];
  check: (model: TsWorkspaceModel) => Diagnostic[];
}

const DEFAULT_GLOBS = ["packages/*", "services/*"];

function parseGlobsFlag(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_GLOBS;
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

export function defineTsCheck(input: DefineTsCheckInput): KernelCommandDefinition<TsCheckData> {
  return {
    name: input.name,
    contract: input.contract,
    rules: input.rules,
    description: input.description,
    scope: "workspace",
    cacheable: true,
    supportsAllSites: false,
    reads: input.reads,
    flags: {
      globs: {
        kind: "string",
        description:
          "Comma-separated package globs relative to workspace root (default: packages/*, services/*).",
      },
    },
    async execute(commandInput, context) {
      const globs = parseGlobsFlag(commandInput.flags.globs);
      const model = await buildWorkspaceModel(context.workspaceRoot, globs);

      if (model.packages.length === 0) {
        const empty: TsCheckData = {
          command: input.name,
          status: "pass",
          diagnostics: [],
          summary: emptySummary(),
          scannedFiles: 0,
        };
        const result: KernelCommandResult<TsCheckData> = {
          data: empty,
          exitCode: 0,
          summary: `${input.name}: pass (no workspace packages matched)`,
        };
        return result;
      }

      const diagnostics = input.check(model);
      const summary = buildSummary(diagnostics);
      const status =
        summary.error > 0 ? "fail" : summary.warning > 0 ? "warn" : "pass";

      const result: KernelCommandResult<TsCheckData> = {
        data: {
          command: input.name,
          status,
          diagnostics,
          summary,
          scannedFiles: model.scannedFiles,
        },
        exitCode: summary.error > 0 ? 1 : 0,
        summary: `${input.name}: ${status} (${summary.error} error(s), ${summary.warning} warning(s))`,
      };
      return result;
    },
  };
}
