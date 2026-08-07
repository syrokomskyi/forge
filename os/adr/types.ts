/*
<MODULE_CONTRACT>
<purpose>
Defines types and constants for managing Architectural Decision Records (ADRs):
statuses, scopes, frontmatter shape, validation results, and list output.
</purpose>
<non-goals>
  <item>Do not implement ADR processing or validation logic here.</item>
  <item>Do not handle user input or command execution related to ADRs.</item>
  <item>Do not manage the storage or retrieval of ADR documents.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0366: introduce ADR types and constants mirroring the RFC domain contract.</item>
  <item>RFC-0367: extend AdrStatus with reviewing and implemented; add implementedAt, closedAt, reviewers fields.</item>
  <item>Post-refactor hardening: document that an ADR may be superseded by a broader RFC.</item>
  <item>RFC-0521: migrated from packages/os/site-kernel/src/adr/ to packages/forge/os/adr/.</item>
  <item>RFC-0727: add AdrImplementStamp types for atomic ADR status transition.</item>
</CHANGE_SUMMARY>
*/

export type AdrStatus =
  "proposed" | "reviewing" | "accepted" | "implemented" | "superseded" | "rejected";

export const ADR_STATUSES: readonly AdrStatus[] = [
  "proposed",
  "reviewing",
  "accepted",
  "implemented",
  "superseded",
  "rejected",
] as const;

export type AdrScope = "package" | "app" | "workspace";

export const ADR_SCOPES: readonly AdrScope[] = ["package", "app", "workspace"] as const;

export interface AdrFrontmatter {
  id: string;
  title: string;
  status: AdrStatus;
  scope: AdrScope;
  decider: string;
  createdAt: string;
  updatedAt: string;
  supersedes?: string[];
  supersededBy?: string;
  related?: string[];
  implementedAt?: string;
  closedAt?: string;
  reviewers?: string[];
}

export interface AdrListEntry {
  id: string;
  title: string;
  status: AdrStatus;
  scope: AdrScope;
  decider: string;
  updatedAt: string;
  file: string;
}

export interface AdrListResult {
  command: "adr.list";
  status: "ok";
  count: number;
  entries: AdrListEntry[];
}

export interface AdrValidationViolation {
  adrId: string;
  file: string;
  rule: string;
  message: string;
  severity: "error" | "warning";
}

export interface AdrValidationResult {
  command: "adr.validate";
  status: "pass" | "fail";
  count: number;
  violations: AdrValidationViolation[];
}

export interface AdrCreateResult {
  command: "adr.create";
  status: "ok";
  file: string;
  id: string;
}

export const ADR_DIR = "docs/adrs";
export const ADR_TEMPLATE_FILE = "docs/adrs/adr-0000-template.md";
export const ADR_ID_PATTERN = /^ADR-\d{4}$/;

export const ADR_REQUIRED_SECTIONS = [
  "Context",
  "Decision",
  "Justification",
  "Consequences",
  "Evolution",
] as const;

export const ADR_KNOWN_KEYS: readonly string[] = [
  "id",
  "title",
  "status",
  "scope",
  "decider",
  "createdAt",
  "updatedAt",
  "supersedes",
  "supersededBy",
  "related",
  "implementedAt",
  "closedAt",
  "reviewers",
] as const;

// ─── RFC-0727: adr.implement.stamp types ─────────────────────────────────────

export type AdrImplementStampRule = "ADR-IMP-01" | "ADR-IMP-03" | "ADR-IMP-04" | "ADR-IMP-05";

export interface AdrImplementStampData {
  adrId: string;
  implementationCommit: string;
  stampedAt: string;
}

export interface AdrImplementStampViolation {
  rule: AdrImplementStampRule;
  message: string;
}

export interface AdrImplementStampResult {
  command: "adr.implement.stamp";
  status: "pass" | "fail";
  data?: AdrImplementStampData;
  violations: AdrImplementStampViolation[];
}
