/*
<MODULE_CONTRACT>
<purpose>
RFC-1466: instructions.budget.validate — bound the instruction layer.
INSTR-01 AGENTS.md file over declared budget; INSTR-2 scar-classified bullet
in an exempt section (informational); INSTR-03 migrated scar still present
as prose (fragment entry exists, bullet not removed).
Autonomous — scans repo files only (FORGE-AUTONOMY-01).
</purpose>
<non-goals>
  <item>Does not migrate scars — scar.migrate owns that.</item>
  <item>Wave-1 rollout: reporting-only diagnostics until the first migration pass brings files under ceiling.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1466: INSTR-01/02/03 budget + scar-classification audit over AGENTS.md files</item>
  <item>RFC-1466: bound the instruction layer — instructions.budget.validate, scar.migrate, catalog fragment merge</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { parse as yamlParse } from "yaml";
import { ambientIo, resolveIo } from "../../../src/utils/io.ts";
import type {
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
} from "../../../src/types.ts";

export interface InstructionDiagnostic {
  ruleId: "INSTR-01" | "INSTR-02" | "INSTR-03";
  severity: "warning" | "error";
  file: string;
  line?: number;
  message: string;
}

export interface BudgetValidateData {
  command: "instructions.budget.validate";
  status: "ok";
  filesScanned: number;
  scarsFound: number;
  diagnostics: InstructionDiagnostic[];
}

export interface InstructionsBudget {
  maxLinesPerFile: number;
  maxTokensPerFile: number;
  exemptSections: string[];
  overrides: Record<string, { maxLinesPerFile?: number; maxTokensPerFile?: number }>;
}

export const DEFAULT_BUDGET: InstructionsBudget = {
  maxLinesPerFile: 400,
  maxTokensPerFile: 12000,
  exemptSections: ["Verbund", "Monorepo layout"],
  overrides: {},
};

const SCAR_RE =
  /Discovered during|after (?:the |an? )?incident|\bF-\d{4}\b|\b(?:fix(?:ed)?|landed|hardened) (?:in|at|by) [0-9a-f]{7,40}\b|\b[0-9a-f]{9}\b/;
const INVARIANT_RE =
  /\b(MUST|SHALL|NEVER|ALWAYS|invariant|forbidden|prohibited|hard guard|blocking)\b/i;

export function isScar(line: string): boolean {
  return SCAR_RE.test(line);
}

export function loadBudget(raw: unknown): InstructionsBudget {
  const out = { ...DEFAULT_BUDGET, overrides: {} as InstructionsBudget["overrides"] };
  if (raw == null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("instructions.budget must be a map");
  }
  const b = raw as Record<string, unknown>;
  const unknown = Object.keys(b).filter(
    (k) => !["maxLinesPerFile", "maxTokensPerFile", "exemptSections", "overrides"].includes(k),
  );
  if (unknown.length > 0) {
    throw new Error(`instructions.budget: unknown field(s) ${unknown.join(", ")}`);
  }
  if (typeof b.maxLinesPerFile === "number") out.maxLinesPerFile = b.maxLinesPerFile;
  if (typeof b.maxTokensPerFile === "number") out.maxTokensPerFile = b.maxTokensPerFile;
  if (Array.isArray(b.exemptSections)) out.exemptSections = b.exemptSections as string[];
  if (b.overrides != null && typeof b.overrides === "object" && !Array.isArray(b.overrides)) {
    out.overrides = b.overrides as InstructionsBudget["overrides"];
  }
  return out;
}

function sectionOf(lines: string[], idx: number): string {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i]!.match(/^#{2,3}\s+(.*)$/);
    if (m) return m[1]!.trim();
  }
  return "";
}

async function agentsFiles(root: string, io: ReturnType<typeof resolveIo>): Promise<string[]> {
  const files: string[] = [];
  if (await io.exists(path.join(root, "AGENTS.md"))) files.push("AGENTS.md");
  for (const dir of ["packages", "apps"]) {
    const parent = path.join(root, dir);
    for (const e of await io.readdir(parent).catch(() => [] as { name: string; isFile: boolean; isDirectory: boolean }[])) {
      if (e.isDirectory && (await io.exists(path.join(parent, e.name, "AGENTS.md")))) {
        files.push(`${dir}/${e.name}/AGENTS.md`);
      }
    }
  }
  return files;
}

export async function runInstructionsBudgetValidate(
  _input: ForgeCommandInput,
  context: ForgeRuntimeContext,
): Promise<ForgeCommandResult<BudgetValidateData>> {
  const io = resolveIo(context.io ?? ambientIo);
  const root = context.workspaceRoot;
  const forgeYaml = await io.readFile(path.join(root, "forge.yaml")).catch(() => null);
  const budget = loadBudget(forgeYaml === null ? null : yamlParse(forgeYaml)?.instructions?.budget);

  // Fragment catalog → INSTR-03 (migrated-but-still-prose).
  const fragmentSrc = await io
    .readFile(path.join(root, "docs", "remediation-catalog.custom.yaml"))
    .catch(() => null);
  const fragment = (yamlParse(fragmentSrc ?? "") ?? {}) as {
    entries?: { migratedFrom?: string; originLine?: number; ruleText?: string }[];
  };
  const migrations = (fragment.entries ?? [])
    .filter((e) => e.migratedFrom && typeof e.originLine === "number")
    .map((e) => ({ ...e, file: e.migratedFrom!.split(":")[0]! }));

  const diagnostics: InstructionDiagnostic[] = [];
  let scars = 0;
  const files = await agentsFiles(root, io);
  for (const rel of files) {
    const src = await io.readFile(path.join(root, rel)).catch(() => "");
    if (!src) continue;
    const lines = src.split("\n");
    const ov = budget.overrides[rel] ?? {};
    const maxLines = ov.maxLinesPerFile ?? budget.maxLinesPerFile;
    const maxTokens = ov.maxTokensPerFile ?? budget.maxTokensPerFile;
    const estTokens = Math.ceil(src.length / 4);
    if (lines.length > maxLines || estTokens > maxTokens) {
      diagnostics.push({
        ruleId: "INSTR-01",
        severity: "warning",
        file: rel,
        message: `${rel}: ${lines.length} lines (~${estTokens} tokens) exceeds budget ${maxLines} lines / ${maxTokens} tokens — migrate friction scars via scar.migrate or declare an override`,
      });
    }
    lines.forEach((line, i) => {
      if (!line.startsWith("- ") || !isScar(line)) return;
      scars++;
      const section = sectionOf(lines, i);
      if (budget.exemptSections.some((s) => section.toLowerCase() === s.toLowerCase())) {
        diagnostics.push({
          ruleId: "INSTR-02",
          severity: "warning",
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1}: scar-classified bullet inside exempt section "${section}" — informational; invariant-shaped content is exempt from migration`,
        });
      }
      if (INVARIANT_RE.test(line) && !budget.exemptSections.some((s) => section.toLowerCase() === s.toLowerCase())) {
        // invariant keyword in a non-exempt section — still a migration
        // candidate? No: invariant-shaped prose stays (conservative bias).
        return;
      }
    });
    for (const m of migrations) {
      if (m.file !== rel) continue;
      const idx = (m.originLine ?? 0) - 1;
      if (idx >= 0 && idx < lines.length && isScar(lines[idx]!)) {
        diagnostics.push({
          ruleId: "INSTR-03",
          severity: "warning",
          file: rel,
          line: idx + 1,
          message: `${rel}:${idx + 1}: scar migrated to catalog (${m.migratedFrom}) but the prose bullet is still present — remove the bullet or fix the fragment's originLine`,
        });
      }
    }
  }

  if (context.outputFormat === "pretty") {
    for (const d of diagnostics) context.logger.warn(`${d.ruleId} ${d.message}`);
  }
  return {
    data: {
      command: "instructions.budget.validate",
      status: "ok",
      filesScanned: files.length,
      scarsFound: scars,
      diagnostics,
    },
    summary: `${diagnostics.length} instruction diagnostic(s) over ${files.length} file(s)`,
    exitCode: 0,
  };
}
