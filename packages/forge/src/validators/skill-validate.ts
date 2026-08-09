/*
<MODULE_CONTRACT>
<purpose>forge.skill.validate — validates all forge skills and declared pack skills against frontmatter contract and invariants SKILL-01..SKILL-21.</purpose>
<non-goals>
  <item>Do not validate third-party skills — only forge-managed skills in packages/forge/skills/ and declared pack skills.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0374: initial forge.skill.validate handler.</item>
  <item>RFC-0393: added SKILL-11 — canonical skill bodies must not contain hardcoded project-specific literals.</item>
  <item>RFC-0523: added SKILL-12 — concerns must be one of four-level enum. Updated SKILL-10 to cover read-only skills.</item>
  <item>RFC-0524: added SKILL-13 — declared knowledge files must exist relative to SKILL.md directory.</item>
  <item>RFC-0539: added SKILL-14 (pack skill name must start with pack prefix) and SKILL-15 (non-forge skill may not use fo- prefix). Extended SKILL-07 with asymmetric dependency direction (forge→pack forbidden). Added pack skill validation loop.</item>
  <item>RFC-0548: added SKILL-16 — triggers field must be an array of 1-5 strings, each 5-100 characters, only allowed on fo-category skills.</item>
  <item>RFC-0553: added SKILL-17 — skill files must not contain specific platform RFC/ADR ids (RFC-\\d{4}, ADR-\\d{4}) or platform names (Warpgogol, WarpGogol).</item>
  <item>RFC-0642: added SKILL-18 — forge skill instruction lines must not reference software-specific binding keys (typecheck, scopedBuild, test); use semantic keys (validate, produce, verify) instead.</item>
  <item>RFC-0660: added SKILL-19 (knowledge entry schema validity) and SKILL-20 (entry identifier uniqueness) for structured knowledge files.</item>
  <item>RFC-0661: added SKILL-21 (knowledge layer token budget warnings), refactored warning handling — warnings go to separate `warnings` array, not `violations`.</item>
  <item>2026-08-03: SKILL-17 WarpGogol brand pattern made case-sensitive — the /gi flag defeated the first pattern's @-lookbehind and false-flagged every `@warpgogol/<pkg>` npm-scope reference.</item>
</CHANGE_SUMMARY>
*/

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { skillFrontmatterSchema } from "../skill-schema.ts";
import { FORGE_SKILLS, discoverPackSkills, type PackSkillEntry } from "../registry.ts";
import { loadForgeConfig, resolveForgeRoot } from "../config/forge-config.ts";
import { parseKnowledgeFile } from "../knowledge/index.ts";
import type { ParsedKnowledgeFile } from "../knowledge/index.ts";
import {
  computeLayerBudgets,
  resolveKnowledgeBudgets,
  type KnowledgeBudgets,
} from "../knowledge/budgets.ts";

interface Violation {
  skill: string;
  rule: string;
  message: string;
  pack?: string;
  file?: string;
  line?: number;
  severity?: "error" | "warning";
  fixHint?: string;
}

interface Warning {
  skill: string;
  rule: string;
  message: string;
  severity: "warning";
  pack?: string;
  file?: string;
  layer?: string;
  fixHint?: string;
}

interface SkillValidateResult {
  command: string;
  status: "pass" | "fail";
  violations: Violation[];
  warnings: Warning[];
}

const PREFERENCES_PATTERN = /Read `PREFERENCES\.md`/i;

export function runSkillValidate(_input: unknown, context: unknown): SkillValidateResult {
  const ctx = context as { workspaceRoot?: string };
  const workspaceRoot = ctx?.workspaceRoot ?? process.cwd();
  const forgeRoot = path.join(workspaceRoot, "packages", "forge");
  const skillsDir = path.join(forgeRoot, "skills");

  // RFC-0539: Load config to discover declared skill packs
  let packSkills: PackSkillEntry[] = [];
  try {
    const forgeConfigRoot = resolveForgeRoot(workspaceRoot);
    const config = loadForgeConfig(forgeConfigRoot);
    packSkills = discoverPackSkills(workspaceRoot, config);
  } catch {
    // Config not found or invalid — skip pack skill validation
  }

  // Build known names set for SKILL-07: forge skills + pack skills
  const forgeSkillNames = new Set(FORGE_SKILLS.map((s) => s.name));
  const packSkillNames = new Set(packSkills.map((s) => s.name));

  const violations: Violation[] = [];
  const warnings: Warning[] = [];

  // RFC-0661: resolve effective knowledge budgets from forge.yaml
  const budgets = resolveKnowledgeBudgets(workspaceRoot);

  for (const entry of FORGE_SKILLS) {
    const skillPath = path.join(forgeRoot, entry.path);
    const skillDir = path.dirname(skillPath);

    // SKILL-02: name matches directory name
    if (path.basename(skillDir) !== entry.name) {
      violations.push({
        skill: entry.name,
        rule: "SKILL-02",
        message: `Directory name "${path.basename(skillDir)}" does not match skill name "${entry.name}"`,
      });
    }

    if (!fs.existsSync(skillPath)) {
      violations.push({
        skill: entry.name,
        rule: "SKILL-01",
        message: `SKILL.md not found at ${entry.path}`,
      });
      continue;
    }

    const content = fs.readFileSync(skillPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) {
      violations.push({
        skill: entry.name,
        rule: "SKILL-01",
        message: "No frontmatter block found",
      });
      continue;
    }

    let fm: Record<string, unknown>;
    try {
      fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
    } catch {
      violations.push({
        skill: entry.name,
        rule: "SKILL-01",
        message: "Frontmatter is not valid YAML",
      });
      continue;
    }

    // SKILL-01: Frontmatter parses against Zod schema
    // SKILL-12: concerns must be one of the four-level enum (RFC-0523)
    const parsed = skillFrontmatterSchema.safeParse(fm);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const isConcernsIssue = issue.path.join(".") === "concerns";
        violations.push({
          skill: entry.name,
          rule: isConcernsIssue ? "SKILL-12" : "SKILL-01",
          message: `${issue.path.join(".")}: ${issue.message}`,
        });
      }
      continue;
    }

    // SKILL-02: name matches directory name (already checked above, also check frontmatter)
    if (parsed.data.name !== entry.name) {
      violations.push({
        skill: entry.name,
        rule: "SKILL-02",
        message: `Frontmatter name "${parsed.data.name}" does not match registry name "${entry.name}"`,
      });
    }

    // SKILL-03: description present and ≤ 200 chars (enforced by Zod)
    // SKILL-04: invocation is user|model (enforced by Zod)
    // SKILL-05: category is fo|shared|meta (enforced by Zod)
    // SKILL-06: concerns is read-only|document-only|content-mutation|code-mutation (enforced by Zod)
    // SKILL-08: languagePolicy is ref(PREFERENCES.md) (enforced by Zod)

    // SKILL-07: dependsOn entries correspond to existing skill names
    // RFC-0539: Asymmetric dependency direction — forge skills may only depend on
    // other forge skills (forge→pack is forbidden — breaks portability).
    for (const dep of parsed.data.dependsOn) {
      if (!forgeSkillNames.has(dep)) {
        violations.push({
          skill: entry.name,
          rule: "SKILL-07",
          message: `dependsOn references non-existent forge skill '${dep}'`,
        });
      }
    }

    // SKILL-09: Body contains standardized "Read PREFERENCES.md…" instruction
    const body = content.slice(fmMatch[0].length);
    if (!PREFERENCES_PATTERN.test(body)) {
      violations.push({
        skill: entry.name,
        rule: "SKILL-09",
        message: 'Body does not contain the standardized "Read PREFERENCES.md…" instruction',
      });
    }

    // SKILL-10: read-only and document-only skills do not contain code execution instructions.
    // NOTE: `exec` is excluded from the pattern because `pnpm exec werkstatt run …`
    // is the standard governance command invocation in this ecosystem, not a code
    // build/install. The pattern catches `pnpm run build`, `pnpm install`, `npm run
    // test`, `npx vitest run`, `tsc --noEmit` (via `tsc` + `run`), etc.
    if (parsed.data.concerns === "read-only" || parsed.data.concerns === "document-only") {
      const execPattern = /\b(pnpm|npm|npx|node|vitest|tsc)\s+(run|install|build)/gi;
      execPattern.lastIndex = 0;
      if (execPattern.test(body)) {
        violations.push({
          skill: entry.name,
          rule: "SKILL-10",
          message: `${parsed.data.concerns} skill contains code execution instructions`,
        });
      }
    }

    // SKILL-11: Canonical skill bodies must not contain hardcoded project-specific
    // literals in instruction lines (code blocks and "run:" directives).
    // Scans only imperative instruction lines, not narrative prose.
    // Supports <!-- skill-lint-disable SKILL-11 --> escape hatch.
    {
      const skill11Violations = checkSkill11(entry.name, body);
      violations.push(...skill11Violations);
    }

    // SKILL-18: Forge skill instruction lines must not reference software-specific
    // binding keys (typecheck, scopedBuild, test). Use semantic keys instead
    // (validate, produce, verify). Same scope as SKILL-11 (code blocks + run: directives).
    // Supports <!-- skill-lint-disable SKILL-18 --> escape hatch.
    // Forge-skill path only — pack skills are domain-specific by design.
    {
      const skill18Violations = checkSkill18(entry.name, body);
      violations.push(...skill18Violations);
    }

    // SKILL-13: Declared knowledge files must exist relative to SKILL.md directory (RFC-0524)
    // SKILL-19/SKILL-20: Knowledge entry schema and identifier uniqueness (RFC-0660)
    // SKILL-21: Knowledge layer token budget warnings (RFC-0661)
    if (parsed.data.knowledge) {
      const parsedFiles: ParsedKnowledgeFile[] = [];
      for (const knowledgeFile of parsed.data.knowledge) {
        const knowledgePath = path.join(skillDir, knowledgeFile);
        if (!fs.existsSync(knowledgePath)) {
          violations.push({
            skill: entry.name,
            rule: "SKILL-13",
            message: `Declared knowledge file '${knowledgeFile}' not found relative to SKILL.md directory`,
          });
        } else {
          const { errors, warnings: skillWarnings } = checkSkill19And20(
            entry.name,
            knowledgeFile,
            knowledgePath,
          );
          violations.push(...errors);
          warnings.push(...skillWarnings);
          // Collect parsed files for SKILL-21 batch budget check
          parsedFiles.push(parseKnowledgeFile(knowledgePath));
        }
      }
      // SKILL-21: Check hot/warm layer budgets
      warnings.push(...checkSkill21Budgets(parsedFiles, budgets, entry.name));
    }

    // SKILL-16: triggers field format and category restriction (RFC-0548)
    if (parsed.data.triggers) {
      if (entry.category !== "fo") {
        violations.push({
          skill: entry.name,
          rule: "SKILL-16",
          message: `triggers field is only allowed on fo-category skills (got '${entry.category}') — intent-to-skill routing is for fo-skills only`,
        });
      }
      for (const trigger of parsed.data.triggers) {
        if (trigger.length < 5 || trigger.length > 100) {
          violations.push({
            skill: entry.name,
            rule: "SKILL-16",
            message: `triggers entry '${trigger.slice(0, 50)}' must be 5-100 characters (got ${trigger.length})`,
          });
        }
      }
      if (parsed.data.triggers.length > 5) {
        violations.push({
          skill: entry.name,
          rule: "SKILL-16",
          message: `triggers array must have at most 5 entries (got ${parsed.data.triggers.length})`,
        });
      }
    }

    // SKILL-17: No internal platform RFC/ADR id references or platform names (RFC-0553)
    {
      const skill17Violations = checkSkill17(entry.name, content);
      violations.push(...skill17Violations);
    }
  }

  // RFC-0539: Validate pack skills
  for (const entry of packSkills) {
    const skillPath = path.join(workspaceRoot, entry.dir, entry.path);
    const skillDir = path.dirname(skillPath);

    // SKILL-02: name matches directory name
    if (path.basename(skillDir) !== entry.name) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-02",
        message: `Directory name "${path.basename(skillDir)}" does not match skill name "${entry.name}"`,
      });
    }

    if (!fs.existsSync(skillPath)) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-01",
        message: `SKILL.md not found at ${entry.dir}/${entry.path}`,
      });
      continue;
    }

    const content = fs.readFileSync(skillPath, "utf8");
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-01",
        message: "No frontmatter block found",
      });
      continue;
    }

    let fm: Record<string, unknown>;
    try {
      fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
    } catch {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-01",
        message: "Frontmatter is not valid YAML",
      });
      continue;
    }

    const parsed = skillFrontmatterSchema.safeParse(fm);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const isConcernsIssue = issue.path.join(".") === "concerns";
        violations.push({
          skill: entry.name,
          pack: entry.pack,
          rule: isConcernsIssue ? "SKILL-12" : "SKILL-01",
          message: `${issue.path.join(".")}: ${issue.message}`,
        });
      }
      continue;
    }

    // SKILL-02: name matches frontmatter
    if (parsed.data.name !== entry.name) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-02",
        message: `Frontmatter name "${parsed.data.name}" does not match directory name "${entry.name}"`,
      });
    }

    // SKILL-07: dependsOn entries — pack skills may depend on forge skills or other pack skills
    for (const dep of parsed.data.dependsOn) {
      if (!forgeSkillNames.has(dep) && !packSkillNames.has(dep)) {
        violations.push({
          skill: entry.name,
          pack: entry.pack,
          rule: "SKILL-07",
          message: `dependsOn references non-existent skill '${dep}'`,
        });
      }
    }

    // SKILL-09: Body contains standardized "Read PREFERENCES.md…" instruction
    const body = content.slice(fmMatch[0].length);
    if (!PREFERENCES_PATTERN.test(body)) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-09",
        message: 'Body does not contain the standardized "Read PREFERENCES.md…" instruction',
      });
    }

    // SKILL-10: read-only and document-only skills do not contain code execution instructions
    if (parsed.data.concerns === "read-only" || parsed.data.concerns === "document-only") {
      const execPattern = /\b(pnpm|npm|npx|node|vitest|tsc)\s+(run|install|build)/gi;
      execPattern.lastIndex = 0;
      if (execPattern.test(body)) {
        violations.push({
          skill: entry.name,
          pack: entry.pack,
          rule: "SKILL-10",
          message: `${parsed.data.concerns} skill contains code execution instructions`,
        });
      }
    }

    // SKILL-11: No hardcoded project-specific literals in canonical skill bodies
    {
      const skill11Violations = checkSkill11(entry.name, body);
      for (const v of skill11Violations) {
        v.pack = entry.pack;
      }
      violations.push(...skill11Violations);
    }

    // SKILL-13: Declared knowledge files must exist
    // SKILL-19/SKILL-20: Knowledge entry schema and identifier uniqueness (RFC-0660)
    // SKILL-21: Knowledge layer token budget warnings (RFC-0661)
    if (parsed.data.knowledge) {
      const parsedFiles: ParsedKnowledgeFile[] = [];
      for (const knowledgeFile of parsed.data.knowledge) {
        const knowledgePath = path.join(skillDir, knowledgeFile);
        if (!fs.existsSync(knowledgePath)) {
          violations.push({
            skill: entry.name,
            pack: entry.pack,
            rule: "SKILL-13",
            message: `Declared knowledge file '${knowledgeFile}' not found relative to SKILL.md directory`,
          });
        } else {
          const { errors, warnings: skillWarnings } = checkSkill19And20(
            entry.name,
            knowledgeFile,
            knowledgePath,
            entry.pack,
          );
          violations.push(...errors);
          warnings.push(...skillWarnings);
          parsedFiles.push(parseKnowledgeFile(knowledgePath));
        }
      }
      // SKILL-21: Check hot/warm layer budgets for pack skills
      warnings.push(...checkSkill21Budgets(parsedFiles, budgets, entry.name, entry.pack));
    }

    // SKILL-16: triggers field format (RFC-0548) — pack skills may not use triggers
    if (parsed.data.triggers) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-16",
        message:
          "triggers field is only allowed on forge fo-category skills — pack skills may not declare triggers",
      });
    }

    // SKILL-14: Pack skill name must start with its pack prefix (RFC-0539)
    if (!entry.name.startsWith(`${entry.pack}-`)) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-14",
        message: `Pack skill name must start with pack prefix '${entry.pack}-'`,
      });
    }

    // SKILL-15: Non-forge skill may not use the 'fo-' prefix (RFC-0539)
    if (entry.name.startsWith("fo-")) {
      violations.push({
        skill: entry.name,
        pack: entry.pack,
        rule: "SKILL-15",
        message: "Non-forge skill may not use the 'fo-' prefix (reserved for forge skills)",
      });
    }

    // SKILL-17: No internal platform RFC/ADR id references or platform names (RFC-0553)
    {
      const skill17Violations = checkSkill17(entry.name, content);
      for (const v of skill17Violations) {
        v.pack = entry.pack;
      }
      violations.push(...skill17Violations);
    }
  }

  // Check: every SKILL.md on disk has a registry entry
  if (fs.existsSync(skillsDir)) {
    scanForOrphanSkills(skillsDir, new Set(FORGE_SKILLS.map((s) => s.path)), forgeRoot, violations);
  }

  return {
    command: "forge.skill.validate",
    status: violations.length === 0 ? "pass" : "fail",
    violations,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// SKILL-11: No hardcoded project-specific literals in canonical skill bodies
// ---------------------------------------------------------------------------

const SKILL11_PATTERNS: RegExp[] = [
  /pnpm\s+exec\s+werkstatt\s+run/gi,
  /docs\/architecture-dna\.md/gi,
];

const SKILL11_DISABLE_MARKER = "<!-- skill-lint-disable SKILL-11 -->";

function checkSkill11(skillName: string, body: string): Violation[] {
  const result: Violation[] = [];

  // If the entire file has the disable marker, skip all SKILL-11 checks
  if (body.includes(SKILL11_DISABLE_MARKER)) {
    return result;
  }

  // Extract instruction lines: lines inside code blocks (``` ... ```)
  // and lines starting with "run:" directives
  const instructionLines = extractInstructionLines(body);

  for (const line of instructionLines) {
    // Check for per-line disable marker
    if (line.includes(SKILL11_DISABLE_MARKER)) {
      continue;
    }

    for (const pattern of SKILL11_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(line)) {
        result.push({
          skill: skillName,
          rule: "SKILL-11",
          message: `Instruction line contains hardcoded project-specific literal: ${line.trim().slice(0, 100)}`,
        });
        break; // one violation per line
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// SKILL-18: No software-specific binding keys in forge skill instruction lines (RFC-0642)
// ---------------------------------------------------------------------------

const SKILL18_PATTERNS: RegExp[] = [
  /bindings\.commands\.typecheck/gi,
  /bindings\.commands\.scopedBuild/gi,
  /bindings\.commands\.test/gi,
];

const SKILL18_DISABLE_MARKER = "<!-- skill-lint-disable SKILL-18 -->";

function checkSkill18(skillName: string, body: string): Violation[] {
  const result: Violation[] = [];

  if (body.includes(SKILL18_DISABLE_MARKER)) {
    return result;
  }

  const instructionLines = extractInstructionLines(body);

  for (const line of instructionLines) {
    if (line.includes(SKILL18_DISABLE_MARKER)) {
      continue;
    }

    for (const pattern of SKILL18_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      const match = re.exec(line);
      if (match) {
        result.push({
          skill: skillName,
          rule: "SKILL-18",
          message: `Instruction line references software-specific binding key '${match[0]}' — use semantic key instead`,
        });
        break;
      }
    }
  }

  return result;
}

function extractInstructionLines(body: string): string[] {
  const lines: string[] = [];
  const bodyLines = body.split(/\r?\n/);
  let inCodeBlock = false;

  for (const line of bodyLines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      lines.push(line);
    } else if (/^\s*run:/i.test(line)) {
      lines.push(line);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// SKILL-17: No internal platform RFC/ADR/DNA id references or platform names (RFC-0553)
// ---------------------------------------------------------------------------

const SKILL17_ID_PATTERNS: RegExp[] = [/\bRFC-\d{4}\b/g, /\bADR-\d{4}\b/g, /\bDNA-\d+\b/g];

const SKILL17_PLATFORM_PATTERNS: RegExp[] = [/(?<!@)Warpgogol\b/gi, /\bWarpGogol\b/g];

const SKILL17_DISABLE_MARKER = "<!-- skill-lint-disable SKILL-17 -->";

function checkSkill17(skillName: string, content: string): Violation[] {
  const result: Violation[] = [];

  if (content.includes(SKILL17_DISABLE_MARKER)) {
    return result;
  }

  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    if (line.includes(SKILL17_DISABLE_MARKER)) {
      continue;
    }

    for (const pattern of SKILL17_ID_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      const match = re.exec(line);
      if (match) {
        result.push({
          skill: skillName,
          rule: "SKILL-17",
          message: `Contains internal platform RFC/ADR/DNA id '${match[0]}': ${line.trim().slice(0, 100)}`,
        });
        break;
      }
    }

    for (const pattern of SKILL17_PLATFORM_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      const match = re.exec(line);
      if (match) {
        result.push({
          skill: skillName,
          rule: "SKILL-17",
          message: `Contains internal platform name '${match[0]}': ${line.trim().slice(0, 100)}`,
        });
        break;
      }
    }
  }

  return result;
}

interface Skill19And20Result {
  errors: Violation[];
  warnings: Warning[];
}

function checkSkill19And20(
  skillName: string,
  fileName: string,
  filePath: string,
  pack?: string,
): Skill19And20Result {
  const errors: Violation[] = [];
  const warnings: Warning[] = [];
  const parsed = parseKnowledgeFile(filePath);

  // Knowledge-adjacent files are exempt from SKILL-19/SKILL-20
  if (parsed.isKnowledgeAdjacent) {
    return { errors, warnings };
  }

  // SKILL-19: Entry schema validity (errors)
  for (const issue of parsed.parseIssues) {
    errors.push({
      skill: skillName,
      rule: "SKILL-19",
      file: fileName,
      line: issue.line,
      severity: "error",
      message: issue.message,
      pack,
    });
  }

  // SKILL-19: Legacy section warnings (migration window) — go to warnings, not errors
  if (parsed.legacySections.length > 0) {
    warnings.push({
      skill: skillName,
      rule: "SKILL-19",
      file: fileName,
      severity: "warning",
      message: `${parsed.legacySections.length} legacy section${parsed.legacySections.length === 1 ? "" : "s"} predate RFC-0660 — run the knowledge compaction command to migrate`,
      pack,
    });
  }

  // SKILL-20: Identifier uniqueness and reference validity (errors)
  const seenIds = new Map<string, number>(); // id → first line
  for (const entry of parsed.entries) {
    // Check id format
    if (!/^K-\d{4}$/.test(entry.meta.id)) {
      errors.push({
        skill: skillName,
        rule: "SKILL-20",
        file: fileName,
        line: entry.lineStart,
        severity: "error",
        message: `Entry id '${entry.meta.id}' does not match ^K-\d{4}$`,
        pack,
      });
      continue;
    }

    // Check uniqueness
    if (seenIds.has(entry.meta.id)) {
      errors.push({
        skill: skillName,
        rule: "SKILL-20",
        file: fileName,
        line: entry.lineStart,
        severity: "error",
        message: `Duplicate entry id ${entry.meta.id} (first occurrence at line ${seenIds.get(entry.meta.id)})`,
        pack,
      });
    } else {
      seenIds.set(entry.meta.id, entry.lineStart);
    }
  }

  // Check supersedes references resolve within the same file
  const entryIds = new Set(parsed.entries.map((e) => e.meta.id));
  for (const entry of parsed.entries) {
    if (entry.meta.supersedes) {
      for (const refId of entry.meta.supersedes) {
        if (!entryIds.has(refId)) {
          errors.push({
            skill: skillName,
            rule: "SKILL-20",
            file: fileName,
            line: entry.lineStart,
            severity: "error",
            message: `Entry ${entry.meta.id}: supersedes reference '${refId}' does not resolve to an entry in the same file`,
            pack,
          });
        }
      }
    }

    // Check promotedTo format
    if (entry.meta.promotedTo !== null && entry.meta.promotedTo !== undefined) {
      if (!/^shared\/K-\d{4}$/.test(entry.meta.promotedTo)) {
        errors.push({
          skill: skillName,
          rule: "SKILL-20",
          file: fileName,
          line: entry.lineStart,
          severity: "error",
          message: `Entry ${entry.meta.id}: promotedTo '${entry.meta.promotedTo}' does not match ^shared/K-\d{4}$`,
          pack,
        });
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// SKILL-21: Knowledge layer token budget warnings (RFC-0661)
// ---------------------------------------------------------------------------

function checkSkill21Budgets(
  parsedFiles: ParsedKnowledgeFile[],
  budgets: KnowledgeBudgets,
  skillName: string,
  pack?: string,
): Warning[] {
  const warnings: Warning[] = [];
  const skillNames = new Map<string, string>();
  for (const pf of parsedFiles) {
    skillNames.set(pf.path, skillName);
  }
  const budgetReports = computeLayerBudgets(parsedFiles, budgets, skillNames);
  for (const report of budgetReports) {
    if (report.exceededBy > 0) {
      const layerName = report.layer === "L2" ? "Hot" : "Warm";
      const pctOver = Math.round((report.exceededBy / report.budget) * 100);
      warnings.push({
        skill: skillName,
        rule: "SKILL-21",
        file: report.file,
        layer: report.layer,
        severity: "warning",
        message: `${layerName} layer exceeds budget: ${report.activeChars} of ${report.budget} characters (${pctOver}% over)`,
        fixHint:
          "Run the knowledge compaction command (RFC-0662) to archive stale entries, or promote duplicated principles to the shared layer (RFC-0663)",
        pack,
      });
    }
  }
  return warnings;
}

function scanForOrphanSkills(
  dir: string,
  knownPaths: Set<string>,
  forgeRoot: string,
  violations: Violation[],
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      scanForOrphanSkills(path.join(dir, entry.name), knownPaths, forgeRoot, violations);
    } else if (entry.name === "SKILL.md") {
      const relPath = path.relative(forgeRoot, path.join(dir, entry.name)).replace(/\\/g, "/");
      if (!knownPaths.has(relPath)) {
        violations.push({
          skill: path.basename(dir),
          rule: "SKILL-01",
          message: `SKILL.md at ${relPath} has no registry entry`,
        });
      }
    }
  }
}
