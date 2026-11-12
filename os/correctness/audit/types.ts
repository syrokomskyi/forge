/*
<MODULE_CONTRACT>
<purpose>RFC-1579: contracts of `correctness.audit` — check ids, rule ids,
findings, attribution, and the command result.</purpose>
<non-goals>
  <item>No logic — types and constants only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1579: initial audit contracts.</item>
  <item>RFC-1579: correctness.audit auditors and differential attribution

Add os/correctness/audit: tree snapshots (working tree, index, base via one cat-file batch with git-grep prefilter), literal scanner + SQL classifier, wrangler D1 schema builder on node:sqlite, the four auditors (sql.schema.conform, ledger.orphans, state.transitions.coverage, bindings.verify.substance), subject-keyed differential attribution with allow-list, survival ledger, the correctness.audit handler and registration, and bindings.paths.correctnessLedger.</item>
</CHANGE_SUMMARY>
*/

export type AuditCheckId =
  | "sql.schema.conform"
  | "ledger.orphans"
  | "state.transitions.coverage"
  | "bindings.verify.substance";

export type AuditRuleId = "CORR-AUDIT-01" | "CORR-AUDIT-02" | "CORR-AUDIT-03" | "CORR-AUDIT-04";

export const AUDIT_RULE_OF: Record<AuditCheckId, AuditRuleId> = {
  "sql.schema.conform": "CORR-AUDIT-01",
  "ledger.orphans": "CORR-AUDIT-02",
  "state.transitions.coverage": "CORR-AUDIT-03",
  "bindings.verify.substance": "CORR-AUDIT-04",
};

export const AUDIT_CHECK_IDS: readonly AuditCheckId[] = [
  "sql.schema.conform",
  "ledger.orphans",
  "state.transitions.coverage",
  "bindings.verify.substance",
];

/** Code auditors are differential; the configuration auditor always blocks when present. */
export const CODE_CHECKS: ReadonlySet<AuditCheckId> = new Set([
  "sql.schema.conform",
  "ledger.orphans",
  "state.transitions.coverage",
]);

export type AuditSeverity = "error" | "warning" | "info";
export type AuditAttribution = "introduced" | "legacy" | "resolved" | "accepted";

/** One auditor result before attribution. */
export interface RawFinding {
  check: AuditCheckId;
  subject: string;
  severity: AuditSeverity;
  message: string;
  location?: { file: string; line: number };
}

export interface AuditFinding {
  rule: AuditRuleId;
  check: AuditCheckId;
  key: string;
  subject: string;
  occurrences: number;
  severity: AuditSeverity;
  attribution: AuditAttribution;
  location?: { file: string; line: number };
  message: string;
}

/** One auditor pass over a snapshot. */
export interface AuditorOutput {
  findings: RawFinding[];
  unverifiable: number;
  skipped: string[];
}

export interface AuditResult {
  command: "correctness.audit";
  base: string;
  status: "pass" | "fail";
  findings: AuditFinding[];
  unverifiable: number;
  skipped: string[];
  ledger?: { path: string; written: boolean; rows: number };
}

export interface AllowEntry {
  check: string;
  subject: string;
  reason: string;
}
