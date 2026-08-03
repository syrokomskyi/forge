/*
<MODULE_CONTRACT>
<purpose>Knowledge layer character budget computation and resolution — pure functions for hot/warm budget enforcement (RFC-0661).</purpose>
<non-goals>
  <item>Do not emit warnings or violations — that is handled by SKILL-21 in skill-validate.ts.</item>
  <item>Do not parse knowledge files — that is handled by parse.ts (RFC-0660).</item>
  <item>Do not validate budget override shape — that is handled by forge.doctor.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0661: initial budget module with KnowledgeBudgets, LayerBudgetReport, computeLayerBudgets, resolveKnowledgeBudgets.</item>
</CHANGE_SUMMARY>
*/

import path from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ParsedKnowledgeFile, KnowledgeLayer } from "./schema.ts";

// ---------------------------------------------------------------------------
// Types (RFC-0661)
// ---------------------------------------------------------------------------

export interface KnowledgeBudgets {
  hot: number; // default 4096 — L2 (learned-principles.md)
  warm: number; // default 8192 — L1 (fix-patterns.md)
}

export interface LayerBudgetReport {
  skill: string;
  file: string;
  layer: KnowledgeLayer;
  activeChars: number;
  budget: number;
  exceededBy: number; // 0 when within budget
  pack?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_KNOWLEDGE_BUDGETS: KnowledgeBudgets = {
  hot: 4096,
  warm: 8192,
};

// ---------------------------------------------------------------------------
// computeLayerBudgets — pure function
// ---------------------------------------------------------------------------

/**
 * Compute per-file budget reports for parsed knowledge files.
 *
 * - Counts only `status: active` entries (heading + metadata block + body).
 * - Uses `ParsedKnowledgeFile.layer` to determine which budget applies.
 * - Skips files with undeterminable layer (null) or L0 (cold, no budget).
 * - Skips files with parse issues (schema errors are already reported by SKILL-19).
 *
 * Pure: no filesystem side effects.
 */
export function computeLayerBudgets(
  files: ParsedKnowledgeFile[],
  budgets: KnowledgeBudgets,
  skillNames: Map<string, string>,
): LayerBudgetReport[] {
  const reports: LayerBudgetReport[] = [];

  for (const file of files) {
    // Skip files with undeterminable layer
    if (file.layer === null) {
      continue;
    }

    // Skip cold layer (L0) — no budget by design
    if (file.layer === "L0") {
      continue;
    }

    // Skip files with parse issues — SKILL-19 already reports those
    if (file.parseIssues.length > 0) {
      continue;
    }

    // Skip knowledge-adjacent files (no structured entries)
    if (file.isKnowledgeAdjacent) {
      continue;
    }

    const budget = file.layer === "L2" ? budgets.hot : budgets.warm;
    const fileName = path.basename(file.path);
    const skillName = skillNames.get(file.path) ?? path.basename(path.dirname(file.path));

    // Count only active entries: heading + metadata block + body
    let activeChars = 0;
    for (const entry of file.entries) {
      if (entry.meta.status !== "active") {
        continue;
      }
      // Heading: "### K-XXXX: <title>\n"
      activeChars += `### ${entry.meta.id}: ${entry.title}\n`.length;
      // Metadata block: ```knowledge-entry\n<yaml>\n```\n
      const metaYaml = serializeMetaAsYaml(entry.meta);
      activeChars += "```knowledge-entry\n".length;
      activeChars += metaYaml.length;
      activeChars += "```\n".length;
      // Body
      activeChars += entry.body.length;
    }

    const exceededBy = Math.max(0, activeChars - budget);

    reports.push({
      skill: skillName,
      file: fileName,
      layer: file.layer,
      activeChars,
      budget,
      exceededBy,
    });
  }

  return reports;
}

// ---------------------------------------------------------------------------
// resolveKnowledgeBudgets — reads forge.yaml
// ---------------------------------------------------------------------------

/**
 * Read effective knowledge budgets from forge.yaml bindings.
 *
 * Falls back to defaults (hot: 4096, warm: 8192) when:
 * - forge.yaml is not found
 * - bindings.knowledge.budgets is absent
 * - override values are invalid (non-positive, non-integer)
 *
 * Does NOT validate the override shape — forge.doctor handles that separately.
 */
export function resolveKnowledgeBudgets(workspaceRoot: string): KnowledgeBudgets {
  try {
    const forgeYamlPath = path.join(workspaceRoot, "forge.yaml");
    const content = readFileSync(forgeYamlPath, "utf8");
    const config = parseYaml(content) as Record<string, unknown>;
    const bindings = config?.bindings as Record<string, unknown> | undefined;
    const knowledge = bindings?.knowledge as Record<string, unknown> | undefined;
    const budgets = knowledge?.budgets as { hot?: unknown; warm?: unknown } | undefined;

    if (!budgets) {
      return { ...DEFAULT_KNOWLEDGE_BUDGETS };
    }

    const hot = typeof budgets.hot === "number" && budgets.hot > 0 && Number.isInteger(budgets.hot)
      ? budgets.hot
      : DEFAULT_KNOWLEDGE_BUDGETS.hot;
    const warm = typeof budgets.warm === "number" && budgets.warm > 0 && Number.isInteger(budgets.warm)
      ? budgets.warm
      : DEFAULT_KNOWLEDGE_BUDGETS.warm;

    return { hot, warm };
  } catch {
    return { ...DEFAULT_KNOWLEDGE_BUDGETS };
  }
}

// ---------------------------------------------------------------------------
// Helper: serialize meta as YAML for character counting
// ---------------------------------------------------------------------------

function serializeMetaAsYaml(meta: ParsedKnowledgeFile["entries"][number]["meta"]): string {
  const lines: string[] = [];
  lines.push(`id: ${meta.id}`);
  lines.push(`layer: ${meta.layer}`);
  lines.push(`created: ${meta.created}`);
  if (meta.lastConfirmedAt !== undefined) {
    lines.push(`lastConfirmedAt: ${meta.lastConfirmedAt ?? "null"}`);
  }
  if (meta.confirmations !== undefined) {
    lines.push(`confirmations: ${meta.confirmations}`);
  }
  if (meta.expiresAt !== undefined) {
    lines.push(`expiresAt: ${meta.expiresAt ?? "null"}`);
  }
  if (meta.supersedes !== undefined) {
    lines.push(`supersedes: [${meta.supersedes.join(", ")}]`);
  }
  if (meta.promotedTo !== undefined) {
    lines.push(`promotedTo: ${meta.promotedTo ?? "null"}`);
  }
  lines.push(`status: ${meta.status}`);
  return lines.join("\n") + "\n";
}
