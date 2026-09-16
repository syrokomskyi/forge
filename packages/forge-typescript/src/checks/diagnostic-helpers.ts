/*
<MODULE_CONTRACT>
<purpose>Shared diagnostic helpers for TypeScript validators — eliminates duplication across ts.*.validate commands (RFC-0889).</purpose>


<non-goals>
  <item>Do not define validator-specific logic — only shared helpers.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial shared diagnostic helpers extracted from validators.</item>
  <item>RFC-1097: step 6 — compass.migrate codemod run

Mechanical v1 to v2 header migration across the workspace: 942 files rewritten — CHANGE_SUMMARY windows collapsed into history, forbidden v1 blocks stripped, KEY_DECISIONS seeded from @ai-invariant comments (5 files) or TODO placeholders (103 files), blocks reordered to canonical order.</item>
  <item>RFC-1097: sweep — werkstatt-engine clean

Sweep batch 4: 73 Compass headers on headerless engine files (certification, component-runtime, isolation, evolution, testing), real KEY_DECISIONS on 75 files (kernel, cache, dht, swim, gitmesh, runtime), ~80 purpose expansions (CONTRACT-02/PURPOSE-02), non-goals on 13 CONTRACT-03 files, CS-07 history literal fix repo-wide (253 files). Policy: .template.ts/.template.astro excludedPaths. werkstatt-engine now 0 diagnostics.</item>
</CHANGE_SUMMARY>
*/

import type { Diagnostic } from "@warpgogol/werkstatt-engine/kernel/types";

export function makeDiagnostic(
  ruleId: string,
  severity: "error" | "warning" | "info",
  message: string,
  file?: string,
  line?: number,
): Diagnostic {
  return { ruleId, severity, message, ...(file ? { file } : {}), ...(line ? { line } : {}) };
}

export function emptySummary(): { error: number; warning: number; info: number } {
  return { error: 0, warning: 0, info: 0 };
}

export function buildSummary(diagnostics: Diagnostic[]): { error: number; warning: number; info: number } {
  const summary = emptySummary();
  for (const d of diagnostics) {
    summary[d.severity]++;
  }
  return summary;
}
