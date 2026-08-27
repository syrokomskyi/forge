/*
<MODULE_CONTRACT>
<purpose>Shared diagnostic helpers for TypeScript validators — eliminates duplication across ts.*.validate commands (RFC-0889).</purpose>
<keywords>diagnostic, helpers, shared, validators</keywords>
<responsibilities>
  <item>Provides makeDiagnostic factory for consistent Diagnostic construction.</item>
  <item>Provides emptySummary and buildSummary for CheckResult summary computation.</item>
</responsibilities>
<non-goals>
  <item>Do not define validator-specific logic — only shared helpers.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0889: initial shared diagnostic helpers extracted from validators.</item>
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
